// ═══════════════════════════════════════════════════════════════
//  PAD-UI — pad grid rendering, drag-to-reorder, and pad status
// ═══════════════════════════════════════════════════════════════
//
//  Circular imports:
//  • audio.js imports updatePadDurationInCard, setPadLoading,
//    updatePadUI from here, while we import playPad, hydratePadDuration
//    from audio.js.  Safe — all usage is inside function bodies.
//  • modals.js imports renderPadGrid / buildPadCard from here, while
//    we import openPadModal from modals.js.  Same reason — safe.
// ═══════════════════════════════════════════════════════════════

import {
  data, rt, ui,
  getPad,
  escHtml, sliderToVol, sliderToSec,
  formatDurationClock,
} from './state.js';
import { playPad, hydratePadDuration } from './audio.js';
import { insertPadIntoSequence } from './seq-ui.js';
import { openPadModal } from './modals.js';
import { queueAutosave } from './persistence.js';

// ── Grid rendering ────────────────────────────────────────────

export function renderPadGrid() {
  const grid   = document.getElementById('pad-grid');
  const addBtn = document.getElementById('btn-grid-add');
  let marker   = document.getElementById('pad-drop-marker');

  if (!marker) {
    marker           = document.createElement('div');
    marker.id        = 'pad-drop-marker';
    marker.className = 'pad-drop-marker';
    grid.appendChild(marker);
  }

  grid.querySelectorAll('.pad-card').forEach(el => el.remove());
  data.pads.forEach(pad => {
    const card = buildPadCard(pad);
    grid.insertBefore(card, addBtn);
  });

  grid.appendChild(marker);
}

// ── Drop indicator ────────────────────────────────────────────

export function clearPadDropIndicator() {
  const marker     = document.getElementById('pad-drop-marker');
  const zone       = document.getElementById('seq-drop-zone');
  const stepMarker = document.getElementById('seq-step-drop-marker');
  if (marker) {
    marker.hidden              = true;
    marker.style.transform     = '';
    marker.style.height        = '';
  }
  if (zone)       zone.classList.remove('active');
  if (stepMarker) {
    stepMarker.hidden   = true;
    stepMarker.style.top = '';
  }
  document.querySelectorAll('.seq-list-item.drop-target').forEach(el => el.classList.remove('drop-target'));
}

export function setPadDropIndicator(dropTarget) {
  clearPadDropIndicator();
  if (!dropTarget) return;

  if (dropTarget.type === 'sequence') {
    const zone = document.getElementById('seq-drop-zone');
    if (zone) zone.classList.add('active');
    return;
  }
  if (dropTarget.type === 'sequence-list') {
    const row = document.querySelector(`.seq-list-item[data-seq-id="${dropTarget.sequenceId}"]`);
    if (row) row.classList.add('drop-target');
    return;
  }
  if (dropTarget.type === 'sequence-step') {
    const list       = document.getElementById('seq-steps');
    const stepMarker = document.getElementById('seq-step-drop-marker');
    if (!list || !stepMarker) return;

    const listRect  = list.getBoundingClientRect();
    let markerTop   = 0;

    if (dropTarget.rowElement) {
      const rowRect = dropTarget.rowElement.getBoundingClientRect();
      markerTop = rowRect.top - listRect.top + list.scrollTop +
        (dropTarget.position === 'after' ? rowRect.height : 0);
    } else {
      markerTop = list.scrollHeight;
    }

    stepMarker.hidden    = false;
    stepMarker.style.top = `${Math.max(0, markerTop - 1)}px`;
    return;
  }

  const grid   = document.getElementById('pad-grid');
  const marker = document.getElementById('pad-drop-marker');
  if (!grid || !marker) return;

  const gridRect  = grid.getBoundingClientRect();
  const styles    = getComputedStyle(grid);
  const columnGap = parseFloat(styles.columnGap || styles.gap || '14') || 14;

  let targetRect  = null;
  let markerX     = 0;

  if (dropTarget.type === 'card' && dropTarget.element) {
    targetRect = dropTarget.element.getBoundingClientRect();
    markerX    = dropTarget.position === 'before'
      ? targetRect.left  - gridRect.left - (columnGap / 2)
      : targetRect.right - gridRect.left + (columnGap / 2);
  } else if (dropTarget.type === 'end') {
    const addBtn = document.getElementById('btn-grid-add');
    if (!addBtn) return;
    targetRect = addBtn.getBoundingClientRect();
    markerX    = targetRect.left - gridRect.left - (columnGap / 2);
  }

  if (!targetRect) return;

  const markerY      = targetRect.top - gridRect.top + 10;
  const markerHeight = Math.max(24, targetRect.height - 20);
  marker.hidden              = false;
  marker.style.transform     = `translate(${markerX}px, ${markerY}px)`;
  marker.style.height        = `${markerHeight}px`;
}

export function getPadDropTarget(clientX, clientY, sourceId) {
  const sourceEl         = document.querySelector(`.pad-card[data-pad-id="${sourceId}"]`);
  const hit              = document.elementFromPoint(clientX, clientY);
  const addBtn           = document.getElementById('btn-grid-add');
  const sequenceDropZone = document.getElementById('seq-drop-zone');
  const sequenceListRow  = hit?.closest('.seq-list-item');
  const stepRow          = hit?.closest('.seq-step-row');

  if (sequenceListRow?.dataset.seqId) {
    return { type: 'sequence-list', sequenceId: sequenceListRow.dataset.seqId };
  }

  if (ui.currentSeqId && stepRow) {
    const rowRect = stepRow.getBoundingClientRect();
    return {
      type:       'sequence-step',
      sequenceId: ui.currentSeqId,
      stepId:     stepRow.dataset.stepId,
      rowElement: stepRow,
      position:   clientY < rowRect.top + rowRect.height / 2 ? 'before' : 'after',
    };
  }

  if (ui.currentSeqId && sequenceDropZone && !sequenceDropZone.hidden) {
    const seqTarget = hit?.closest('#seq-drop-zone, #seq-steps, #seq-editor');
    if (seqTarget) {
      return { type: 'sequence', sequenceId: ui.currentSeqId };
    }
  }

  if (hit === addBtn || hit?.closest('#btn-grid-add')) {
    return { type: 'end' };
  }

  const targetCard = hit?.closest('.pad-card');
  if (targetCard && targetCard !== sourceEl) {
    const rect     = targetCard.getBoundingClientRect();
    let position;
    if (clientY >= rect.top && clientY <= rect.bottom) {
      position = clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    } else {
      position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    }
    return { type: 'card', element: targetCard, targetId: targetCard.dataset.padId, position };
  }

  return { type: 'end' };
}

// ── Drag ghost helpers ────────────────────────────────────────

function createPadDragGhost(sourceEl, clientX, clientY, startX, startY) {
  const rect  = sourceEl.getBoundingClientRect();
  const ghost = sourceEl.cloneNode(true);
  ghost.classList.add('pad-drag-ghost');
  ghost.classList.remove('playing', 'loading', 'drop-before', 'drop-after', 'drag-source');
  ghost.style.width     = `${rect.width}px`;
  ghost.style.height    = `${rect.height}px`;
  ghost.style.left      = '0px';
  ghost.style.top       = '0px';
  ghost.style.transform = `translate(${clientX - (startX - rect.left)}px, ${clientY - (startY - rect.top)}px)`;
  document.body.appendChild(ghost);
  return ghost;
}

function updatePadDragGhost(ghost, clientX, clientY, offsetX, offsetY) {
  if (!ghost) return;
  ghost.style.transform = `translate(${clientX - offsetX}px, ${clientY - offsetY}px)`;
}

function destroyPadDragGhost() {
  ui.padDrag?.ghost?.remove();
}

function applyPadDrop(sourceId, dropTarget) {
  const ids = data.pads.map(p => p.id).filter(id => id !== sourceId);
  let insertIndex = ids.length;

  if (dropTarget?.type === 'card') {
    const targetIndex = ids.indexOf(dropTarget.targetId);
    insertIndex = targetIndex + (dropTarget.position === 'after' ? 1 : 0);
  }

  ids.splice(insertIndex, 0, sourceId);
  const indexMap = new Map(ids.map((id, index) => [id, index]));
  data.pads.sort((a, b) => indexMap.get(a.id) - indexMap.get(b.id));
  queueAutosave();
}

// ── Duration card update (called by audio.js) ─────────────────

export function updatePadDurationInCard(padId) {
  const el = document.querySelector(`.pad-card[data-pad-id="${padId}"] .pad-play-duration`);
  if (!el) return;
  const sec = rt.padDurSec[padId];
  const txt = formatDurationClock(sec);
  el.textContent = txt || '\u00A0';
}

// ── Pad status DOM helpers (called by audio.js) ───────────────

export function updatePadUI(padId) {
  const card = document.querySelector(`.pad-card[data-pad-id="${padId}"]`);
  if (!card) return;
  const playing = !!rt.active[padId];
  card.classList.toggle('playing', playing);
  refreshPadStatus(card, padId);
  const progressEl = card.querySelector('.pad-play-body .pad-progress');
  if (progressEl && !playing) progressEl.style.width = '0%';
}

export function setPadLoading(padId, loading) {
  const card = document.querySelector(`.pad-card[data-pad-id="${padId}"]`);
  if (card) {
    card.classList.toggle('loading', loading);
    refreshPadStatus(card, padId);
  }
}

export function refreshPadStatus(card, padId) {
  const pad      = getPad(padId);
  const statusEl = card.querySelector('.pad-status');
  if (!statusEl || !pad) return;

  let statusText = 'Loaded';
  if (card.classList.contains('loading')) {
    statusText = 'Loading';
  } else if (!pad.filePath) {
    statusText = 'Missing File';
  } else if (rt.active[padId]) {
    statusText = 'Playing';
  }

  statusEl.textContent   = statusText;
  statusEl.dataset.state = statusText.toLowerCase().replace(/\s+/g, '-');
}

// ── Pad card builder ──────────────────────────────────────────

export function buildPadCard(pad) {
  const div = document.createElement('div');
  div.className   = 'pad-card';
  div.dataset.padId = pad.id;
  div.style.setProperty('--pad-color', pad.color);

  div.innerHTML = `
    <div class="pad-color-bar"></div>
    <div class="pad-header">
      <div class="pad-status"></div>
      <button class="pad-settings-btn" title="Edit sound">Settings</button>
    </div>
    <div class="pad-play-body" role="button" tabindex="0" aria-label="Play sound">
      <div class="pad-progress"></div>
      <span class="pad-play-text">
        <span class="pad-play-name">${escHtml(pad.label)}</span>
        <span class="pad-play-duration">${formatDurationClock(rt.padDurSec[pad.id]) || '&nbsp;'}</span>
      </span>
    </div>
    <div class="pad-toggle-row">
      <button class="pad-toggle-btn pad-loop-toggle${pad.loop ? ' active' : ''}" aria-pressed="${pad.loop ? 'true' : 'false'}">Loop</button>
      <button class="pad-toggle-btn pad-retrigger-toggle${pad.retrigger ? ' active' : ''}" aria-pressed="${pad.retrigger ? 'true' : 'false'}">Retrigger</button>
    </div>
    <div class="pad-footer">
      <div class="pad-control-group">
        <div class="pad-control-label">Volume</div>
        <div class="pad-control-value pad-vol-label">${Math.round(pad.volume * 100)}%</div>
        <input type="range" class="pad-vol-slider" min="0" max="100"
               value="${Math.round(pad.volume * 100)}" />
      </div>
      <div class="pad-control-group">
        <div class="pad-control-label">Fade In</div>
        <div class="pad-control-value pad-fi-label">${(pad.fadeIn || 0).toFixed(1)} s</div>
        <input type="range" class="pad-fi-slider" min="0" max="100"
               value="${Math.round((pad.fadeIn || 0) * 10)}" />
      </div>
      <div class="pad-control-group">
        <div class="pad-control-label">Fade Out</div>
        <div class="pad-control-value pad-fo-label">${(pad.fadeOut || 0).toFixed(1)} s</div>
        <input type="range" class="pad-fo-slider" min="0" max="100"
               value="${Math.round((pad.fadeOut || 0) * 10)}" />
      </div>
    </div>
  `;

  // Drag-to-reorder — only from non-interactive regions
  const interactiveSelector = '.pad-play-body, .pad-settings-btn, .pad-toggle-btn, .pad-vol-slider, .pad-fi-slider, .pad-fo-slider, input, button, select, [role="button"]';

  div.addEventListener('pointerdown', e => {
    if (e.button !== 0) { ui.padDrag = null; return; }
    if (e.target.closest(interactiveSelector)) { ui.padDrag = null; return; }
    ui.padDrag = {
      sourceId:  pad.id,
      sourceEl:  div,
      pointerId: e.pointerId,
      startX:    e.clientX,
      startY:    e.clientY,
      started:   false,
      offsetX:   0,
      offsetY:   0,
      ghost:     null,
      dropTarget: null,
    };
    div.setPointerCapture(e.pointerId);
  }, true);

  div.addEventListener('pointermove', e => {
    if (!ui.padDrag || ui.padDrag.pointerId !== e.pointerId || ui.padDrag.sourceId !== pad.id) return;

    if (!ui.padDrag.started) {
      const dist = Math.hypot(e.clientX - ui.padDrag.startX, e.clientY - ui.padDrag.startY);
      if (dist < 3) return;
      const rect = div.getBoundingClientRect();
      ui.padDrag.started = true;
      ui.padDrag.offsetX = ui.padDrag.startX - rect.left;
      ui.padDrag.offsetY = ui.padDrag.startY - rect.top;
      ui.padDrag.ghost   = createPadDragGhost(div, e.clientX, e.clientY, ui.padDrag.startX, ui.padDrag.startY);
      div.classList.add('drag-source');
    }

    updatePadDragGhost(ui.padDrag.ghost, e.clientX, e.clientY, ui.padDrag.offsetX, ui.padDrag.offsetY);
    ui.padDrag.dropTarget = getPadDropTarget(e.clientX, e.clientY, pad.id);
    setPadDropIndicator(ui.padDrag.dropTarget);
  }, true);

  function finishPointerDrag(e) {
    if (!ui.padDrag || ui.padDrag.sourceId !== pad.id) return;
    if (e.pointerId !== undefined && ui.padDrag.pointerId !== e.pointerId) return;

    if (ui.padDrag.started) {
      if (ui.padDrag.dropTarget?.type === 'sequence-list') {
        insertPadIntoSequence(ui.padDrag.dropTarget.sequenceId, pad.id, null);
      } else if (ui.padDrag.dropTarget?.type === 'sequence-step') {
        insertPadIntoSequence(ui.padDrag.dropTarget.sequenceId, pad.id, ui.padDrag.dropTarget);
      } else if (ui.padDrag.dropTarget?.type === 'sequence') {
        insertPadIntoSequence(ui.currentSeqId, pad.id, null);
      } else {
        applyPadDrop(pad.id, ui.padDrag.dropTarget);
      }
      clearPadDropIndicator();
      destroyPadDragGhost();
      div.classList.remove('drag-source');
      renderPadGrid();
    }

    try { div.releasePointerCapture(ui.padDrag.pointerId); } catch (_) { /* ignore */ }
    ui.padDrag = null;
  }

  div.addEventListener('pointerup',     finishPointerDrag, true);
  div.addEventListener('pointercancel', finishPointerDrag, true);

  div.addEventListener('lostpointercapture', () => {
    if (!ui.padDrag || ui.padDrag.sourceId !== pad.id) return;
    clearPadDropIndicator();
    destroyPadDragGhost();
    div.classList.remove('drag-source');
    ui.padDrag = null;
  }, true);

  div.addEventListener('dragstart', e => { e.preventDefault(); });

  div.querySelector('.pad-play-body').addEventListener('click', () => playPad(pad.id));
  div.querySelector('.pad-play-body').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playPad(pad.id); }
  });
  div.querySelector('.pad-settings-btn').addEventListener('click', e => {
    e.stopPropagation();
    openPadModal(pad.id);
  });

  const loopToggle = div.querySelector('.pad-loop-toggle');
  loopToggle.addEventListener('click', e => {
    e.stopPropagation();
    const p = getPad(pad.id);
    if (!p) return;
    p.loop = !p.loop;
    loopToggle.classList.toggle('active', p.loop);
    loopToggle.setAttribute('aria-pressed', String(p.loop));
    if (rt.howls[pad.id]) rt.howls[pad.id].loop(p.loop);
    queueAutosave();
  });

  const retriggerToggle = div.querySelector('.pad-retrigger-toggle');
  retriggerToggle.addEventListener('click', e => {
    e.stopPropagation();
    const p = getPad(pad.id);
    if (!p) return;
    p.retrigger = !p.retrigger;
    retriggerToggle.classList.toggle('active', p.retrigger);
    retriggerToggle.setAttribute('aria-pressed', String(p.retrigger));
    queueAutosave();
  });

  const volSlider = div.querySelector('.pad-vol-slider');
  const volLabel  = div.querySelector('.pad-vol-label');
  volSlider.addEventListener('input', () => {
    const v = sliderToVol(+volSlider.value);
    volLabel.textContent = Math.round(v * 100) + '%';
    const p = getPad(pad.id);
    if (p) {
      p.volume = v;
      const entry = rt.active[pad.id];
      if (entry && rt.howls[pad.id]) rt.howls[pad.id].volume(v, entry.soundId);
      queueAutosave();
    }
  });

  const fiSlider = div.querySelector('.pad-fi-slider');
  const fiLabel  = div.querySelector('.pad-fi-label');
  fiSlider.addEventListener('input', () => {
    const sec = sliderToSec(+fiSlider.value);
    fiLabel.textContent = sec.toFixed(1) + ' s';
    const p = getPad(pad.id);
    if (p) { p.fadeIn = sec; queueAutosave(); }
  });

  const foSlider = div.querySelector('.pad-fo-slider');
  const foLabel  = div.querySelector('.pad-fo-label');
  foSlider.addEventListener('input', () => {
    const sec = sliderToSec(+foSlider.value);
    foLabel.textContent = sec.toFixed(1) + ' s';
    const p = getPad(pad.id);
    if (p) { p.fadeOut = sec; queueAutosave(); }
  });

  refreshPadStatus(div, pad.id);
  updatePadDurationInCard(pad.id);
  hydratePadDuration(pad.id);

  return div;
}
