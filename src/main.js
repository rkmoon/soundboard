// ═══════════════════════════════════════════════════════════════
//  SOUNDBOARD  –  main.js
// ═══════════════════════════════════════════════════════════════

const { invoke } = window.__TAURI__.core;
const { open: dialogOpen, save: dialogSave } = window.__TAURI__.dialog;

const AUTOSAVE_KEY = 'soundboard.autosave.v1';
const AUTOSAVE_INTERVAL_MS = 1400;
const SEQ_LIST_ONLY_WIDTH = 236;
const SEQ_EDITOR_MIN_WIDTH = 560;
const SOUNDBOARD_MIN_WIDTH = 360;
const SEQ_ROW_OVERFLOW_STEP = 8;
const SEQ_ROW_OVERFLOW_HYSTERESIS = 2;

// ── Utilities ────────────────────────────────────────────────
function uuid() {
  return crypto.randomUUID();
}

/** Slider 0‑100 → seconds with 0.1 s precision, max 10 s */
function sliderToSec(v) { return parseFloat((v / 10).toFixed(1)); }
/** Slider 0‑100 → fraction 0‑1 */
function sliderToVol(v) { return v / 100; }
/** Slider 0‑600 → seconds with 0.5 s precision, 0 means full/default */
function sliderToDurationSec(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return parseFloat((n / 2).toFixed(1));
}

function durationSecToSlider(sec, maxSec = 300) {
  if (!Number.isFinite(sec) || sec <= 0) return 0;
  return Math.round(Math.min(maxSec, sec) * 2);
}

function basename(path) {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ── Application State ─────────────────────────────────────────
const data = {           // persisted
  version: 1,
  pads: [],
  sequences: [],
};

const rt = {             // runtime only
  howls:   {},           // padId → Howl
  active:  {},           // padId → { soundId, timers[] }
  padDurSec: {},         // padId → duration seconds
  master:  1.0,
  seqState: 'idle',      // 'idle' | 'playing'
  seqId:    null,
  seqStep:  -1,
  seqTimers: [],
  seqForcedNext: false,
  progressRaf: null,
};

const ui = {
  editingPadId: null,    // pad being edited in modal
  currentSeqId:  null,   // sequence shown in editor
  padDrag: null,
  seqPanelOpen: true,
  seqEditorOpen: false,
  seqPanelWidth: null,
};

let autosaveTimer = null;

// ── Data helpers ──────────────────────────────────────────────
function getPad(id)      { return data.pads.find(p => p.id === id); }
function getSeq(id)      { return data.sequences.find(s => s.id === id); }

function getSequencerEditorWidthBounds() {
  const hasEditor = !!ui.seqEditorOpen && !!ui.currentSeqId;
  const measuredMin = hasEditor ? SEQ_EDITOR_MIN_WIDTH : SEQ_LIST_ONLY_WIDTH;
  const viewportMax = Math.max(SEQ_LIST_ONLY_WIDTH, window.innerWidth - SOUNDBOARD_MIN_WIDTH);
  const minWidth = Math.min(measuredMin, viewportMax);
  const preferredMax = Math.round(window.innerWidth * 0.78);
  const maxWidth = Math.max(minWidth, Math.min(viewportMax, preferredMax));
  return { minWidth, maxWidth };
}

function hasSequencerRowOverflow() {
  if (!ui.seqEditorOpen || !ui.currentSeqId) return false;
  const editor = document.getElementById('seq-editor');
  if (!editor || editor.hidden) return false;

  const rows = Array.from(editor.querySelectorAll('.seq-step-row'));
  if (rows.length === 0) return false;

  const sample = rows.length > 14 ? rows.slice(0, 14) : rows;
  return sample.some(row => (row.scrollWidth - row.clientWidth) > SEQ_ROW_OVERFLOW_HYSTERESIS);
}

function resolvePanelWidthForRowVisibility(panel, requestedWidth, bounds) {
  let candidate = Math.max(bounds.minWidth, Math.min(bounds.maxWidth, requestedWidth));
  if (!panel || !ui.seqEditorOpen || !ui.currentSeqId || window.innerWidth <= 980) {
    return candidate;
  }

  const prevWidth = panel.style.width;
  const prevMinWidth = panel.style.minWidth;
  const setTempWidth = width => {
    panel.style.width = `${width}px`;
    panel.style.minWidth = `${width}px`;
  };

  setTempWidth(candidate);
  if (hasSequencerRowOverflow()) {
    while (candidate < bounds.maxWidth) {
      candidate = Math.min(bounds.maxWidth, candidate + SEQ_ROW_OVERFLOW_STEP);
      setTempWidth(candidate);
      if (!hasSequencerRowOverflow()) break;
    }
  }

  panel.style.width = prevWidth;
  panel.style.minWidth = prevMinWidth;
  return candidate;
}

function setSequencerPanelOpen(open) {
  ui.seqPanelOpen = open;
  const workspace = document.getElementById('app-workspace');
  const toggleBtn = document.getElementById('btn-toggle-sequencer');
  const panel = document.getElementById('sequencer-panel');
  if (workspace) workspace.classList.toggle('seq-open', open);
  if (workspace) workspace.classList.toggle('seq-editor-open', open && ui.seqEditorOpen && !!ui.currentSeqId);
  if (toggleBtn) toggleBtn.textContent = open ? 'Hide Sequencer' : 'Show Sequencer';
  if (panel) panel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

function setSequenceEditorOpen(open) {
  ui.seqEditorOpen = !!open;
  const editor = document.getElementById('seq-editor');
  const panel = document.getElementById('sequencer-panel');
  const workspace = document.getElementById('app-workspace');
  const hasEditor = !!ui.seqEditorOpen && !!ui.currentSeqId;
  if (editor) editor.hidden = !ui.seqEditorOpen || !ui.currentSeqId;
  if (panel) {
    panel.classList.toggle('editor-open', hasEditor);
    if (window.innerWidth <= 980) {
      panel.style.width = '';
      panel.style.minWidth = '';
    } else if (hasEditor) {
      const expanded = Number.isFinite(ui.seqPanelWidth) ? ui.seqPanelWidth : panel.getBoundingClientRect().width;
      const { minWidth, maxWidth } = getSequencerEditorWidthBounds();
      const bounded = resolvePanelWidthForRowVisibility(panel, Math.round(expanded), { minWidth, maxWidth });
      ui.seqPanelWidth = bounded;
      panel.style.width = `${bounded}px`;
      panel.style.minWidth = `${bounded}px`;
    } else {
      const current = panel.getBoundingClientRect().width;
      if (Number.isFinite(current) && current > SEQ_LIST_ONLY_WIDTH + 20) {
        ui.seqPanelWidth = Math.round(current);
      }
      panel.style.width = `${SEQ_LIST_ONLY_WIDTH}px`;
      panel.style.minWidth = `${SEQ_LIST_ONLY_WIDTH}px`;
    }
  }
  if (workspace) workspace.classList.toggle('seq-editor-open', ui.seqPanelOpen && hasEditor);
}

function syncSeqDefaultCrossfadeUI(seq) {
  const slider = document.getElementById('seq-default-crossfade');
  const display = document.getElementById('seq-default-crossfade-display');
  const sec = seq ? Math.max(0, seq.defaultCrossfade || 0) : 0;
  if (slider) slider.value = String(Math.round(sec * 10));
  if (display) display.textContent = `${sec.toFixed(1)} s`;
}

function queueAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveAutosave();
  }, AUTOSAVE_INTERVAL_MS);
}

function saveAutosave() {
  const payload = {
    version: 1,
    pads: data.pads,
    sequences: data.sequences,
    ui: {
      currentSeqId: ui.currentSeqId,
      seqPanelOpen: !!ui.seqPanelOpen,
      seqEditorOpen: !!ui.seqEditorOpen,
      seqPanelWidth: Number.isFinite(ui.seqPanelWidth) ? ui.seqPanelWidth : null,
    },
    savedAt: Date.now(),
  };

  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Autosave failed:', e);
  }
}

function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;

    data.pads = Array.isArray(saved.pads) ? saved.pads : [];
    data.sequences = Array.isArray(saved.sequences) ? saved.sequences : [];

    const savedUi = saved.ui || {};
    ui.currentSeqId = typeof savedUi.currentSeqId === 'string' ? savedUi.currentSeqId : null;
    ui.seqPanelOpen = typeof savedUi.seqPanelOpen === 'boolean' ? savedUi.seqPanelOpen : true;
    ui.seqEditorOpen = typeof savedUi.seqEditorOpen === 'boolean' ? savedUi.seqEditorOpen : false;
    ui.seqPanelWidth = Number.isFinite(savedUi.seqPanelWidth) ? savedUi.seqPanelWidth : null;
  } catch (e) {
    console.warn('Autosave restore failed:', e);
  }
}

function makePad(overrides = {}) {
  return {
    id:       uuid(),
    label:    'New Sound',
    filePath: '',
    color:    '#3b82f6',
    volume:   0.8,
    fadeIn:   0,
    fadeOut:  0,
    loop:     false,
    retrigger: false,
    ...overrides,
  };
}

function makeSeq(name = 'New Sequence') {
  return { id: uuid(), name, defaultCrossfade: 0, steps: [] };
}

function makeStep(overrides = {}) {
  return {
    id:            uuid(),
    padId:         '',
    duration:      null,   // null = full length
    crossfadeNext: null,   // null = sequence default
    ...overrides,
  };
}

function normalizePad(pad) {
  if (typeof pad.retrigger !== 'boolean') pad.retrigger = false;
  delete pad.defaultCrossfade;
  delete pad.playDuration;
}

function normalizeSeq(seq) {
  if (typeof seq.defaultCrossfade !== 'number') seq.defaultCrossfade = 0;
  if (!Array.isArray(seq.steps)) seq.steps = [];
  seq.steps.forEach(step => {
    if (!Object.prototype.hasOwnProperty.call(step, 'crossfadeNext')) step.crossfadeNext = null;
    if (step.crossfadeNext !== null && typeof step.crossfadeNext !== 'number') {
      step.crossfadeNext = 0;
    }
  });
}

function formatSec(sec) {
  if (!Number.isFinite(sec) || sec <= 0) return 'Unknown';
  const whole = Math.round(sec);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatDurationClock(sec) {
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

async function getPadDurationSec(pad) {
  if (!pad?.filePath) return null;
  const howl = rt.howls[pad.id] || await ensureHowl(pad);
  const dur = howl?.duration();
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

function getEffectiveStepCrossfade(step, seq) {
  if (step.crossfadeNext != null) return Math.max(0, step.crossfadeNext);
  return Math.max(0, seq.defaultCrossfade || 0);
}

// ═══════════════════════════════════════════════════════════════
//  HOWLER MANAGEMENT
// ═══════════════════════════════════════════════════════════════

async function ensureHowl(pad) {
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
    const howl = new Howl({
      src: [dataUrl],
      loop: pad.loop,
      preload: true,
      onload() {
        setPadLoading(pad.id, false);
        rt.howls[pad.id] = howl;
        rt.padDurSec[pad.id] = howl.duration();
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

/** Tear down Howl for a pad (call when pad settings change) */
function invalidateHowl(padId) {
  stopPad(padId);
  if (rt.howls[padId]) {
    rt.howls[padId].unload();
    delete rt.howls[padId];
  }
  delete rt.padDurSec[padId];
  updatePadDurationInCard(padId);
}

// ═══════════════════════════════════════════════════════════════
//  PLAYBACK
// ═══════════════════════════════════════════════════════════════

async function playPad(padId) {
  const pad = getPad(padId);
  if (!pad || !pad.filePath) return;

  // If already playing, either retrigger or stop (toggle)
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

  // Apply current master volume — Howler global volume
  Howler.volume(rt.master);

  const startVol = pad.fadeIn > 0 ? 0 : pad.volume;
  howl.volume(startVol);

  const soundId = howl.play();
  const timers = [];
  rt.active[padId] = { soundId, timers };
  updatePadUI(padId);

  // Fade in
  if (pad.fadeIn > 0) {
    howl.fade(0, pad.volume, pad.fadeIn * 1000, soundId);
  }

  // Schedule natural fade‑out (fires before the sound's own end)
  if (pad.fadeOut > 0 && !pad.loop) {
    const dur = howl.duration(soundId);
    if (dur > pad.fadeOut) {
      const delay = (dur - pad.fadeOut) * 1000;
      const t = setTimeout(() => {
        if (rt.active[padId]?.soundId === soundId && howl.playing(soundId)) {
          howl.fade(pad.volume, 0, pad.fadeOut * 1000, soundId);
        }
      }, delay);
      timers.push(t);
    }
  }

  // Cleanup on end
  howl.once('end', (id) => {
    if (id === soundId) {
      clearPadActive(padId);
      updatePadUI(padId);
    }
  });
}

function stopPad(padId, fadeMs = 0) {
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

function stopAll() {
  Object.keys(rt.active).forEach(id => stopPad(id));
  stopSequencer();
}

function clearPadActive(padId) {
  const entry = rt.active[padId];
  if (entry) entry.timers.forEach(t => clearTimeout(t));
  delete rt.active[padId];
}

// ═══════════════════════════════════════════════════════════════
//  SEQUENCER
// ═══════════════════════════════════════════════════════════════

async function playSequence(seqId) {
  stopSequencer();
  const seq = getSeq(seqId);
  if (!seq || seq.steps.length === 0) return;

  rt.seqState = 'playing';
  rt.seqId    = seqId;
  rt.seqStep  = -1;

  // Pre‑load all pads used in this sequence
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
async function advanceSequencer(stepIdx, crossfadeInMs) {
  if (rt.seqState !== 'playing') return;
  const seq = getSeq(rt.seqId);
  if (!seq || stepIdx >= seq.steps.length) {
    finishSequencer();
    return;
  }

  // Clear previous step timers (except any lingering fade-out that's already started)
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

  Howler.volume(rt.master);
  const fadeInMs = Math.max(crossfadeInMs, pad.fadeIn * 1000);
  howl.volume(fadeInMs > 0 ? 0 : pad.volume);
  const soundId = howl.play();

  if (fadeInMs > 0) {
    howl.fade(0, pad.volume, fadeInMs, soundId);
  }

  // Duration of this step: either user-set or natural sound length
  const naturalDur = howl.duration(soundId);
  const stepDurSec = (step.duration != null && step.duration > 0)
    ? step.duration
    : (!pad.loop ? naturalDur : null);  // null = manual advance for loops with no duration

  const crossfadeOutMs = getEffectiveStepCrossfade(step, seq) * 1000;
  const crossfadeOutSec = crossfadeOutMs / 1000;

  function scheduleTransition() {
    if (stepDurSec == null) return; // loop waiting for manual Next

    // Time at which we start the crossfade / next step
    const transitionAt = Math.max(0, stepDurSec - crossfadeOutSec) * 1000;

    // If no crossfade, also schedule pad fade-out just before natural end
    if (crossfadeOutMs === 0 && pad.fadeOut > 0 && stepDurSec > pad.fadeOut) {
      const foAt = (stepDurSec - pad.fadeOut) * 1000;
      rt.seqTimers.push(setTimeout(() => {
        if (howl.playing(soundId))
          howl.fade(pad.volume, 0, pad.fadeOut * 1000, soundId);
      }, foAt));
    }

    rt.seqTimers.push(setTimeout(async () => {
      if (rt.seqState !== 'playing' || rt.seqStep !== stepIdx) return;

      // Start fading out current step
      if (crossfadeOutMs > 0 && howl.playing(soundId)) {
        howl.fade(pad.volume, 0, crossfadeOutMs, soundId);
        // Stop after fade finishes
        rt.seqTimers.push(setTimeout(() => howl.stop(soundId), crossfadeOutMs));
      } else {
        // Natural end or was already going to end; stop after step duration
        if (step.duration != null && howl.playing(soundId)) {
          howl.stop(soundId);
        }
      }

      await advanceSequencer(stepIdx + 1, crossfadeOutMs);
    }, transitionAt));
  }

  scheduleTransition();

  // For non-looping sounds with no crossfade: also listen for the 'end' event
  if (!pad.loop && crossfadeOutMs === 0) {
    howl.once('end', async (id) => {
      if (id !== soundId) return;
      if (rt.seqState !== 'playing' || rt.seqStep !== stepIdx) return;
      await advanceSequencer(stepIdx + 1, 0);
    });
  }

  // Store soundId so forceNext can stop it
  rt.seqCurrentSoundId = soundId;
  rt.seqCurrentHowl    = howl;
}

function forceNextStep() {
  if (rt.seqState !== 'playing') return;
  const seq    = getSeq(rt.seqId);
  const step   = seq?.steps[rt.seqStep];
  const fadeMs = (step && seq) ? getEffectiveStepCrossfade(step, seq) * 1000 : 0;

  // Fade out current
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

function stopSequencer() {
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

function finishSequencer() {
  rt.seqState = 'idle';
  rt.seqStep  = -1;
  updateSeqStepHighlight();
  updateSeqTransportUI();
}

// ═══════════════════════════════════════════════════════════════
//  PROGRESS RAF
// ═══════════════════════════════════════════════════════════════

function startProgressLoop() {
  if (rt.progressRaf) return;
  function loop() {
    for (const [padId, entry] of Object.entries(rt.active)) {
      const howl = rt.howls[padId];
      const pad  = getPad(padId);
      if (!howl || !pad || !howl.playing(entry.soundId)) continue;
      const seek = howl.seek(entry.soundId);
      const dur  = howl.duration(entry.soundId);
      if (!dur) continue;
      const pct = Math.min(100, (seek / dur) * 100);
      const el = document.querySelector(`.pad-card[data-pad-id="${padId}"] .pad-progress`);
      if (el) el.style.width = pct + '%';
    }
    rt.progressRaf = requestAnimationFrame(loop);
  }
  rt.progressRaf = requestAnimationFrame(loop);
}

// ═══════════════════════════════════════════════════════════════
//  PAD UI RENDERING
// ═══════════════════════════════════════════════════════════════

function renderPadGrid() {
  const grid   = document.getElementById('pad-grid');
  const addBtn = document.getElementById('btn-grid-add');
  let marker = document.getElementById('pad-drop-marker');

  if (!marker) {
    marker = document.createElement('div');
    marker.id = 'pad-drop-marker';
    marker.className = 'pad-drop-marker';
    grid.appendChild(marker);
  }

  // Remove old pad cards
  grid.querySelectorAll('.pad-card').forEach(el => el.remove());
  // Insert new ones before the add button
  data.pads.forEach(pad => {
    const card = buildPadCard(pad);
    grid.insertBefore(card, addBtn);
  });

  grid.appendChild(marker);
}

function syncPadOrderFromDom() {
  const grid = document.getElementById('pad-grid');
  const ids = Array.from(grid.querySelectorAll('.pad-card')).map(el => el.dataset.padId);
  const indexMap = new Map(ids.map((id, i) => [id, i]));
  data.pads.sort((a, b) => (indexMap.get(a.id) ?? 0) - (indexMap.get(b.id) ?? 0));
}

function clearPadDropIndicator() {
  const marker = document.getElementById('pad-drop-marker');
  const zone = document.getElementById('seq-drop-zone');
  const stepMarker = document.getElementById('seq-step-drop-marker');
  if (marker) {
    marker.hidden = true;
    marker.style.transform = '';
    marker.style.height = '';
  }
  if (zone) zone.classList.remove('active');
  if (stepMarker) {
    stepMarker.hidden = true;
    stepMarker.style.top = '';
  }
  document.querySelectorAll('.seq-list-item.drop-target').forEach(el => el.classList.remove('drop-target'));
}

function setPadDropIndicator(dropTarget) {
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
    const list = document.getElementById('seq-steps');
    const marker = document.getElementById('seq-step-drop-marker');
    if (!list || !marker) return;

    const listRect = list.getBoundingClientRect();
    let markerTop = 0;

    if (dropTarget.rowElement) {
      const rowRect = dropTarget.rowElement.getBoundingClientRect();
      markerTop = rowRect.top - listRect.top + list.scrollTop + (dropTarget.position === 'after' ? rowRect.height : 0);
    } else {
      markerTop = list.scrollHeight;
    }

    marker.hidden = false;
    marker.style.top = `${Math.max(0, markerTop - 1)}px`;
    return;
  }
  const grid = document.getElementById('pad-grid');
  const marker = document.getElementById('pad-drop-marker');
  if (!grid || !marker) return;

  const gridRect = grid.getBoundingClientRect();
  const styles = getComputedStyle(grid);
  const columnGap = parseFloat(styles.columnGap || styles.gap || '14') || 14;

  let targetRect = null;
  let markerX = 0;

  if (dropTarget.type === 'card' && dropTarget.element) {
    targetRect = dropTarget.element.getBoundingClientRect();
    markerX = dropTarget.position === 'before'
      ? targetRect.left - gridRect.left - (columnGap / 2)
      : targetRect.right - gridRect.left + (columnGap / 2);
  } else if (dropTarget.type === 'end') {
    const addBtn = document.getElementById('btn-grid-add');
    if (!addBtn) return;
    targetRect = addBtn.getBoundingClientRect();
    markerX = targetRect.left - gridRect.left - (columnGap / 2);
  }

  if (!targetRect) return;

  const markerY = targetRect.top - gridRect.top + 10;
  const markerHeight = Math.max(24, targetRect.height - 20);
  marker.hidden = false;
  marker.style.transform = `translate(${markerX}px, ${markerY}px)`;
  marker.style.height = `${markerHeight}px`;
}

function getPadDropTarget(clientX, clientY, sourceId) {
  const sourceEl = document.querySelector(`.pad-card[data-pad-id="${sourceId}"]`);
  const hit = document.elementFromPoint(clientX, clientY);
  const addBtn = document.getElementById('btn-grid-add');
  const sequenceDropZone = document.getElementById('seq-drop-zone');
  const sequenceListRow = hit?.closest('.seq-list-item');
  const stepRow = hit?.closest('.seq-step-row');

  if (sequenceListRow?.dataset.seqId) {
    return { type: 'sequence-list', sequenceId: sequenceListRow.dataset.seqId };
  }

  if (ui.currentSeqId && stepRow) {
    const rowRect = stepRow.getBoundingClientRect();
    return {
      type: 'sequence-step',
      sequenceId: ui.currentSeqId,
      stepId: stepRow.dataset.stepId,
      rowElement: stepRow,
      position: clientY < rowRect.top + rowRect.height / 2 ? 'before' : 'after',
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
    const rect = targetCard.getBoundingClientRect();
    let position;

    if (clientY >= rect.top && clientY <= rect.bottom) {
      position = clientX < rect.left + rect.width / 2 ? 'before' : 'after';
    } else {
      position = clientY < rect.top + rect.height / 2 ? 'before' : 'after';
    }

    return {
      type: 'card',
      element: targetCard,
      targetId: targetCard.dataset.padId,
      position,
    };
  }

  return { type: 'end' };
}

function createPadDragGhost(sourceEl, clientX, clientY, startX, startY) {
  const rect = sourceEl.getBoundingClientRect();
  const ghost = sourceEl.cloneNode(true);
  ghost.classList.add('pad-drag-ghost');
  ghost.classList.remove('playing', 'loading', 'drop-before', 'drop-after', 'drag-source');
  ghost.style.width = `${rect.width}px`;
  ghost.style.height = `${rect.height}px`;
  ghost.style.left = '0px';
  ghost.style.top = '0px';
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

function updatePadDurationInCard(padId) {
  const el = document.querySelector(`.pad-card[data-pad-id="${padId}"] .pad-play-duration`);
  if (!el) return;
  const sec = rt.padDurSec[padId];
  const txt = formatDurationClock(sec);
  el.textContent = txt || '\u00A0';
}

async function hydratePadDuration(padId) {
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

function buildPadCard(pad) {
  const div = document.createElement('div');
  div.className = 'pad-card';
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

  // Drag-to-reorder starts only from non-interactive regions and only after a small movement threshold.
  const interactiveSelector = '.pad-play-body, .pad-settings-btn, .pad-toggle-btn, .pad-vol-slider, .pad-fi-slider, .pad-fo-slider, input, button, select, [role="button"]';

  div.addEventListener('pointerdown', e => {
    if (e.button !== 0) {
      ui.padDrag = null;
      return;
    }
    if (e.target.closest(interactiveSelector)) {
      ui.padDrag = null;
      return;
    }
    ui.padDrag = {
      sourceId: pad.id,
      sourceEl: div,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      offsetX: 0,
      offsetY: 0,
      ghost: null,
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
      ui.padDrag.ghost = createPadDragGhost(div, e.clientX, e.clientY, ui.padDrag.startX, ui.padDrag.startY);
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

    try {
      div.releasePointerCapture(ui.padDrag.pointerId);
    } catch (_) {
      // Ignore release errors when capture is already gone.
    }
    ui.padDrag = null;
  }

  div.addEventListener('pointerup', finishPointerDrag, true);
  div.addEventListener('pointercancel', finishPointerDrag, true);

  div.addEventListener('lostpointercapture', () => {
    if (!ui.padDrag || ui.padDrag.sourceId !== pad.id) return;
    clearPadDropIndicator();
    destroyPadDragGhost();
    div.classList.remove('drag-source');
    ui.padDrag = null;
  }, true);

  div.addEventListener('dragstart', e => {
    // Disable browser-native drag image behavior; we handle reordering with pointer events.
    e.preventDefault();
  });

  div.querySelector('.pad-play-body').addEventListener('click', () => playPad(pad.id));
  div.querySelector('.pad-play-body').addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      playPad(pad.id);
    }
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
    if (rt.howls[pad.id]) {
      rt.howls[pad.id].loop(p.loop);
    }
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
      // Update Howler volume if currently playing
      const entry = rt.active[pad.id];
      if (entry && rt.howls[pad.id]) {
        rt.howls[pad.id].volume(v, entry.soundId);
      }
      queueAutosave();
    }
  });

  const fiSlider = div.querySelector('.pad-fi-slider');
  const fiLabel  = div.querySelector('.pad-fi-label');
  fiSlider.addEventListener('input', () => {
    const sec = sliderToSec(+fiSlider.value);
    fiLabel.textContent = sec.toFixed(1) + ' s';
    const p = getPad(pad.id);
    if (p) {
      p.fadeIn = sec;
      queueAutosave();
    }
  });

  const foSlider = div.querySelector('.pad-fo-slider');
  const foLabel  = div.querySelector('.pad-fo-label');
  foSlider.addEventListener('input', () => {
    const sec = sliderToSec(+foSlider.value);
    foLabel.textContent = sec.toFixed(1) + ' s';
    const p = getPad(pad.id);
    if (p) {
      p.fadeOut = sec;
      queueAutosave();
    }
  });

  refreshPadStatus(div, pad.id);
  updatePadDurationInCard(pad.id);
  hydratePadDuration(pad.id);

  return div;
}

function updatePadUI(padId) {
  const card = document.querySelector(`.pad-card[data-pad-id="${padId}"]`);
  if (!card) return;
  const playing = !!rt.active[padId];
  card.classList.toggle('playing', playing);
  refreshPadStatus(card, padId);
  const progressEl = card.querySelector('.pad-play-body .pad-progress');
  if (progressEl && !playing) progressEl.style.width = '0%';
}

function setPadLoading(padId, loading) {
  const card = document.querySelector(`.pad-card[data-pad-id="${padId}"]`);
  if (card) {
    card.classList.toggle('loading', loading);
    refreshPadStatus(card, padId);
  }
}

function refreshPadStatus(card, padId) {
  const pad = getPad(padId);
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

  statusEl.textContent = statusText;
  statusEl.dataset.state = statusText.toLowerCase().replace(/\s+/g, '-');
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ═══════════════════════════════════════════════════════════════
//  SEQUENCER UI
// ═══════════════════════════════════════════════════════════════

function renderSeqList() {
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

function renderSeqOverview() {
  const nameEl = document.getElementById('seq-current-name');
  const metaEl = document.getElementById('seq-current-meta');
  const openBtn = document.getElementById('btn-seq-open-editor');
  const seq = getSeq(ui.currentSeqId);

  if (!seq) {
    if (nameEl) nameEl.textContent = 'No sequence selected';
    if (metaEl) metaEl.textContent = 'Select a sequence to play, then open the editor only when you need step changes.';
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

function selectSequence(seqId, options = {}) {
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

function insertPadIntoSequence(sequenceId, padId, dropTarget = null) {
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

function openSeqEditor(seqId) {
  setSequencerPanelOpen(true);
  selectSequence(seqId, { openEditor: true });
}

function renderSeqSteps() {
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

    const colorDot = pad
      ? `<span class="step-color-dot" style="background:${pad.color}"></span>`
      : '';
    const soundName = pad ? escHtml(pad.label) : '<em>Unknown</em>';
    const soundDur = pad ? (formatDurationClock(rt.padDurSec[pad.id]) || '--.---') : '';
    const durVal  = step.duration != null ? step.duration : '';
    const hasOverride = step.crossfadeNext != null;
    const cfVal = hasOverride ? step.crossfadeNext : '';
    const effectiveCf = getEffectiveStepCrossfade(step, seq);
    const cfHint = hasOverride
      ? `<span class="step-cf-mode">Override</span>`
      : `<span class="step-cf-mode">Default ${effectiveCf.toFixed(1)} s</span>`;

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

    li.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      if (e.target.closest('input, button, select, textarea')) return;
      if (!e.target.closest('.step-drag-handle')) return;

      stepDrag = {
        pointerId: e.pointerId,
        sourceStepId: step.id,
        sourceEl: li,
        startX: e.clientX,
        startY: e.clientY,
        started: false,
        targetStepId: null,
        position: 'after',
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

      const rect = hitRow.getBoundingClientRect();
      const before = e.clientY < rect.top + rect.height / 2;
      stepDrag.targetStepId = hitRow.dataset.stepId;
      stepDrag.position = before ? 'before' : 'after';
      hitRow.classList.add(before ? 'drop-before' : 'drop-after');
    });

    const finishStepDrag = e => {
      if (!stepDrag || stepDrag.pointerId !== e.pointerId || stepDrag.sourceStepId !== step.id) return;

      const drag = stepDrag;
      stepDrag = null;

      clearStepDragClasses();

      if (!drag.started || !drag.targetStepId) {
        try {
          li.releasePointerCapture(e.pointerId);
        } catch (_) {
          // Ignore release errors.
        }
        return;
      }

      const fromIndex = seq.steps.findIndex(s => s.id === drag.sourceStepId);
      const targetIndex = seq.steps.findIndex(s => s.id === drag.targetStepId);
      if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
        try {
          li.releasePointerCapture(e.pointerId);
        } catch (_) {
          // Ignore release errors.
        }
        return;
      }

      const [moved] = seq.steps.splice(fromIndex, 1);
      let insertIndex = targetIndex + (drag.position === 'after' ? 1 : 0);
      if (fromIndex < targetIndex) insertIndex -= 1;
      seq.steps.splice(Math.max(0, Math.min(seq.steps.length, insertIndex)), 0, moved);

      try {
        li.releasePointerCapture(e.pointerId);
      } catch (_) {
        // Ignore release errors.
      }

      renderSeqSteps();
      renderSeqList();
      queueAutosave();
    };

    li.addEventListener('pointerup', finishStepDrag);
    li.addEventListener('pointercancel', finishStepDrag);
    li.addEventListener('lostpointercapture', e => {
      if (!stepDrag || stepDrag.pointerId !== e.pointerId || stepDrag.sourceStepId !== step.id) return;
      stepDrag = null;
      clearStepDragClasses();
    });

    li.querySelector('.step-dur-input').addEventListener('input', e => {
      step.duration = sliderToDurationSec(+e.target.value);
      const label = li.querySelector('.step-dur-value');
      if (label) label.textContent = step.duration != null ? `${step.duration.toFixed(1)} s` : 'Full';
      queueAutosave();
    });
    li.querySelector('.step-cf-input').addEventListener('input', e => {
      const raw = Number(e.target.value);
      step.crossfadeNext = raw > 0 ? sliderToSec(raw) : null;
      const valLabel = li.querySelector('.step-cf-value');
      const modeLabel = li.querySelector('.step-cf-mode');
      if (valLabel) valLabel.textContent = step.crossfadeNext != null ? `${step.crossfadeNext.toFixed(1)} s` : 'Default';
      if (modeLabel) {
        const activeSeq = getSeq(ui.currentSeqId);
        const effective = activeSeq ? getEffectiveStepCrossfade(step, activeSeq) : 0;
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

function updateSeqStepHighlight() {
  document.querySelectorAll('.seq-step-row').forEach((row, i) => {
    row.classList.toggle('playing-step',
      rt.seqState === 'playing' && rt.seqId === ui.currentSeqId && i === rt.seqStep);
  });
}

function updateSeqTransportUI() {
  const hasSelection = !!ui.currentSeqId;
  const playing = rt.seqState === 'playing' && rt.seqId === ui.currentSeqId;
  const playBtn = document.getElementById('btn-seq-play');
  const stopBtn = document.getElementById('btn-seq-stop');
  const nextBtn = document.getElementById('btn-seq-next');
  if (playBtn) playBtn.disabled = !hasSelection || playing;
  if (stopBtn) stopBtn.disabled = !playing;
  if (nextBtn) nextBtn.disabled = !playing;
  renderSeqList();
}

// ═══════════════════════════════════════════════════════════════
//  PAD MODAL
// ═══════════════════════════════════════════════════════════════

function openPadModal(padId) {
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

function openNewPadModal(filePath = '', label = '') {
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

function closePadModal() {
  document.getElementById('pad-modal').hidden = true;
  ui.editingPadId = null;
}

function syncPadModalDisplays() {
  const vol     = +document.getElementById('pad-volume').value;
  const fadeIn  = +document.getElementById('pad-fadein').value;
  const fadeOut = +document.getElementById('pad-fadeout').value;
  document.getElementById('pad-vol-display').textContent     = vol + '%';
  document.getElementById('pad-fadein-display').textContent  = sliderToSec(fadeIn).toFixed(1) + ' s';
  document.getElementById('pad-fadeout-display').textContent = sliderToSec(fadeOut).toFixed(1) + ' s';
}

async function updatePadDurationDisplay(filePath, labelHint = '') {
  const durationEl = document.getElementById('pad-duration-display');
  if (!durationEl) return;
  if (!filePath) {
    durationEl.textContent = 'Length: Unknown';
    return;
  }

  durationEl.textContent = 'Length: Loading...';
  const tempPad = makePad({ id: '__preview__', filePath, label: labelHint || 'Preview' });
  const dur = await getPadDurationSec(tempPad);
  durationEl.textContent = 'Length: ' + formatSec(dur);
  if (rt.howls[tempPad.id]) {
    rt.howls[tempPad.id].unload();
    delete rt.howls[tempPad.id];
  }
}

function syncSwatches(hexColor) {
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === hexColor);
  });
}

function getPadModalValues() {
  return {
    color: document.getElementById('pad-color').value,
    volume: sliderToVol(+document.getElementById('pad-volume').value),
    fadeIn: sliderToSec(+document.getElementById('pad-fadein').value),
    fadeOut: sliderToSec(+document.getElementById('pad-fadeout').value),
    loop: document.getElementById('pad-loop').checked,
    retrigger: document.getElementById('pad-retrigger').checked,
  };
}

function addPadsFromFiles(filePaths) {
  const baseValues = getPadModalValues();
  const newPads = filePaths.map((filePath, index) => makePad({
    ...baseValues,
    color: index === 0 ? baseValues.color : randomColor(),
    filePath,
    label: basename(filePath).replace(/\.[^.]+$/, ''),
  }));

  data.pads.push(...newPads);
  renderPadGrid();
  queueAutosave();
}

function savePadModal() {
  const label    = document.getElementById('pad-label').value.trim() || 'New Sound';
  const filePath = document.getElementById('pad-filepath').value;
  const { color, volume, fadeIn, fadeOut, loop, retrigger } = getPadModalValues();

  if (ui.editingPadId) {
    const pad    = getPad(ui.editingPadId);
    const reload = pad.filePath !== filePath || pad.loop !== loop;
    pad.label    = label;
    pad.color    = color;
    pad.filePath = filePath;
    pad.volume   = volume;
    pad.fadeIn   = fadeIn;
    pad.fadeOut  = fadeOut;
    pad.loop     = loop;
    pad.retrigger = retrigger;
    if (reload) invalidateHowl(pad.id);
    // Re-render this pad card
    const oldCard = document.querySelector(`.pad-card[data-pad-id="${pad.id}"]`);
    if (oldCard) {
      const newCard = buildPadCard(pad);
      oldCard.parentNode.replaceChild(newCard, oldCard);
    }
  } else {
    const pad = makePad({ label, color, filePath, volume, fadeIn, fadeOut, loop, retrigger });
    data.pads.push(pad);
    const grid   = document.getElementById('pad-grid');
    const addBtn = document.getElementById('btn-grid-add');
    grid.insertBefore(buildPadCard(pad), addBtn);
  }

  closePadModal();
  queueAutosave();
}

function deletePad(padId) {
  invalidateHowl(padId);
  data.pads = data.pads.filter(p => p.id !== padId);
  // Remove from all sequences
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

// ═══════════════════════════════════════════════════════════════
//  ADD STEP MODAL
// ═══════════════════════════════════════════════════════════════

function openStepModal() {
  const sel = document.getElementById('step-pad-select');
  const seq = getSeq(ui.currentSeqId);
  sel.innerHTML = '';
  data.pads.forEach(pad => {
    const opt = document.createElement('option');
    opt.value       = pad.id;
    opt.textContent = pad.label;
    sel.appendChild(opt);
  });
  if (data.pads.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'No sounds added yet';
    opt.disabled = true;
    sel.appendChild(opt);
  }
  document.getElementById('step-duration').value  = '';
  document.getElementById('step-crossfade').value = '';
  document.getElementById('step-crossfade').placeholder = seq ? `Default ${seq.defaultCrossfade.toFixed(1)} s` : 'Default';
  updateStepModalDuration();
  document.getElementById('step-modal').hidden = false;
}

async function updateStepModalDuration() {
  const sel = document.getElementById('step-pad-select');
  const label = document.getElementById('step-pad-duration');
  const seq = getSeq(ui.currentSeqId);
  const pad = getPad(sel.value);
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

function closeStepModal() {
  document.getElementById('step-modal').hidden = true;
}

function saveStepModal() {
  const padId      = document.getElementById('step-pad-select').value;
  const durVal     = document.getElementById('step-duration').value.trim();
  const cfVal      = document.getElementById('step-crossfade').value.trim();
  const duration   = durVal === '' ? null : parseFloat(durVal);
  const crossfade  = cfVal === '' ? null : Math.max(0, parseFloat(cfVal) || 0);

  const seq = getSeq(ui.currentSeqId);
  if (!seq || !padId) return;

  seq.steps.push(makeStep({ padId, duration, crossfadeNext: crossfade }));
  renderSeqSteps();
  renderSeqList();
  renderSeqOverview();
  closeStepModal();
  queueAutosave();
}

// ═══════════════════════════════════════════════════════════════
//  PERSISTENCE  (save / open / new)
// ═══════════════════════════════════════════════════════════════

async function saveProject() {
  const path = await dialogSave({
    title: 'Save Soundboard Project',
    filters: [{ name: 'Soundboard Project', extensions: ['sbp', 'json'] }],
    defaultPath: 'project.sbp',
  });
  if (!path) return;
  const content = JSON.stringify({ version: 1, pads: data.pads, sequences: data.sequences }, null, 2);
  try {
    await invoke('save_project', { path, content });
  } catch (e) {
    alert('Failed to save: ' + e);
  }
}

async function openProject() {
  const selected = await dialogOpen({
    title: 'Open Soundboard Project',
    multiple: false,
    filters: [{ name: 'Soundboard Project', extensions: ['sbp', 'json'] }],
  });
  if (!selected) return;
  try {
    const raw = await invoke('load_project', { path: selected });
    const saved = JSON.parse(raw);
    stopAll();
    // Unload all Howls
    Object.values(rt.howls).forEach(h => h.unload());
    rt.howls  = {};
    rt.active = {};
    data.pads      = saved.pads      || [];
    data.sequences = saved.sequences || [];
    data.pads.forEach(normalizePad);
    data.sequences.forEach(normalizeSeq);
    ui.currentSeqId = null;
    ui.seqEditorOpen = false;
    renderPadGrid();
    renderSeqList();
    setSequenceEditorOpen(false);
    renderSeqOverview();
    updateSeqTransportUI();
    queueAutosave();
  } catch (e) {
    alert('Failed to open: ' + e);
  }
}

function newProject() {
  if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
  stopAll();
  Object.values(rt.howls).forEach(h => h.unload());
  rt.howls  = {};
  rt.active = {};
  data.pads      = [];
  data.sequences = [];
  ui.currentSeqId = null;
  ui.seqEditorOpen = false;
  renderPadGrid();
  renderSeqList();
  setSequenceEditorOpen(false);
  renderSeqOverview();
  updateSeqTransportUI();
  queueAutosave();
}

// ═══════════════════════════════════════════════════════════════
//  MISC HELPERS
// ═══════════════════════════════════════════════════════════════

const COLORS = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6','#8b5cf6','#ec4899','#14b8a6','#f59e0b','#64748b'];
let _colorIdx = 0;
function randomColor() { return COLORS[_colorIdx++ % COLORS.length]; }

// ═══════════════════════════════════════════════════════════════
//  BOOT
// ═══════════════════════════════════════════════════════════════

window.addEventListener('DOMContentLoaded', () => {
  loadAutosave();

  // ── Header buttons ────────────────────────────────────────
  document.getElementById('btn-new').addEventListener('click', newProject);
  document.getElementById('btn-open').addEventListener('click', openProject);
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-stop-all').addEventListener('click', stopAll);
  document.getElementById('btn-toggle-sequencer').addEventListener('click', () => {
    setSequencerPanelOpen(!ui.seqPanelOpen);
    queueAutosave();
  });

  const seqResizer = document.getElementById('seq-resizer');
  const seqPanel = document.getElementById('sequencer-panel');
  if (seqResizer && seqPanel) {
    let resizeState = null;
    let widthRaf = 0;
    let pendingWidth = null;
    let resizeOverflowFloor = null;

    const applyPanelWidth = (width, options = {}) => {
      const duringResize = !!options.duringResize;
      if (!Number.isFinite(width)) return;
      const { minWidth, maxWidth } = getSequencerEditorWidthBounds();
      let bounded = Math.max(minWidth, Math.min(maxWidth, width));
      if (duringResize && Number.isFinite(resizeOverflowFloor)) {
        bounded = Math.max(bounded, resizeOverflowFloor);
      }
      const resolved = resolvePanelWidthForRowVisibility(seqPanel, bounded, { minWidth, maxWidth });
      if (duringResize) {
        if (resolved > bounded + 0.5) {
          resizeOverflowFloor = resolved;
        }
      } else {
        resizeOverflowFloor = null;
      }
      ui.seqPanelWidth = Math.round(resolved);
      seqPanel.style.width = `${ui.seqPanelWidth}px`;
      seqPanel.style.minWidth = `${ui.seqPanelWidth}px`;
    };

    const queuePanelWidth = (width, options = {}) => {
      pendingWidth = width;
      if (widthRaf) return;
      widthRaf = requestAnimationFrame(() => {
        widthRaf = 0;
        if (pendingWidth != null) {
          applyPanelWidth(pendingWidth, options);
          pendingWidth = null;
        }
      });
    };

    const syncPanelWidthForViewport = () => {
      if (window.innerWidth <= 980) {
        seqPanel.style.width = '';
        seqPanel.style.minWidth = '';
        return;
      }
      if (Number.isFinite(ui.seqPanelWidth)) {
        applyPanelWidth(ui.seqPanelWidth);
      }
    };

    syncPanelWidthForViewport();
    window.addEventListener('resize', syncPanelWidthForViewport);

    seqResizer.addEventListener('pointerdown', e => {
      if (window.innerWidth <= 980) return;
      resizeState = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startWidth: seqPanel.getBoundingClientRect().width,
      };
      resizeOverflowFloor = null;
      seqPanel.classList.add('resizing');
      seqResizer.setPointerCapture(e.pointerId);
    });

    seqResizer.addEventListener('pointermove', e => {
      if (!resizeState || e.pointerId !== resizeState.pointerId) return;
      const delta = resizeState.startX - e.clientX;
      const next = resizeState.startWidth + delta;
      queuePanelWidth(next, { duringResize: true });
    });

    const finishResize = e => {
      if (!resizeState || e.pointerId !== resizeState.pointerId) return;
      try {
        seqResizer.releasePointerCapture(e.pointerId);
      } catch (_) {
        // ignore capture release failures
      }
      if (widthRaf) {
        cancelAnimationFrame(widthRaf);
        widthRaf = 0;
      }
      if (pendingWidth != null) {
        applyPanelWidth(pendingWidth, { duringResize: true });
        pendingWidth = null;
      }
      resizeOverflowFloor = null;
      seqPanel.classList.remove('resizing');
      resizeState = null;
      queueAutosave();
    };

    seqResizer.addEventListener('pointerup', finishResize);
    seqResizer.addEventListener('pointercancel', finishResize);
  }

  document.getElementById('btn-add-pad').addEventListener('click', () => openNewPadModal());
  document.getElementById('btn-grid-add').addEventListener('click', () => openNewPadModal());

  // ── Master volume ─────────────────────────────────────────
  const masterSlider = document.getElementById('master-volume');
  const masterVal    = document.getElementById('master-volume-val');
  masterSlider.addEventListener('input', () => {
    rt.master = masterSlider.value / 100;
    masterVal.textContent = masterSlider.value + '%';
    Howler.volume(rt.master);
  });

  // ── Pad modal ─────────────────────────────────────────────
  document.getElementById('pad-modal-close').addEventListener('click',  closePadModal);
  document.getElementById('pad-modal-cancel').addEventListener('click', closePadModal);
  document.getElementById('pad-modal-backdrop').addEventListener('click', closePadModal);
  document.getElementById('pad-modal-save').addEventListener('click',   savePadModal);
  document.getElementById('pad-modal-delete').addEventListener('click', () => {
    if (ui.editingPadId && confirm('Delete this sound?')) deletePad(ui.editingPadId);
  });

  // Modal sliders live display
  document.getElementById('pad-volume').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadein').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadeout').addEventListener('input', syncPadModalDisplays);

  // Color picker ↔ swatches
  document.getElementById('pad-color').addEventListener('input', e => syncSwatches(e.target.value));
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.getElementById('pad-color').value = sw.dataset.color;
      syncSwatches(sw.dataset.color);
    });
  });

  // Browse audio file
  document.getElementById('btn-browse').addEventListener('click', async () => {
    const selected = await dialogOpen({
      title: 'Select Audio File',
      multiple: !ui.editingPadId,
      filters: [{
        name: 'Audio Files',
        extensions: ['mp3','wav','ogg','flac','aac','m4a','opus','webm'],
      }],
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
  });

  // ── Sequencer ─────────────────────────────────────────────
  document.getElementById('btn-new-seq').addEventListener('click', () => {
    const seq = makeSeq('New Sequence');
    data.sequences.push(seq);
    renderSeqList();
    openSeqEditor(seq.id);
    queueAutosave();
  });

  document.getElementById('btn-delete-seq').addEventListener('click', () => {
    if (!ui.currentSeqId) return;
    if (!confirm('Delete this sequence?')) return;
    if (rt.seqId === ui.currentSeqId) stopSequencer();
    data.sequences = data.sequences.filter(s => s.id !== ui.currentSeqId);
    const nextSeqId = data.sequences[0]?.id || null;
    if (nextSeqId) {
      selectSequence(nextSeqId, { openEditor: false });
    } else {
      ui.currentSeqId = null;
      setSequenceEditorOpen(false);
      renderSeqList();
      renderSeqOverview();
      updateSeqTransportUI();
    }
    queueAutosave();
  });

  document.getElementById('seq-name-input').addEventListener('input', e => {
    const seq = getSeq(ui.currentSeqId);
    if (seq) {
      seq.name = e.target.value;
      renderSeqList();
      renderSeqOverview();
      queueAutosave();
    }
  });

  document.getElementById('seq-default-crossfade').addEventListener('change', e => {
    const seq = getSeq(ui.currentSeqId);
    if (!seq) return;
    seq.defaultCrossfade = sliderToSec(+e.target.value);
    syncSeqDefaultCrossfadeUI(seq);
    renderSeqOverview();
    renderSeqSteps();
    queueAutosave();
  });

  document.getElementById('seq-default-crossfade').addEventListener('input', e => {
    const seq = getSeq(ui.currentSeqId);
    if (!seq) return;
    seq.defaultCrossfade = sliderToSec(+e.target.value);
    syncSeqDefaultCrossfadeUI(seq);
    renderSeqOverview();
  });

  document.getElementById('btn-add-step').addEventListener('click', openStepModal);

  // ── Step modal ────────────────────────────────────────────
  document.getElementById('step-modal-close').addEventListener('click',  closeStepModal);
  document.getElementById('step-modal-cancel').addEventListener('click', closeStepModal);
  document.getElementById('step-modal-backdrop').addEventListener('click', closeStepModal);
  document.getElementById('step-modal-save').addEventListener('click',   saveStepModal);
  document.getElementById('step-pad-select').addEventListener('change', updateStepModalDuration);

  // Ensure existing projects without new fields still behave correctly.
  data.pads.forEach(normalizePad);
  data.sequences.forEach(normalizeSeq);

  if (ui.currentSeqId && !getSeq(ui.currentSeqId)) {
    ui.currentSeqId = null;
  }
  if (!ui.currentSeqId && data.sequences.length > 0) {
    ui.currentSeqId = data.sequences[0].id;
  }

  // Initial render
  setSequencerPanelOpen(ui.seqPanelOpen);
  setSequenceEditorOpen(ui.seqEditorOpen);
  renderPadGrid();
  renderSeqList();
  renderSeqOverview();
  if (ui.currentSeqId && ui.seqEditorOpen) {
    const seq = getSeq(ui.currentSeqId);
    syncSeqDefaultCrossfadeUI(seq);
    renderSeqSteps();
  } else {
    syncSeqDefaultCrossfadeUI(getSeq(ui.currentSeqId));
  }
  updateSeqTransportUI();
  startProgressLoop();

  window.addEventListener('beforeunload', saveAutosave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveAutosave();
  });
});
