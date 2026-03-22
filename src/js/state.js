// ═══════════════════════════════════════════════════════════════
//  STATE — shared application state, constants, and pure helpers
// ═══════════════════════════════════════════════════════════════

export const { invoke } = window.__TAURI__.core;
export const { open: dialogOpen, save: dialogSave } = window.__TAURI__.dialog;

// ── Persistence constants ─────────────────────────────────────
export const AUTOSAVE_KEY          = 'soundboard.autosave.v1';
export const AUTOSAVE_INTERVAL_MS  = 1400;

// ── Layout constants ──────────────────────────────────────────
export const SEQ_LIST_ONLY_WIDTH       = 236;
export const SEQ_EDITOR_MIN_WIDTH      = 560;
export const SOUNDBOARD_MIN_WIDTH      = 360;
export const SEQ_ROW_OVERFLOW_STEP     = 8;
export const SEQ_ROW_OVERFLOW_HYSTERESIS = 2;

// ── Application state ─────────────────────────────────────────
export const data = {          // persisted
  version:   1,
  pads:      [],
  sequences: [],
};

export const rt = {            // runtime only
  howls:      {},              // padId → Howl
  active:     {},              // padId → { soundId, timers[] }
  padDurSec:  {},              // padId → duration seconds
  master:     1.0,
  seqState:   'idle',          // 'idle' | 'playing'
  seqId:      null,
  seqStep:    -1,
  seqTimers:  [],
  seqForcedNext:    false,
  seqCurrentSoundId: undefined,
  seqCurrentHowl:    null,
  progressRaf: null,
};

export const ui = {
  editingPadId:  null,         // pad being edited in modal
  currentSeqId:  null,         // sequence shown in editor
  padDrag:       null,
  seqPanelOpen:  true,
  seqEditorOpen: false,
  seqPanelWidth: null,
  loudnessTargetLufs: -16,
  themeKey:      'lsu-night',
};

// ── Data helpers ──────────────────────────────────────────────
export function getPad(id) { return data.pads.find(p => p.id === id); }
export function getSeq(id) { return data.sequences.find(s => s.id === id); }

// ── Data factories ────────────────────────────────────────────
export function makePad(overrides = {}) {
  return {
    id:        uuid(),
    label:     'New Sound',
    filePath:  '',
    color:     '#3b82f6',
    volume:    0.8,
    fadeIn:    0,
    fadeOut:   0,
    trimStart: 0,
    trimEnd:   0,
    gainDb:    0,
    loudnessLufs: null,
    playbackSpeed: 1.0,
    loop:      false,
    retrigger: false,
    ...overrides,
  };
}

export function makeSeq(name = 'New Sequence') {
  return { id: uuid(), name, defaultCrossfade: 0, steps: [] };
}

export function makeStep(overrides = {}) {
  return {
    id:            uuid(),
    padId:         '',
    duration:      null,   // null = full length
    crossfadeNext: null,   // null = sequence default
    ...overrides,
  };
}

// ── Normalisation (applied when loading saved data) ───────────
export function normalizePad(pad) {
  if (typeof pad.retrigger !== 'boolean') pad.retrigger = false;
  if (!Number.isFinite(pad.trimStart) || pad.trimStart < 0) pad.trimStart = 0;
  if (!Number.isFinite(pad.trimEnd) || pad.trimEnd < 0) pad.trimEnd = 0;
  if (!Number.isFinite(pad.gainDb)) pad.gainDb = 0;
  if (!Number.isFinite(pad.loudnessLufs)) pad.loudnessLufs = null;
  if (!Number.isFinite(pad.playbackSpeed) || pad.playbackSpeed <= 0) pad.playbackSpeed = 1.0;
  delete pad.defaultCrossfade;
  delete pad.playDuration;
}

export function normalizeSeq(seq) {
  if (typeof seq.defaultCrossfade !== 'number') seq.defaultCrossfade = 0;
  if (!Array.isArray(seq.steps)) seq.steps = [];
  seq.steps.forEach(step => {
    if (!Object.prototype.hasOwnProperty.call(step, 'crossfadeNext')) step.crossfadeNext = null;
    if (step.crossfadeNext !== null && typeof step.crossfadeNext !== 'number') {
      step.crossfadeNext = 0;
    }
  });
}

// ── Pure data helpers ─────────────────────────────────────────
export function getEffectiveStepCrossfade(step, seq) {
  if (step.crossfadeNext != null) return Math.max(0, step.crossfadeNext);
  return Math.max(0, seq.defaultCrossfade || 0);
}

// ── Slider ↔ value conversions ────────────────────────────────
/** Slider 0–100 → seconds with 0.1 s precision, max 10 s */
export function sliderToSec(v) { return parseFloat((v / 10).toFixed(1)); }
/** Slider 0–100 → fraction 0–1 */
export function sliderToVol(v) { return v / 100; }
/** Slider 0–600 → seconds with 0.5 s precision; 0 means full/default */
export function sliderToDurationSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return parseFloat((n / 2).toFixed(1));
}
export function durationSecToSlider(sec, maxSec = 300) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round(Math.min(maxSec, sec) * 2);
}

// ── Format helpers ────────────────────────────────────────────
export function formatSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'Unknown';
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatDurationClock(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return '';
  const totalMs = Math.round(sec * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const millis  = totalMs % 1000;
  if (minutes === 0) {
    return `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`;
}

export function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

export function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function getPadClipBounds(pad, totalDurationSec) {
  if (!Number.isFinite(totalDurationSec) || totalDurationSec <= 0) {
    return { startSec: 0, endSec: 0, playSec: 0 };
  }

  const minPlayableSec = Math.min(0.05, totalDurationSec);
  let startSec = clampNumber(Number(pad?.trimStart) || 0, 0, totalDurationSec);
  let endTrimSec = clampNumber(Number(pad?.trimEnd) || 0, 0, totalDurationSec);
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

export function getPadPlaybackDurationSec(pad, totalDurationSec) {
  return getPadClipBounds(pad, totalDurationSec).playSec;
}

// ── Color cycling (30 proven, high-contrast defaults) ────────
// Palette derived from widely used Tailwind/Material-like hues for
// distinct category-style colors that remain readable on dark surfaces.
export const PAD_COLOR_PALETTE = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#22c55e',
  '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6', '#6366f1',
  '#8b5cf6', '#a855f7', '#d946ef', '#ec4899', '#f43f5e', '#fb7185',
  '#f87171', '#fb923c', '#facc15', '#a3e635', '#4ade80', '#2dd4bf',
  '#22d3ee', '#38bdf8', '#60a5fa', '#818cf8', '#c084fc', '#f472b6',
];
let _colorIdx = 0;
export function randomColor() { return PAD_COLOR_PALETTE[_colorIdx++ % PAD_COLOR_PALETTE.length]; }

// ── Utility ───────────────────────────────────────────────────
export function uuid() { return crypto.randomUUID(); }
