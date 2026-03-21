// ═══════════════════════════════════════════════════════════════
//  MODALS — pad modal and step modal
// ═══════════════════════════════════════════════════════════════

import {
  data, rt, ui,
  getPad, makePad, makeStep, getSeq,
  randomColor, basename,
  sliderToVol, sliderToSec,
  formatSec, dialogOpen,
} from './state.js';
import { getPadDurationSec, invalidateHowl, ensureHowl } from './audio.js';
import { renderPadGrid, buildPadCard } from './pad-ui.js';
import { renderSeqList, renderSeqOverview, renderSeqSteps } from './seq-ui.js';
import { queueAutosave } from './persistence.js';

// ── Pad modal ─────────────────────────────────────────────────

export function openPadModal(padId) {
  const pad = getPad(padId);
  if (!pad) return;
  ui.editingPadId = padId;

  document.getElementById('pad-modal-title').textContent = 'Edit Sound';
  document.getElementById('pad-label').value    = pad.label;
  document.getElementById('pad-color').value    = pad.color;
  document.getElementById('pad-filepath').value = pad.filePath;
  document.getElementById('pad-volume').value   = Math.round(pad.volume * 100);
  document.getElementById('pad-fadein').value   = Math.round(pad.fadeIn * 10);
  document.getElementById('pad-fadeout').value  = Math.round(pad.fadeOut * 10);
  document.getElementById('pad-loop').checked   = pad.loop;
  document.getElementById('pad-retrigger').checked = !!pad.retrigger;
  document.getElementById('pad-modal-delete').style.display = '';

  syncPadModalDisplays();
  updatePadDurationDisplay(pad.filePath, pad.label);
  syncSwatches(pad.color);
  document.getElementById('pad-modal').hidden = false;
}

export function openNewPadModal(filePath = '', label = '') {
  ui.editingPadId = null;
  document.getElementById('pad-modal-title').textContent = 'Add Sound';
  document.getElementById('pad-label').value    = label;
  document.getElementById('pad-color').value    = randomColor();
  document.getElementById('pad-filepath').value = filePath;
  document.getElementById('pad-volume').value   = 80;
  document.getElementById('pad-fadein').value   = 0;
  document.getElementById('pad-fadeout').value  = 0;
  document.getElementById('pad-loop').checked   = false;
  document.getElementById('pad-retrigger').checked = false;
  document.getElementById('pad-modal-delete').style.display = 'none';

  syncPadModalDisplays();
  updatePadDurationDisplay(filePath, label);
  syncSwatches(document.getElementById('pad-color').value);
  document.getElementById('pad-modal').hidden = false;
}

export function closePadModal() {
  document.getElementById('pad-modal').hidden = true;
  ui.editingPadId = null;
}

export function syncPadModalDisplays() {
  const vol     = +document.getElementById('pad-volume').value;
  const fadeIn  = +document.getElementById('pad-fadein').value;
  const fadeOut = +document.getElementById('pad-fadeout').value;
  document.getElementById('pad-vol-display').textContent     = vol + '%';
  document.getElementById('pad-fadein-display').textContent  = sliderToSec(fadeIn).toFixed(1)  + ' s';
  document.getElementById('pad-fadeout-display').textContent = sliderToSec(fadeOut).toFixed(1) + ' s';
}

export async function updatePadDurationDisplay(filePath, labelHint = '') {
  const durationEl = document.getElementById('pad-duration-display');
  if (!durationEl) return;
  if (!filePath) {
    durationEl.textContent = 'Length: Unknown';
    return;
  }

  durationEl.textContent = 'Length: Loading...';
  const tempPad = makePad({ id: '__preview__', filePath, label: labelHint || 'Preview' });
  const dur     = await getPadDurationSec(tempPad);
  durationEl.textContent = 'Length: ' + formatSec(dur);
  if (rt.howls[tempPad.id]) {
    rt.howls[tempPad.id].unload();
    delete rt.howls[tempPad.id];
  }
}

export function syncSwatches(hexColor) {
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === hexColor);
  });
}

function getPadModalValues() {
  return {
    color:     document.getElementById('pad-color').value,
    volume:    sliderToVol(+document.getElementById('pad-volume').value),
    fadeIn:    sliderToSec(+document.getElementById('pad-fadein').value),
    fadeOut:   sliderToSec(+document.getElementById('pad-fadeout').value),
    loop:      document.getElementById('pad-loop').checked,
    retrigger: document.getElementById('pad-retrigger').checked,
  };
}

export function addPadsFromFiles(filePaths) {
  const baseValues = getPadModalValues();
  const newPads    = filePaths.map((filePath, index) => makePad({
    ...baseValues,
    color:    index === 0 ? baseValues.color : randomColor(),
    filePath,
    label:    basename(filePath).replace(/\.[^.]+$/, ''),
  }));

  data.pads.push(...newPads);
  renderPadGrid();
  queueAutosave();
}

export function savePadModal() {
  const label    = document.getElementById('pad-label').value.trim() || 'New Sound';
  const filePath = document.getElementById('pad-filepath').value;
  const { color, volume, fadeIn, fadeOut, loop, retrigger } = getPadModalValues();

  if (ui.editingPadId) {
    const pad    = getPad(ui.editingPadId);
    const reload = pad.filePath !== filePath || pad.loop !== loop;
    pad.label     = label;
    pad.color     = color;
    pad.filePath  = filePath;
    pad.volume    = volume;
    pad.fadeIn    = fadeIn;
    pad.fadeOut   = fadeOut;
    pad.loop      = loop;
    pad.retrigger = retrigger;
    if (reload) invalidateHowl(pad.id);
    const oldCard = document.querySelector(`.pad-card[data-pad-id="${pad.id}"]`);
    if (oldCard) {
      const newCard = buildPadCard(pad);
      oldCard.parentNode.replaceChild(newCard, oldCard);
    }
  } else {
    const pad    = makePad({ label, color, filePath, volume, fadeIn, fadeOut, loop, retrigger });
    data.pads.push(pad);
    const grid   = document.getElementById('pad-grid');
    const addBtn = document.getElementById('btn-grid-add');
    grid.insertBefore(buildPadCard(pad), addBtn);
  }

  closePadModal();
  queueAutosave();
}

export function deletePad(padId) {
  invalidateHowl(padId);
  data.pads = data.pads.filter(p => p.id !== padId);
  data.sequences.forEach(seq => {
    seq.steps = seq.steps.filter(s => s.padId !== padId);
  });
  renderPadGrid();
  renderSeqList();
  renderSeqOverview();
  if (ui.currentSeqId && ui.seqEditorOpen) renderSeqSteps();
  closePadModal();
  queueAutosave();
}

// ── Step modal ────────────────────────────────────────────────

export function openStepModal() {
  const sel = document.getElementById('step-pad-select');
  const seq = getSeq(ui.currentSeqId);
  sel.innerHTML = '';
  data.pads.forEach(pad => {
    const opt       = document.createElement('option');
    opt.value       = pad.id;
    opt.textContent = pad.label;
    sel.appendChild(opt);
  });
  if (data.pads.length === 0) {
    const opt       = document.createElement('option');
    opt.textContent = 'No sounds added yet';
    opt.disabled    = true;
    sel.appendChild(opt);
  }
  document.getElementById('step-duration').value  = '';
  document.getElementById('step-crossfade').value = '';
  document.getElementById('step-crossfade').placeholder = seq
    ? `Default ${seq.defaultCrossfade.toFixed(1)} s`
    : 'Default';
  updateStepModalDuration();
  document.getElementById('step-modal').hidden = false;
}

export async function updateStepModalDuration() {
  const sel   = document.getElementById('step-pad-select');
  const label = document.getElementById('step-pad-duration');
  const seq   = getSeq(ui.currentSeqId);
  const pad   = getPad(sel.value);
  if (!pad || !label) {
    if (label) label.textContent = 'Length: Unknown';
    return;
  }
  label.textContent = 'Length: Loading...';
  const dur = await getPadDurationSec(pad);
  label.textContent = 'Length: ' + formatSec(dur);

  const cf = document.getElementById('step-crossfade');
  if (cf) {
    const seqDefault = seq ? seq.defaultCrossfade : 0;
    cf.placeholder = `Default ${seqDefault.toFixed(1)} s`;
  }
}

export function closeStepModal() {
  document.getElementById('step-modal').hidden = true;
}

export function saveStepModal() {
  const padId    = document.getElementById('step-pad-select').value;
  const durVal   = document.getElementById('step-duration').value.trim();
  const cfVal    = document.getElementById('step-crossfade').value.trim();
  const duration  = durVal === '' ? null : parseFloat(durVal);
  const crossfade = cfVal  === '' ? null : Math.max(0, parseFloat(cfVal) || 0);

  const seq = getSeq(ui.currentSeqId);
  if (!seq || !padId) return;

  seq.steps.push(makeStep({ padId, duration, crossfadeNext: crossfade }));
  renderSeqSteps();
  renderSeqList();
  renderSeqOverview();
  closeStepModal();
  queueAutosave();
}

// ── File browse helper ────────────────────────────────────────

export async function browseAudioFiles() {
  const selected = await dialogOpen({
    title:    'Select Audio File',
    multiple: !ui.editingPadId,
    filters:  [{ name: 'Audio Files', extensions: ['mp3','wav','ogg','flac','aac','m4a','opus','webm'] }],
  });
  if (!selected) return;

  if (Array.isArray(selected)) {
    if (selected.length === 0) return;
    addPadsFromFiles(selected);
    closePadModal();
    return;
  }

  document.getElementById('pad-filepath').value = selected;
  await updatePadDurationDisplay(selected);
  const cur = document.getElementById('pad-label').value.trim();
  if (!cur || cur === 'New Sound') {
    const name = basename(selected).replace(/\.[^.]+$/, '');
    document.getElementById('pad-label').value = name;
  }
}
