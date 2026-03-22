// ═══════════════════════════════════════════════════════════════
//  MODALS — pad modal and step modal
// ═══════════════════════════════════════════════════════════════

import {
  data, rt, ui,
  getPad, makePad, makeStep, getSeq,
  randomColor, basename,
  sliderToVol, sliderToSec,
  formatSec, dialogOpen, invoke,
} from './state.js';
import { getPadDurationSec, invalidateHowl, ensureHowl, getPadClipBounds, getPadBaseVolume, applyPadOutputGain, cleanupHowlOutputGainNodes } from './audio.js';
import { renderPadGrid, buildPadCard } from './pad-ui.js';
import { renderSeqList, renderSeqOverview, renderSeqSteps } from './seq-ui.js';
import { queueAutosave } from './persistence.js';

const PAD_DURATION_PROBE_ID = '__pad_duration_probe__';
const PAD_MODAL_PREVIEW_ID = '__pad_modal_preview__';
let modalAudioDurationSec = null;
let modalPreviewTimers = [];
let modalWaveformBuffer = null;
let modalWaveformPath = '';
let modalWaveformPeaks = [];
let waveformDragMode = null;
let modalGainDb = 0;
let modalLoudnessLufs = null;
let modalLoudnessTimer = null;
let modalLoudnessRunId = 0;
let projectLoudnessTimer = null;
let projectLoudnessRunId = 0;
const PROJECT_LOUDNESS_PARALLELISM = 4;

function setProjectLoudnessRecalcState(inProgress, message = 'Recalculating loudness...') {
  rt.loudnessRecalcInProgress = !!inProgress;

  const indicator = document.getElementById('loudness-recalc-indicator');
  if (indicator) {
    indicator.hidden = !inProgress;
    indicator.textContent = message;
  }

  document.body.classList.toggle('loudness-recalc-busy', !!inProgress);
}

const waveformAudioCtx = new (window.AudioContext || window.webkitAudioContext)();

function setPadPreviewStatus(text) {
  const el = document.getElementById('pad-preview-status');
  if (el) el.textContent = text;
}

function clearPadModalPreviewTimers() {
  modalPreviewTimers.forEach(t => clearTimeout(t));
  modalPreviewTimers = [];
}

function setPadLoudnessDisplay(text) {
  const el = document.getElementById('pad-loudness-display');
  if (el) el.textContent = text;
}

function formatLoudnessDisplay(loudnessLufs, gainDb) {
  return `Loudness: ${Number.isFinite(loudnessLufs) ? `${loudnessLufs.toFixed(1)} LUFS` : 'Unknown'} • Gain: ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`;
}

function getTargetLufsValue() {
  const input = document.getElementById('pad-target-lufs');
  const fallback = Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16;
  const value = Number(input?.value);
  return Number.isFinite(value) ? Math.max(-36, Math.min(-6, value)) : fallback;
}

function updateTargetLufsInput() {
  const input = document.getElementById('pad-target-lufs');
  const display = document.getElementById('pad-target-lufs-display');
  const value = Number.isFinite(ui.loudnessTargetLufs) ? Math.max(-36, Math.min(-6, ui.loudnessTargetLufs)) : -16;
  if (input) input.value = String(value);
  if (display) display.textContent = `${value.toFixed(1)} LUFS`;
}

export function syncProjectTargetLufsUI() {
  updateTargetLufsInput();
}

export function resetProjectLoudnessRecalcUI() {
  clearTimeout(projectLoudnessTimer);
  projectLoudnessTimer = null;
  projectLoudnessRunId += 1;
  setProjectLoudnessRecalcState(false);
}

function analyzeLoudnessMatch(buffer, trimStart, trimEnd, targetLufs) {
  if (!buffer) return null;
  const clip = getPadClipBounds({ trimStart, trimEnd }, buffer.duration);
  const loudnessLufs = estimateIntegratedLufs(buffer, clip.startSec, clip.endSec);
  if (!Number.isFinite(loudnessLufs)) return null;
  const gainDb = Math.max(-24, Math.min(24, targetLufs - loudnessLufs));
  return { loudnessLufs, gainDb };
}

async function applyLoudnessMatchToPad(pad, targetLufs = (Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16)) {
  if (!pad?.filePath) {
    pad.loudnessLufs = null;
    pad.gainDb = 0;
    return null;
  }

  try {
    const buffer = await decodeAudioBufferFromPath(pad.filePath);
    const result = analyzeLoudnessMatch(buffer, pad.trimStart, pad.trimEnd, targetLufs);
    pad.loudnessLufs = result?.loudnessLufs ?? null;
    pad.gainDb = result?.gainDb ?? 0;
    return result;
  } catch (error) {
    console.error('Failed loudness analysis:', error);
    pad.loudnessLufs = null;
    pad.gainDb = 0;
    return null;
  }
}

function applyPadLoudnessIfPlaying(pad) {
  const entry = rt.active[pad?.id];
  const howl = rt.howls[pad?.id];
  if (!pad || !entry || !howl || entry.soundId == null) return;
  applyPadOutputGain(howl, entry.soundId, pad);
}

async function recomputeProjectLoudnessForAllPads(targetLufs, runId) {
  const pads = data.pads.filter(pad => !!pad?.filePath);
  const total = pads.length;

  if (runId !== projectLoudnessRunId) return;

  if (total === 0) {
    setProjectLoudnessRecalcState(false);
    return;
  }

  setProjectLoudnessRecalcState(true, `Recalculating loudness... 0/${total}`);
  let done = 0;
  let nextIndex = 0;

  try {
    const workerCount = Math.min(PROJECT_LOUDNESS_PARALLELISM, total);
    const workers = Array.from({ length: workerCount }, async () => {
      while (true) {
        if (runId !== projectLoudnessRunId) return;

        const idx = nextIndex;
        nextIndex += 1;
        if (idx >= total) return;

        const pad = pads[idx];
        await applyLoudnessMatchToPad(pad, targetLufs);
        applyPadLoudnessIfPlaying(pad);

        done += 1;
        if (runId === projectLoudnessRunId) {
          setProjectLoudnessRecalcState(true, `Recalculating loudness... ${done}/${total}`);
        }
      }
    });

    await Promise.all(workers);

    if (runId !== projectLoudnessRunId) return;

    renderPadGrid();
    queueAutosave();

    const modal = document.getElementById('pad-modal');
    if (modal && !modal.hidden) {
      schedulePadModalLoudnessRefresh();
    }
  } finally {
    if (runId === projectLoudnessRunId) {
      setProjectLoudnessRecalcState(false);
    }
  }
}

function scheduleProjectLoudnessRecompute(targetLufs) {
  clearTimeout(projectLoudnessTimer);
  const runId = ++projectLoudnessRunId;
  const total = data.pads.filter(pad => !!pad?.filePath).length;
  if (total <= 0) {
    setProjectLoudnessRecalcState(false);
    return;
  }

  setProjectLoudnessRecalcState(true, `Recalculating loudness... 0/${total}`);
  projectLoudnessTimer = setTimeout(() => {
    projectLoudnessTimer = null;
    recomputeProjectLoudnessForAllPads(targetLufs, runId)
      .catch(error => {
        console.error('Failed project loudness recompute:', error);
        if (runId === projectLoudnessRunId) {
          setProjectLoudnessRecalcState(false);
        }
      });
  }, 220);
}

async function refreshPadModalLoudness(options = {}) {
  const { silent = false } = options;
  const filePath = document.getElementById('pad-filepath')?.value || '';
  const runId = ++modalLoudnessRunId;

  if (!filePath) {
    modalLoudnessLufs = null;
    modalGainDb = 0;
    setPadLoudnessDisplay(formatLoudnessDisplay(null, 0));
    return null;
  }

  if (!silent) setPadLoudnessDisplay('Analyzing loudness...');

  await ensureModalWaveform(filePath);
  if (runId !== modalLoudnessRunId) return null;
  if (!modalWaveformBuffer) {
    modalLoudnessLufs = null;
    modalGainDb = 0;
    setPadLoudnessDisplay('Loudness analysis failed');
    return null;
  }

  const { trimStart, trimEnd } = clampModalTrimValues();
  const result = analyzeLoudnessMatch(modalWaveformBuffer, trimStart, trimEnd, getTargetLufsValue());
  modalLoudnessLufs = result?.loudnessLufs ?? null;
  modalGainDb = result?.gainDb ?? 0;
  setPadLoudnessDisplay(formatLoudnessDisplay(modalLoudnessLufs, modalGainDb));
  return result;
}

function schedulePadModalLoudnessRefresh() {
  clearTimeout(modalLoudnessTimer);
  modalLoudnessTimer = setTimeout(() => {
    modalLoudnessTimer = null;
    refreshPadModalLoudness({ silent: true });
  }, 140);
}

function estimateIntegratedLufs(buffer, startSec = 0, endSec = null) {
  if (!buffer) return null;
  const sr = buffer.sampleRate;
  const start = Math.max(0, Math.floor(startSec * sr));
  const end = Math.min(buffer.length, Math.floor((endSec ?? buffer.duration) * sr));
  const total = Math.max(0, end - start);
  if (!total) return null;

  let sumSq = 0;
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c += 1) {
    const ch = buffer.getChannelData(c);
    for (let i = start; i < end; i += 1) {
      const sample = ch[i];
      sumSq += sample * sample;
    }
  }

  const meanSq = sumSq / (total * channels);
  if (!Number.isFinite(meanSq) || meanSq <= 0) return null;
  return -0.691 + 10 * Math.log10(meanSq);
}

async function decodeAudioBufferFromPath(filePath) {
  const dataUrl = await invoke('read_audio_dataurl', { path: filePath });
  const response = await fetch(dataUrl);
  const arrayBuffer = await response.arrayBuffer();
  return await waveformAudioCtx.decodeAudioData(arrayBuffer.slice(0));
}

function computeWaveformPeaks(buffer, bins = 240) {
  if (!buffer) return [];
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const binSize = Math.max(1, Math.floor(length / bins));
  const peaks = new Array(bins).fill(0);

  for (let b = 0; b < bins; b += 1) {
    const from = b * binSize;
    const to = Math.min(length, from + binSize);
    let peak = 0;
    for (let c = 0; c < channels; c += 1) {
      const ch = buffer.getChannelData(c);
      for (let i = from; i < to; i += 1) {
        const v = Math.abs(ch[i]);
        if (v > peak) peak = v;
      }
    }
    peaks[b] = peak;
  }
  return peaks;
}

function getTrimTimesFromInputs() {
  return {
    trimStart: Math.max(0, Number(document.getElementById('pad-trim-start')?.value) || 0),
    trimEnd: Math.max(0, Number(document.getElementById('pad-trim-end')?.value) || 0),
  };
}

function renderPadWaveform() {
  const canvas = document.getElementById('pad-waveform');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const dpr = window.devicePixelRatio || 1;
  const cssWidth = Math.max(280, Math.floor(canvas.clientWidth || 720));
  const cssHeight = Math.max(80, Math.floor(canvas.clientHeight || 120));
  canvas.width = Math.floor(cssWidth * dpr);
  canvas.height = Math.floor(cssHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.fillStyle = 'rgba(0,0,0,0.15)';
  ctx.fillRect(0, 0, cssWidth, cssHeight);

  if (!modalWaveformPeaks.length || !Number.isFinite(modalAudioDurationSec) || modalAudioDurationSec <= 0) {
    ctx.fillStyle = 'rgba(180, 180, 200, 0.8)';
    ctx.font = '12px Segoe UI';
    ctx.fillText('Select an audio file to view waveform', 12, cssHeight / 2);
    return;
  }

  const midY = cssHeight / 2;
  const width = cssWidth;
  const height = cssHeight;
  const barW = width / modalWaveformPeaks.length;

  const { trimStart, trimEnd } = clampModalTrimValues();
  const clip = getPadClipBounds({ trimStart, trimEnd }, modalAudioDurationSec);
  const startX = (clip.startSec / modalAudioDurationSec) * width;
  const endX = (clip.endSec / modalAudioDurationSec) * width;

  ctx.fillStyle = 'rgba(8, 10, 18, 0.52)';
  ctx.fillRect(0, 0, startX, height);
  ctx.fillRect(endX, 0, width - endX, height);

  ctx.fillStyle = '#8fa0c4';
  for (let i = 0; i < modalWaveformPeaks.length; i += 1) {
    const peak = modalWaveformPeaks[i];
    const barH = Math.max(1, peak * (height * 0.45));
    const x = i * barW;
    ctx.fillRect(x, midY - barH, Math.max(1, barW - 0.6), barH * 2);
  }

  ctx.strokeStyle = '#fdd023';
  ctx.lineWidth = 2;
  ctx.strokeRect(startX, 2, Math.max(2, endX - startX), height - 4);

  ctx.fillStyle = '#fdd023';
  ctx.fillRect(startX - 2, 0, 4, height);
  ctx.fillRect(endX - 2, 0, 4, height);
}

async function ensureModalWaveform(filePath) {
  if (!filePath) {
    modalWaveformBuffer = null;
    modalWaveformPath = '';
    modalWaveformPeaks = [];
    renderPadWaveform();
    return;
  }

  if (modalWaveformBuffer && modalWaveformPath === filePath) {
    renderPadWaveform();
    return;
  }

  try {
    const buffer = await decodeAudioBufferFromPath(filePath);
    modalWaveformBuffer = buffer;
    modalWaveformPath = filePath;
    modalAudioDurationSec = buffer.duration;
    modalWaveformPeaks = computeWaveformPeaks(buffer, 280);
    renderPadWaveform();
  } catch (error) {
    console.error('Failed waveform decode:', error);
    modalWaveformBuffer = null;
    modalWaveformPath = '';
    modalWaveformPeaks = [];
    renderPadWaveform();
  }
}

function setTrimFromWaveformX(clientX, mode) {
  if (!Number.isFinite(modalAudioDurationSec) || modalAudioDurationSec <= 0) return;
  const canvas = document.getElementById('pad-waveform');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  const timeSec = Math.round((ratio * modalAudioDurationSec) * 100) / 100;

  const startInput = document.getElementById('pad-trim-start');
  const endInput = document.getElementById('pad-trim-end');
  if (!startInput || !endInput) return;

  if (mode === 'start') {
    startInput.value = String(timeSec);
  } else {
    endInput.value = String(Math.max(0, Math.round((modalAudioDurationSec - timeSec) * 100) / 100));
  }

  syncPadTrimDisplays();
  renderPadWaveform();
}

export function onPadWaveformPointerDown(event) {
  const canvas = document.getElementById('pad-waveform');
  if (!canvas || !Number.isFinite(modalAudioDurationSec) || modalAudioDurationSec <= 0) return;

  const rect = canvas.getBoundingClientRect();
  const { trimStart, trimEnd } = getTrimTimesFromInputs();
  const clip = getPadClipBounds({ trimStart, trimEnd }, modalAudioDurationSec);
  const startX = rect.left + (clip.startSec / modalAudioDurationSec) * rect.width;
  const endX = rect.left + (clip.endSec / modalAudioDurationSec) * rect.width;
  const distStart = Math.abs(event.clientX - startX);
  const distEnd = Math.abs(event.clientX - endX);

  waveformDragMode = distStart <= distEnd ? 'start' : 'end';
  setTrimFromWaveformX(event.clientX, waveformDragMode);
  try { canvas.setPointerCapture(event.pointerId); } catch (_) { /* ignore */ }
}

export function onPadWaveformPointerMove(event) {
  if (!waveformDragMode) return;
  setTrimFromWaveformX(event.clientX, waveformDragMode);
}

export function onPadWaveformPointerUp(event) {
  const canvas = document.getElementById('pad-waveform');
  if (canvas) {
    try { canvas.releasePointerCapture(event.pointerId); } catch (_) { /* ignore */ }
  }
  waveformDragMode = null;
}

export async function matchPadModalLoudness() {
  await refreshPadModalLoudness();
}

function clampModalTrimValues() {
  const trimStartInput = document.getElementById('pad-trim-start');
  const trimEndInput = document.getElementById('pad-trim-end');
  if (!trimStartInput || !trimEndInput) return { trimStart: 0, trimEnd: 0 };

  let trimStart = Math.max(0, Number(trimStartInput.value) || 0);
  let trimEnd = Math.max(0, Number(trimEndInput.value) || 0);

  if (Number.isFinite(modalAudioDurationSec) && modalAudioDurationSec > 0) {
    const minPlayableSec = Math.min(0.05, modalAudioDurationSec);
    const maxTotalTrim = Math.max(0, modalAudioDurationSec - minPlayableSec);
    const sum = trimStart + trimEnd;
    if (sum > maxTotalTrim) {
      const overflow = sum - maxTotalTrim;
      if (trimEnd >= overflow) {
        trimEnd -= overflow;
      } else {
        trimStart = Math.max(0, trimStart - (overflow - trimEnd));
        trimEnd = 0;
      }
    }
    trimStart = Math.min(trimStart, modalAudioDurationSec);
    trimEnd = Math.min(trimEnd, modalAudioDurationSec);
  }

  trimStart = Math.round(trimStart * 100) / 100;
  trimEnd = Math.round(trimEnd * 100) / 100;
  trimStartInput.value = String(trimStart);
  trimEndInput.value = String(trimEnd);
  return { trimStart, trimEnd };
}

export function syncPadTrimDisplays() {
  const clipEl = document.getElementById('pad-clip-duration-display');
  if (!clipEl) return;

  const { trimStart, trimEnd } = clampModalTrimValues();
  if (!Number.isFinite(modalAudioDurationSec) || modalAudioDurationSec <= 0) {
    clipEl.textContent = 'Clip Length: Unknown';
    return;
  }

  const clip = getPadClipBounds({ trimStart, trimEnd }, modalAudioDurationSec);
  clipEl.textContent = 'Clip Length: ' + formatSec(clip.playSec);
  if (document.getElementById('pad-modal') && !document.getElementById('pad-modal').hidden) {
    schedulePadModalLoudnessRefresh();
  }
  renderPadWaveform();
}

export function stopPadModalPreview() {
  clearPadModalPreviewTimers();
  const howl = rt.howls[PAD_MODAL_PREVIEW_ID];
  if (howl) {
    howl.stop();
    cleanupHowlOutputGainNodes(howl);
    howl.unload();
    delete rt.howls[PAD_MODAL_PREVIEW_ID];
  }
  delete rt.padDurSec[PAD_MODAL_PREVIEW_ID];
  setPadPreviewStatus('Not playing');
}

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
  document.getElementById('pad-playback-speed').value = Number.isFinite(pad.playbackSpeed) ? pad.playbackSpeed : 1.0;
  document.getElementById('pad-trim-start').value = (Number(pad.trimStart) || 0).toFixed(2);
  document.getElementById('pad-trim-end').value = (Number(pad.trimEnd) || 0).toFixed(2);
  document.getElementById('pad-loop').checked   = pad.loop;
  document.getElementById('pad-retrigger').checked = !!pad.retrigger;
  ui.loudnessTargetLufs = Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16;
  updateTargetLufsInput();
  document.getElementById('pad-modal-delete').style.display = '';
  setPadPreviewStatus('Not playing');
  modalGainDb = Number.isFinite(pad.gainDb) ? pad.gainDb : 0;
  modalLoudnessLufs = Number.isFinite(pad.loudnessLufs) ? pad.loudnessLufs : null;
  setPadLoudnessDisplay(formatLoudnessDisplay(modalLoudnessLufs, modalGainDb));

  syncPadModalDisplays();
  updatePadDurationDisplay(pad.filePath, pad.label);
  syncPadTrimDisplays();
  syncPadPlaybackSpeedDisplay();
  ensureModalWaveform(pad.filePath);
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
  document.getElementById('pad-playback-speed').value = 1.0;
  document.getElementById('pad-trim-start').value = '0.00';
  document.getElementById('pad-trim-end').value = '0.00';
  document.getElementById('pad-loop').checked   = false;
  document.getElementById('pad-retrigger').checked = false;
  ui.loudnessTargetLufs = Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16;
  updateTargetLufsInput();
  document.getElementById('pad-modal-delete').style.display = 'none';
  setPadPreviewStatus('Not playing');
  modalGainDb = 0;
  modalLoudnessLufs = null;
  setPadLoudnessDisplay(formatLoudnessDisplay(null, 0));

  syncPadModalDisplays();
  updatePadDurationDisplay(filePath, label);
  syncPadTrimDisplays();
  syncPadPlaybackSpeedDisplay();
  ensureModalWaveform(filePath);
  syncSwatches(document.getElementById('pad-color').value);
  document.getElementById('pad-modal').hidden = false;
}

export function closePadModal() {
  stopPadModalPreview();
  clearTimeout(modalLoudnessTimer);
  modalLoudnessTimer = null;
  modalLoudnessRunId += 1;
  modalAudioDurationSec = null;
  modalWaveformBuffer = null;
  modalWaveformPath = '';
  modalWaveformPeaks = [];
  waveformDragMode = null;
  modalGainDb = 0;
  modalLoudnessLufs = null;
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
    modalAudioDurationSec = null;
    durationEl.textContent = 'Length: Unknown';
    modalLoudnessLufs = null;
    modalGainDb = 0;
    setPadLoudnessDisplay(formatLoudnessDisplay(null, 0));
    modalWaveformBuffer = null;
    modalWaveformPath = '';
    modalWaveformPeaks = [];
    renderPadWaveform();
    syncPadTrimDisplays();
    return;
  }

  durationEl.textContent = 'Length: Loading...';
  const tempPad = makePad({ id: PAD_DURATION_PROBE_ID, filePath, label: labelHint || 'Preview' });
  const dur     = await getPadDurationSec(tempPad);
  modalAudioDurationSec = dur;
  durationEl.textContent = 'Length: ' + formatSec(dur);
  if (rt.howls[PAD_DURATION_PROBE_ID]) {
    rt.howls[PAD_DURATION_PROBE_ID].unload();
    delete rt.howls[PAD_DURATION_PROBE_ID];
  }
  delete rt.padDurSec[PAD_DURATION_PROBE_ID];
  syncPadTrimDisplays();
  await ensureModalWaveform(filePath);
}

export function syncSwatches(hexColor) {
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === hexColor);
  });
}

function getPadModalValues() {
  const { trimStart, trimEnd } = clampModalTrimValues();
  return {
    color:     document.getElementById('pad-color').value,
    volume:    sliderToVol(+document.getElementById('pad-volume').value),
    fadeIn:    sliderToSec(+document.getElementById('pad-fadein').value),
    fadeOut:   sliderToSec(+document.getElementById('pad-fadeout').value),
    playbackSpeed: Math.max(0.5, Math.min(4.0, +document.getElementById('pad-playback-speed').value)),
    trimStart,
    trimEnd,
    gainDb:    modalGainDb,
    loudnessLufs: modalLoudnessLufs,
    loop:      document.getElementById('pad-loop').checked,
    retrigger: document.getElementById('pad-retrigger').checked,
  };
}

export async function previewPadModalClip() {
  const filePath = document.getElementById('pad-filepath').value;
  if (!filePath) {
    setPadPreviewStatus('Select an audio file first');
    return;
  }

  stopPadModalPreview();
  setPadPreviewStatus('Loading preview...');

  const values = getPadModalValues();
  const previewPad = makePad({
    id: PAD_MODAL_PREVIEW_ID,
    label: 'Preview',
    filePath,
    loop: false,
    ...values,
  });

  const howl = await ensureHowl(previewPad);
  if (!howl) {
    setPadPreviewStatus('Preview failed to load');
    return;
  }

  const totalDur = howl.duration();
  if (Number.isFinite(totalDur) && totalDur > 0) {
    modalAudioDurationSec = totalDur;
    syncPadTrimDisplays();
  }

  const clip = getPadClipBounds(previewPad, totalDur);
  if (!clip.playSec) {
    setPadPreviewStatus('Invalid clip length');
    return;
  }

  const targetVol = getPadBaseVolume(previewPad);
  const soundId = howl.play();
  howl.loop(false, soundId);
  applyPadOutputGain(howl, soundId, previewPad);
  howl.volume(previewPad.fadeIn > 0 ? 0 : targetVol, soundId);
  if (clip.startSec > 0) {
    howl.seek(clip.startSec, soundId);
  }
  if (previewPad.fadeIn > 0) {
    howl.fade(0, targetVol, previewPad.fadeIn * 1000, soundId);
  }

  if (previewPad.fadeOut > 0 && clip.playSec > previewPad.fadeOut) {
    const fadeTimer = setTimeout(() => {
      if (howl.playing(soundId)) {
        howl.fade(targetVol, 0, previewPad.fadeOut * 1000, soundId);
      }
    }, (clip.playSec - previewPad.fadeOut) * 1000);
    modalPreviewTimers.push(fadeTimer);
  }

  const stopTimer = setTimeout(() => {
    if (howl.playing(soundId)) howl.stop(soundId);
    setPadPreviewStatus('Preview finished');
  }, clip.playSec * 1000);
  modalPreviewTimers.push(stopTimer);
  setPadPreviewStatus(`Playing preview (${formatSec(clip.playSec)})`);
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

  const targetLufs = Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16;
  Promise.all(newPads.map(pad => applyLoudnessMatchToPad(pad, targetLufs)))
    .then(() => {
      renderPadGrid();
      queueAutosave();
    })
    .catch(error => {
      console.error('Failed import loudness matching:', error);
    });
}

export async function savePadModal() {
  const label    = document.getElementById('pad-label').value.trim() || 'New Sound';
  const filePath = document.getElementById('pad-filepath').value;
  ui.loudnessTargetLufs = getTargetLufsValue();
  if (filePath) {
    await refreshPadModalLoudness({ silent: true });
  }
  const { color, volume, fadeIn, fadeOut, playbackSpeed, trimStart, trimEnd, gainDb, loudnessLufs, loop, retrigger } = getPadModalValues();

  if (ui.editingPadId) {
    const pad    = getPad(ui.editingPadId);
    const reload = pad.filePath !== filePath || pad.loop !== loop;
    pad.label     = label;
    pad.color     = color;
    pad.filePath  = filePath;
    pad.volume    = volume;
    pad.fadeIn    = fadeIn;
    pad.fadeOut   = fadeOut;
    pad.playbackSpeed = playbackSpeed;
    pad.trimStart = trimStart;
    pad.trimEnd   = trimEnd;
    pad.gainDb    = gainDb;
    pad.loudnessLufs = loudnessLufs;
    pad.loop      = loop;
    pad.retrigger = retrigger;
    if (reload) invalidateHowl(pad.id);
    const oldCard = document.querySelector(`.pad-card[data-pad-id="${pad.id}"]`);
    if (oldCard) {
      const newCard = buildPadCard(pad);
      oldCard.parentNode.replaceChild(newCard, oldCard);
    }
  } else {
    const pad    = makePad({ label, color, filePath, volume, fadeIn, fadeOut, playbackSpeed, trimStart, trimEnd, gainDb, loudnessLufs, loop, retrigger });
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
  modalGainDb = 0;
  modalLoudnessLufs = null;
  setPadLoudnessDisplay('Analyzing loudness...');
  await updatePadDurationDisplay(selected);
  await refreshPadModalLoudness({ silent: true });
  const cur = document.getElementById('pad-label').value.trim();
  if (!cur || cur === 'New Sound') {
    const name = basename(selected).replace(/\.[^.]+$/, '');
    document.getElementById('pad-label').value = name;
  }
}

export function onPadTargetLufsInput() {
  const targetLufs = getTargetLufsValue();
  ui.loudnessTargetLufs = targetLufs;
  syncProjectTargetLufsUI();
  const modal = document.getElementById('pad-modal');
  if (modal && !modal.hidden) {
    schedulePadModalLoudnessRefresh();
  }
  scheduleProjectLoudnessRecompute(targetLufs);
  queueAutosave();
}

// ── Pad playback speed sync ───────────────────────────────────

export function syncPadPlaybackSpeedDisplay() {
  const pad = getPad(ui.editingPadId);
  if (!pad) return;
  const slider = document.getElementById('pad-playback-speed');
  const display = document.getElementById('pad-speed-display');
  if (slider) slider.value = Number.isFinite(pad.playbackSpeed) ? pad.playbackSpeed : 1.0;
  if (display) display.textContent = (Number.isFinite(pad.playbackSpeed) ? pad.playbackSpeed : 1.0).toFixed(1) + '×';
}

export function onPadPlaybackSpeedChange() {
  const slider = document.getElementById('pad-playback-speed');
  const display = document.getElementById('pad-speed-display');
  if (slider && display) {
    const speed = parseFloat(slider.value);
    display.textContent = speed.toFixed(1) + '×';
  }
}
