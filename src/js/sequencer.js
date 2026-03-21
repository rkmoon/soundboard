// ═══════════════════════════════════════════════════════════════
//  SEQUENCER — transport engine (play / advance / stop)
// ═══════════════════════════════════════════════════════════════

import { rt, getSeq, getPad, getEffectiveStepCrossfade } from './state.js';
import { ensureHowl, stopPad, clearPadActive, getPadClipBounds, getEffectivePadVolume } from './audio.js';
import {
  updateSeqStepHighlight,
  updateSeqTransportUI,
  renderSeqList,
  renderSeqOverview,
} from './seq-ui.js';

// ── Public transport commands ─────────────────────────────────

export async function playSequence(seqId) {
  stopSequencer();
  const seq = getSeq(seqId);
  if (!seq || seq.steps.length === 0) return;

  rt.seqState = 'playing';
  rt.seqId    = seqId;
  rt.seqStep  = -1;

  // Pre-load all pads used in this sequence
  for (const step of seq.steps) {
    const pad = getPad(step.padId);
    if (pad) await ensureHowl(pad);
  }

  await advanceSequencer(0, 0);
}

/**
 * Start playing step[stepIdx], fading it in over crossfadeInMs.
 * When the step is done (or should crossfade to next), calls itself recursively.
 */
export async function advanceSequencer(stepIdx, crossfadeInMs) {
  if (rt.seqState !== 'playing') return;
  const seq = getSeq(rt.seqId);
  if (!seq || stepIdx >= seq.steps.length) {
    finishSequencer();
    return;
  }

  rt.seqTimers.forEach(t => clearTimeout(t));
  rt.seqTimers = [];

  rt.seqStep = stepIdx;
  updateSeqStepHighlight();

  const step = seq.steps[stepIdx];
  const pad  = getPad(step.padId);
  if (!pad) {
    await advanceSequencer(stepIdx + 1, 0);
    return;
  }

  const howl = rt.howls[pad.id] || await ensureHowl(pad);
  if (!howl) {
    await advanceSequencer(stepIdx + 1, 0);
    return;
  }

  Howler.volume(rt.master);  // eslint-disable-line no-undef

  const targetVol = getEffectivePadVolume(pad);
  const fadeInMs = Math.max(crossfadeInMs, pad.fadeIn * 1000);
  howl.volume(fadeInMs > 0 ? 0 : targetVol);
  const soundId = howl.play();
  howl.loop(pad.loop, soundId);

  const totalDur = howl.duration(soundId) || howl.duration();
  const clip = getPadClipBounds(pad, totalDur);
  if (clip.startSec > 0) {
    howl.seek(clip.startSec, soundId);
  }

  if (fadeInMs > 0) {
    howl.fade(0, targetVol, fadeInMs, soundId);
  }

  const naturalDur  = clip.playSec;
  const stepDurSec  = (step.duration != null && step.duration > 0)
    ? Math.min(step.duration, naturalDur)
    : (!pad.loop ? naturalDur : null); // null = manual advance for loops with no duration

  const crossfadeOutMs  = getEffectiveStepCrossfade(step, seq) * 1000;
  const crossfadeOutSec = crossfadeOutMs / 1000;

  function scheduleTransition() {
    if (stepDurSec == null) return; // loop — wait for manual Next

    const transitionAt = Math.max(0, stepDurSec - crossfadeOutSec) * 1000;

    if (crossfadeOutMs === 0 && pad.fadeOut > 0 && stepDurSec > pad.fadeOut) {
      const foAt = (stepDurSec - pad.fadeOut) * 1000;
      rt.seqTimers.push(setTimeout(() => {
        if (howl.playing(soundId))
          howl.fade(targetVol, 0, pad.fadeOut * 1000, soundId);
      }, foAt));
    }

    // Trigger next step START at transition time (so it fades in while current fades out)
    rt.seqTimers.push(setTimeout(async () => {
      if (rt.seqState !== 'playing' || rt.seqStep !== stepIdx) return;
      
      // Start the next step with crossfade overlap
      await advanceSequencer(stepIdx + 1, crossfadeOutMs);

      // Schedule current sound fade-out AFTER next step has started
      if (crossfadeOutMs > 0 && howl.playing(soundId)) {
        howl.fade(targetVol, 0, crossfadeOutMs, soundId);
        rt.seqTimers.push(setTimeout(() => howl.stop(soundId), crossfadeOutMs));
      } else {
        if (howl.playing(soundId)) {
          howl.stop(soundId);
        }
      }
    }, transitionAt));
  }

  scheduleTransition();

  if (!pad.loop && crossfadeOutMs === 0) {
    howl.once('end', async (id) => {
      if (id !== soundId) return;
      if (rt.seqState !== 'playing' || rt.seqStep !== stepIdx) return;
      await advanceSequencer(stepIdx + 1, 0);
    });
  }

  rt.seqCurrentSoundId = soundId;
  rt.seqCurrentHowl    = howl;
}

export function forceNextStep() {
  if (rt.seqState !== 'playing') return;
  const seq    = getSeq(rt.seqId);
  const step   = seq?.steps[rt.seqStep];
  const fadeMs = (step && seq) ? getEffectiveStepCrossfade(step, seq) * 1000 : 0;

  if (rt.seqCurrentHowl && rt.seqCurrentSoundId !== undefined) {
    const h  = rt.seqCurrentHowl;
    const id = rt.seqCurrentSoundId;
    if (h.playing(id)) {
      const f = fadeMs > 0 ? fadeMs : 300;
      h.fade(h.volume(id), 0, f, id);
      setTimeout(() => h.stop(id), f);
    }
  }

  rt.seqTimers.forEach(t => clearTimeout(t));
  rt.seqTimers = [];
  advanceSequencer(rt.seqStep + 1, Math.min(fadeMs, 300));
}

export function stopSequencer() {
  rt.seqTimers.forEach(t => clearTimeout(t));
  rt.seqTimers = [];
  if (rt.seqCurrentHowl && rt.seqCurrentSoundId !== undefined) {
    rt.seqCurrentHowl.stop(rt.seqCurrentSoundId);
  }
  rt.seqCurrentHowl    = null;
  rt.seqCurrentSoundId = undefined;
  rt.seqState = 'idle';
  rt.seqId    = null;
  rt.seqStep  = -1;
  updateSeqStepHighlight();
  updateSeqTransportUI();
}

export function finishSequencer() {
  rt.seqState = 'idle';
  rt.seqStep  = -1;
  updateSeqStepHighlight();
  updateSeqTransportUI();
}

/** Stop all active pad playback and halt the sequencer. */
export function stopAll() {
  Object.keys(rt.active).forEach(id => stopPad(id));
  stopSequencer();
}
