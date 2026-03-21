// ═══════════════════════════════════════════════════════════════
//  SEQ-UI — sequencer list / overview / editor rendering
// ═══════════════════════════════════════════════════════════════
//
//  Circular imports with sequencer.js (stopSequencer/playSequence)
//  and persistence.js (queueAutosave) are intentional and safe
//  because all cross-module calls happen inside function bodies,
//  never at module initialisation time.
// ═══════════════════════════════════════════════════════════════

import {
  data, rt, ui,
  getSeq, getPad, makeStep,
  getEffectiveStepCrossfade,
  escHtml,
  sliderToSec, sliderToDurationSec, durationSecToSlider,
  formatDurationClock,
} from './state.js';
import { setSequencerPanelOpen, setSequenceEditorOpen, syncSeqDefaultCrossfadeUI } from './resize.js';
import { hydratePadDuration, getPadDurationSec } from './audio.js';
import { queueAutosave } from './persistence.js';
import { stopSequencer, playSequence } from './sequencer.js';

// ── Sequence list ─────────────────────────────────────────────

export function renderSeqList() {
  const ul = document.getElementById('seq-list');
  ul.innerHTML = '';
  data.sequences.forEach(seq => {
    const isPlaying = rt.seqState === 'playing' && rt.seqId === seq.id;
    const isEditing = ui.seqEditorOpen && ui.currentSeqId === seq.id;
    const li = document.createElement('li');
    li.className = 'seq-list-item' + (seq.id === ui.currentSeqId ? ' active' : '');
    li.dataset.seqId = seq.id;
    li.innerHTML = `
      <div class="seq-list-main">
        <span class="seq-list-name">${escHtml(seq.name || 'Unnamed')}</span>
        <span class="seq-list-meta">${seq.steps.length} step${seq.steps.length === 1 ? '' : 's'}</span>
      </div>
      <div class="seq-list-actions">
        <button class="seq-row-btn ${isPlaying ? 'playing' : ''}" data-seq-action="toggle-play">Play</button>
        <button class="seq-row-btn ${isEditing ? 'editing' : ''}" data-seq-action="edit">Edit</button>
      </div>
    `;
    li.addEventListener('click', e => {
      const actionBtn = e.target.closest('[data-seq-action]');
      if (!actionBtn) {
        selectSequence(seq.id, { openEditor: ui.seqEditorOpen });
        return;
      }

      const action = actionBtn.dataset.seqAction;
      if (action === 'toggle-play') {
        selectSequence(seq.id, { openEditor: ui.seqEditorOpen && ui.currentSeqId === seq.id });
        if (rt.seqState === 'playing' && rt.seqId === seq.id) {
          stopSequencer();
        } else {
          playSequence(seq.id);
        }
        return;
      }

      if (action === 'edit') {
        if (ui.seqEditorOpen && ui.currentSeqId === seq.id) {
          setSequenceEditorOpen(false);
          renderSeqList();
          queueAutosave();
        } else {
          openSeqEditor(seq.id);
        }
      }
    });
    ul.appendChild(li);
  });
}

// ── Sequence overview ─────────────────────────────────────────

export function renderSeqOverview() {
  const nameEl  = document.getElementById('seq-current-name');
  const metaEl  = document.getElementById('seq-current-meta');
  const openBtn = document.getElementById('btn-seq-open-editor');
  const seq     = getSeq(ui.currentSeqId);

  if (!seq) {
    if (nameEl)  nameEl.textContent = 'No sequence selected';
    if (metaEl)  metaEl.textContent = 'Select a sequence to play, then open the editor only when you need step changes.';
    if (openBtn) openBtn.disabled = true;
    return;
  }

  if (nameEl) nameEl.textContent = seq.name || 'Unnamed sequence';
  if (metaEl) {
    const defaultCf = Math.max(0, seq.defaultCrossfade || 0).toFixed(1);
    metaEl.textContent = `${seq.steps.length} step${seq.steps.length === 1 ? '' : 's'} • Default crossfade ${defaultCf} s`;
  }
  if (openBtn) openBtn.disabled = false;
}

// ── Sequence selection ────────────────────────────────────────

export function selectSequence(seqId, options = {}) {
  const seq = getSeq(seqId);
  ui.currentSeqId = seq ? seq.id : null;
  const shouldOpenEditor = !!options.openEditor;
  setSequenceEditorOpen(shouldOpenEditor);

  if (seq && shouldOpenEditor) {
    document.getElementById('seq-name-input').value = seq.name;
    syncSeqDefaultCrossfadeUI(seq);
    renderSeqSteps();
  }

  if (!seq || !shouldOpenEditor) {
    const stepsEl = document.getElementById('seq-steps');
    if (stepsEl) stepsEl.innerHTML = '';
  }

  renderSeqList();
  renderSeqOverview();
  updateSeqTransportUI();
  queueAutosave();
}

// ── Sequence editor open ──────────────────────────────────────

export function openSeqEditor(seqId) {
  setSequencerPanelOpen(true);
  selectSequence(seqId, { openEditor: true });
}

// ── Insert pad into sequence ──────────────────────────────────

export function insertPadIntoSequence(sequenceId, padId, dropTarget = null) {
  const seq = getSeq(sequenceId);
  if (!seq || !getPad(padId)) return;

  let insertIndex = seq.steps.length;
  if (dropTarget?.type === 'sequence-step' && dropTarget.stepId) {
    const targetIndex = seq.steps.findIndex(step => step.id === dropTarget.stepId);
    if (targetIndex >= 0) {
      insertIndex = targetIndex + (dropTarget.position === 'after' ? 1 : 0);
    }
  }

  seq.steps.splice(insertIndex, 0, makeStep({ padId, duration: null, crossfadeNext: null }));
  if (ui.currentSeqId === sequenceId) {
    renderSeqSteps();
    updateSeqTransportUI();
  }
  renderSeqList();
  renderSeqOverview();
  queueAutosave();
}

// ── Sequencer step list rendering ─────────────────────────────

export function renderSeqSteps() {
  const seq = getSeq(ui.currentSeqId);
  const ul  = document.getElementById('seq-steps');
  ul.innerHTML = '';
  if (!seq) return;

  let stepDrag = null;

  const clearStepDragClasses = () => {
    ul.querySelectorAll('.seq-step-row').forEach(row => {
      row.classList.remove('dragging', 'drop-before', 'drop-after');
    });
  };

  const dropMarker = document.createElement('div');
  dropMarker.id = 'seq-step-drop-marker';
  dropMarker.className = 'seq-step-drop-marker';
  dropMarker.hidden = true;

  seq.steps.forEach((step, idx) => {
    const pad = getPad(step.padId);
    const li  = document.createElement('li');
    li.className = 'seq-step-row' + (idx === rt.seqStep && rt.seqId === ui.currentSeqId ? ' playing-step' : '');
    li.dataset.stepId = step.id;

    const colorDot  = pad ? `<span class="step-color-dot" style="background:${pad.color}"></span>` : '';
    const soundName = pad ? escHtml(pad.label) : '<em>Unknown</em>';
    const soundDur  = pad ? (formatDurationClock(rt.padDurSec[pad.id]) || '--.---') : '';
    const durVal    = step.duration != null ? step.duration : '';
    const hasOverride = step.crossfadeNext != null;
    const cfVal     = hasOverride ? step.crossfadeNext : '';
    const effectiveCf = getEffectiveStepCrossfade(step, seq);

    li.innerHTML = `
      <span class="step-num-cell"><span class="step-drag-handle" aria-hidden="true">⋮⋮</span><span>${idx + 1}</span></span>
      <span class="step-sound-cell">${colorDot}<span class="step-sound-name">${soundName}</span><span class="step-sound-duration">${soundDur}</span></span>
      <div class="step-dur-cell">
        <span class="step-field-label">Duration</span>
        <div class="step-slider-value step-dur-value">${durVal ? `${durVal.toFixed(1)} s` : 'Full'}</div>
        <input type="range" class="step-range-slider step-dur-input"
            min="0" max="600" step="1"
            value="${durationSecToSlider(durVal)}" title="Duration in seconds (0 = full length)" />
      </div>
      <div class="step-cf-cell">
        <span class="step-field-label">Crossfade</span>
        <div class="step-slider-value step-cf-value">${hasOverride ? `${cfVal.toFixed(1)} s` : 'Default'}</div>
        <input type="range" class="step-range-slider step-cf-input"
          min="0" max="200" step="1"
          value="${hasOverride ? Math.round(Math.min(20, cfVal) * 10) : 0}" title="Crossfade duration in seconds (0 = sequence default)" />
        <span class="step-cf-mode">${hasOverride ? 'Override' : `Default ${effectiveCf.toFixed(1)} s`}</span>
      </div>
      <button class="step-del-btn" title="Remove step" aria-label="Remove step">&#215;</button>
    `;

    // ── Step drag-to-reorder ──────────────────────────────────
    li.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('input, button, select, textarea')) return;
      if (!e.target.closest('.step-drag-handle')) return;

      stepDrag = {
        pointerId:    e.pointerId,
        sourceStepId: step.id,
        sourceEl:     li,
        startX:       e.clientX,
        startY:       e.clientY,
        started:      false,
        targetStepId: null,
        position:     'after',
      };
      li.setPointerCapture(e.pointerId);
    });

    li.addEventListener('pointermove', e => {
      if (!stepDrag || stepDrag.pointerId !== e.pointerId || stepDrag.sourceStepId !== step.id) return;

      if (!stepDrag.started) {
        const dist = Math.hypot(e.clientX - stepDrag.startX, e.clientY - stepDrag.startY);
        if (dist < 4) return;
        stepDrag.started = true;
        li.classList.add('dragging');
      }

      clearStepDragClasses();
      li.classList.add('dragging');

      const hitRow = document.elementFromPoint(e.clientX, e.clientY)?.closest('.seq-step-row');
      if (!hitRow || hitRow.dataset.stepId === stepDrag.sourceStepId) {
        stepDrag.targetStepId = null;
        return;
      }

      const rect   = hitRow.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      stepDrag.targetStepId = hitRow.dataset.stepId;
      stepDrag.position     = before ? 'before' : 'after';
      hitRow.classList.add(before ? 'drop-before' : 'drop-after');
    });

    const finishStepDrag = e => {
      if (!stepDrag || stepDrag.pointerId !== e.pointerId || stepDrag.sourceStepId !== step.id) return;

      const drag = stepDrag;
      stepDrag   = null;

      clearStepDragClasses();

      if (!drag.started || !drag.targetStepId) {
        try { li.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        return;
      }

      const fromIndex   = seq.steps.findIndex(s => s.id === drag.sourceStepId);
      const targetIndex = seq.steps.findIndex(s => s.id === drag.targetStepId);
      if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
        try { li.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        return;
      }

      const [moved] = seq.steps.splice(fromIndex, 1);
      let insertIndex = targetIndex + (drag.position === 'after' ? 1 : 0);
      if (fromIndex < targetIndex) insertIndex -= 1;
      seq.steps.splice(Math.max(0, Math.min(seq.steps.length, insertIndex)), 0, moved);

      try { li.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }

      renderSeqSteps();
      renderSeqList();
      queueAutosave();
    };

    li.addEventListener('pointerup',     finishStepDrag);
    li.addEventListener('pointercancel', finishStepDrag);
    li.addEventListener('lostpointercapture', e => {
      if (!stepDrag || stepDrag.pointerId !== e.pointerId || stepDrag.sourceStepId !== step.id) return;
      stepDrag = null;
      clearStepDragClasses();
    });

    // ── Step field inputs ─────────────────────────────────────
    li.querySelector('.step-dur-input').addEventListener('input', e => {
      step.duration = sliderToDurationSec(+e.target.value);
      const label   = li.querySelector('.step-dur-value');
      if (label) label.textContent = step.duration != null ? `${step.duration.toFixed(1)} s` : 'Full';
      queueAutosave();
    });

    li.querySelector('.step-cf-input').addEventListener('input', e => {
      const raw = Number(e.target.value);
      step.crossfadeNext = raw > 0 ? sliderToSec(raw) : null;
      const valLabel  = li.querySelector('.step-cf-value');
      const modeLabel = li.querySelector('.step-cf-mode');
      if (valLabel) valLabel.textContent = step.crossfadeNext != null ? `${step.crossfadeNext.toFixed(1)} s` : 'Default';
      if (modeLabel) {
        const activeSeq  = getSeq(ui.currentSeqId);
        const effective  = activeSeq ? getEffectiveStepCrossfade(step, activeSeq) : 0;
        modeLabel.textContent = step.crossfadeNext != null ? 'Override' : `Default ${effective.toFixed(1)} s`;
      }
      queueAutosave();
    });

    li.querySelector('.step-del-btn').addEventListener('click', () => {
      seq.steps.splice(idx, 1);
      renderSeqSteps();
      renderSeqList();
      renderSeqOverview();
      queueAutosave();
    });

    ul.appendChild(li);

    if (pad && !Number.isFinite(rt.padDurSec[pad.id])) {
      hydratePadDuration(pad.id).then(() => {
        if (ui.currentSeqId === seq.id) renderSeqSteps();
      });
    }
  });

  ul.appendChild(dropMarker);
}

// ── Transport UI helpers ──────────────────────────────────────

export function updateSeqStepHighlight() {
  document.querySelectorAll('.seq-step-row').forEach((row, i) => {
    row.classList.toggle('playing-step',
      rt.seqState === 'playing' && rt.seqId === ui.currentSeqId && i === rt.seqStep);
  });
}

export function updateSeqTransportUI() {
  const hasSelection = !!ui.currentSeqId;
  const playing  = rt.seqState === 'playing' && rt.seqId === ui.currentSeqId;
  const playBtn  = document.getElementById('btn-seq-play');
  const stopBtn  = document.getElementById('btn-seq-stop');
  const nextBtn  = document.getElementById('btn-seq-next');
  if (playBtn) playBtn.disabled = !hasSelection || playing;
  if (stopBtn) stopBtn.disabled = !playing;
  if (nextBtn) nextBtn.disabled = !playing;
  renderSeqList();
}
