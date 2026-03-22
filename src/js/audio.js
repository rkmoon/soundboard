// ═══════════════════════════════════════════════════════════════
//  AUDIO — Howler management, playback, and pad duration helpers
// ═══════════════════════════════════════════════════════════════
//
//  Note: Howl and Howler are globals provided by lib/howler.min.js
//  loaded via a <script> tag in index.html.
//
//  Note: updatePadDurationInCard, setPadLoading, updatePadUI, and
//  refreshPadStatus are imported from pad-ui.js. ES modules handle
//  the circular dependency at runtime since all uses are inside
//  function bodies, not at module initialisation time.
// ═══════════════════════════════════════════════════════════════

import { rt, getPad, invoke } from './state.js';
import {
  updatePadDurationInCard,
  setPadLoading,
  updatePadUI,
} from './pad-ui.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getPadClipBounds(pad, totalDurationSec) {
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    return { startSec: 0, endSec: 0, playSec: 0 };
  }

  const minPlayableSec = Math.min(0.05, totalDurationSec);
  let startSec = clamp(Number(pad?.trimStart) || 0, 0, totalDurationSec);
  let endTrimSec = clamp(Number(pad?.trimEnd) || 0, 0, totalDurationSec);
  let endSec = totalDurationSec - endTrimSec;

  if (endSec - startSec < minPlayableSec) {
    if (startSec > totalDurationSec - minPlayableSec) {
      startSec = Math.max(0, totalDurationSec - minPlayableSec);
      endSec = totalDurationSec;
    } else {
      endSec = startSec + minPlayableSec;
    }
  }

  return {
    startSec,
    endSec,
    playSec: Math.max(minPlayableSec, endSec - startSec),
  };
}

export function getEffectivePadVolume(pad) {
  const base = getPadBaseVolume(pad);
  if (base <= 0) return 0;

  const gainDb = Number.isFinite(pad?.gainDb) ? pad.gainDb : 0;
  const baseDb = 20 * Math.log10(base);
  const effectiveDb = baseDb + gainDb;
  const effective = Math.pow(10, effectiveDb / 20);

  return clamp(effective, 0, 1);
}

export function getPadBaseVolume(pad) {
  const base = Number.isFinite(pad?.volume) ? pad.volume : 0.8;
  return Math.max(0, Math.min(1, base));
}

export function getPadGainMultiplier(pad) {
  const gainDb = Number.isFinite(pad?.gainDb) ? pad.gainDb : 0;
  return Math.max(0, Math.pow(10, gainDb / 20));
}

function ensureSoundOutputGain(howl, soundId) {
  if (typeof Howler === 'undefined' || !Howler.usingWebAudio || !Howler.ctx || !Howler.masterGain) {
    return null;
  }
  if (!howl || typeof howl._soundById !== 'function') return null;

  const sound = howl._soundById(soundId);
  const sourceGain = sound?._node;
  if (!sound || !sourceGain || !sourceGain.gain) return null;

  if (sound._outputGainSource !== sourceGain || !sound._outputGainNode) {
    try { sourceGain.disconnect(); } catch (_) { /* ignore */ }
    try { sound._outputGainNode?.disconnect(); } catch (_) { /* ignore */ }

    const outputGain = Howler.ctx.createGain();
    outputGain.gain.setValueAtTime(1, Howler.ctx.currentTime);
    sourceGain.connect(outputGain);
    outputGain.connect(Howler.masterGain);

    sound._outputGainNode = outputGain;
    sound._outputGainSource = sourceGain;
  }

  return sound._outputGainNode;
}

export function cleanupHowlOutputGainNodes(howl) {
  if (!howl?._sounds) return;
  howl._sounds.forEach(sound => {
    try { sound?._outputGainNode?.disconnect(); } catch (_) { /* ignore */ }
    if (sound) {
      delete sound._outputGainNode;
      delete sound._outputGainSource;
    }
  });
}

export function applyPadOutputGain(howl, soundId, pad) {
  const gainMul = getPadGainMultiplier(pad);
  const outputGain = ensureSoundOutputGain(howl, soundId);
  if (outputGain && typeof Howler !== 'undefined' && Howler.ctx) {
    outputGain.gain.cancelScheduledValues(Howler.ctx.currentTime);
    outputGain.gain.setValueAtTime(gainMul, Howler.ctx.currentTime);
    return;
  }

  howl.volume(getEffectivePadVolume(pad), soundId);
}

// ── Howler management ─────────────────────────────────────────

export async function ensureHowl(pad) {
  if (rt.howls[pad.id]) return rt.howls[pad.id];
  if (!pad.filePath) return null;

  setPadLoading(pad.id, true);
  let dataUrl;
  try {
    dataUrl = await invoke('read_audio_dataurl', { path: pad.filePath });
  } catch (e) {
    console.error('Failed to load audio:', e);
    setPadLoading(pad.id, false);
    return null;
  }

  return new Promise(resolve => {
    const howl = new Howl({  // eslint-disable-line no-undef
      src: [dataUrl],
      loop: pad.loop,
      preload: true,
      onload() {
        setPadLoading(pad.id, false);
        rt.howls[pad.id]      = howl;
        rt.padDurSec[pad.id]  = howl.duration();
        updatePadDurationInCard(pad.id);
        resolve(howl);
      },
      onloaderror(_, msg) {
        console.error('Howler load error:', msg);
        setPadLoading(pad.id, false);
        resolve(null);
      },
    });
  });
}

/** Tear down the Howl for a pad (call when pad settings change). */
export function invalidateHowl(padId) {
  stopPad(padId);
  if (rt.howls[padId]) {
    cleanupHowlOutputGainNodes(rt.howls[padId]);
    rt.howls[padId].unload();
    delete rt.howls[padId];
  }
  delete rt.padDurSec[padId];
  updatePadDurationInCard(padId);
}

// ── Playback ──────────────────────────────────────────────────

export async function playPad(padId) {
  if (rt.loudnessRecalcInProgress) return;

  const pad = getPad(padId);
  if (!pad || !pad.filePath) return;

  if (rt.active[padId]) {
    if (pad.retrigger) {
      stopPad(padId, 120);
    } else {
      stopPad(padId);
      return;
    }
  }

  const howl = await ensureHowl(pad);
  if (!howl) return;

  Howler.volume(rt.master);  // eslint-disable-line no-undef

  const totalDur = howl.duration();
  const clip = getPadClipBounds(pad, totalDur);
  const targetVol = getPadBaseVolume(pad);
  const timers = [];
  rt.active[padId] = { soundId: null, timers };

  const startIteration = (isFirstIteration) => {
    const soundId = howl.play();
    rt.active[padId].soundId = soundId;
    howl.loop(false, soundId);

    const startVol = (pad.fadeIn > 0 && isFirstIteration) ? 0 : targetVol;
    howl.volume(startVol, soundId);
    applyPadOutputGain(howl, soundId, pad);
    const playbackSpeed = Number.isFinite(pad.playbackSpeed) ? pad.playbackSpeed : 1.0;
    howl.rate(playbackSpeed, soundId);
    if (clip.startSec > 0) {
      howl.seek(clip.startSec, soundId);
    }

    if (pad.fadeIn > 0 && isFirstIteration) {
      howl.fade(0, targetVol, pad.fadeIn * 1000, soundId);
    }

    if (pad.fadeOut > 0 && !pad.loop && clip.playSec > pad.fadeOut) {
      const delay = (clip.playSec - pad.fadeOut) / playbackSpeed * 1000;
      const fadeTimer = setTimeout(() => {
        if (rt.active[padId]?.soundId === soundId && howl.playing(soundId)) {
          howl.fade(targetVol, 0, pad.fadeOut * 1000, soundId);
        }
      }, delay);
      timers.push(fadeTimer);
    }

    const stopTimer = setTimeout(() => {
      if (rt.active[padId]?.soundId !== soundId) return;
      if (howl.playing(soundId)) howl.stop(soundId);

      if (pad.loop && rt.active[padId]) {
        startIteration(false);
        return;
      }

      clearPadActive(padId);
      updatePadUI(padId);
    }, clip.playSec / playbackSpeed * 1000);
    timers.push(stopTimer);
  };

  startIteration(true);
  updatePadUI(padId);
}

export function stopPad(padId, fadeMs = 0) {
  const entry = rt.active[padId];
  if (!entry) return;
  const { soundId, timers } = entry;
  timers.forEach(t => clearTimeout(t));
  const howl = rt.howls[padId];
  if (howl) {
    if (fadeMs > 0) {
      const vol = howl.volume(soundId);
      howl.fade(vol, 0, fadeMs, soundId);
      const t = setTimeout(() => {
        if (howl) howl.stop(soundId);
      }, fadeMs);
      timers.push(t);
    } else {
      howl.stop(soundId);
    }
  }
  clearPadActive(padId);
  updatePadUI(padId);
}

export function clearPadActive(padId) {
  const entry = rt.active[padId];
  if (entry) entry.timers.forEach(t => clearTimeout(t));
  delete rt.active[padId];
}

// ── Duration helpers ──────────────────────────────────────────

export async function getPadDurationSec(pad) {
  if (!pad?.filePath) return null;
  const howl = rt.howls[pad.id] || await ensureHowl(pad);
  const dur  = howl?.duration();
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

export async function hydratePadDuration(padId) {
  const pad = getPad(padId);
  if (!pad?.filePath) {
    updatePadDurationInCard(padId);
    return;
  }
  if (Number.isFinite(rt.padDurSec[padId])) {
    updatePadDurationInCard(padId);
    return;
  }
  const howl = await ensureHowl(pad);
  if (!howl) return;
  rt.padDurSec[padId] = howl.duration();
  updatePadDurationInCard(padId);
}

// ── Progress RAF loop ─────────────────────────────────────────

export function startProgressLoop() {
  if (rt.progressRaf) return;
  function loop() {
    for (const [padId, entry] of Object.entries(rt.active)) {
      const howl = rt.howls[padId];
      const pad  = getPad(padId);
      if (!howl || !pad || !howl.playing(entry.soundId)) continue;
      const seek = howl.seek(entry.soundId);
      const totalDur = howl.duration(entry.soundId) || howl.duration();
      if (!totalDur) continue;
      const clip = getPadClipBounds(pad, totalDur);
      if (!clip.playSec) continue;
      const pct = Math.min(100, Math.max(0, ((seek - clip.startSec) / clip.playSec) * 100));
      const el  = document.querySelector(`.pad-card[data-pad-id="${padId}"] .pad-progress`);
      if (el) el.style.width = pct + '%';
    }
    rt.progressRaf = requestAnimationFrame(loop);
  }
  rt.progressRaf = requestAnimationFrame(loop);
}
