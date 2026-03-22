// ═══════════════════════════════════════════════════════════════
//  PERSISTENCE — autosave and project file save / open / new
// ═══════════════════════════════════════════════════════════════

import {
  data, rt, ui,
  AUTOSAVE_KEY, AUTOSAVE_INTERVAL_MS,
  normalizePad, normalizeSeq, makeSeq,
  invoke, dialogOpen, dialogSave,
} from './state.js';
import { stopAll } from './sequencer.js';
import { renderPadGrid } from './pad-ui.js';
import {
  renderSeqList,
  renderSeqOverview,
  updateSeqTransportUI,
} from './seq-ui.js';
import { setSequenceEditorOpen } from './resize.js';

let autosaveTimer = null;

// ── Autosave ──────────────────────────────────────────────────

export function queueAutosave() {
  if (autosaveTimer) return;
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null;
    saveAutosave();
  }, AUTOSAVE_INTERVAL_MS);
}

export function saveAutosave() {
  const payload = {
    version: 1,
    pads:    data.pads,
    sequences: data.sequences,
    ui: {
      currentSeqId:  ui.currentSeqId,
      seqPanelOpen:  !!ui.seqPanelOpen,
      seqEditorOpen: !!ui.seqEditorOpen,
      seqPanelWidth: Number.isFinite(ui.seqPanelWidth) ? ui.seqPanelWidth : null,
      loudnessTargetLufs: Number.isFinite(ui.loudnessTargetLufs) ? ui.loudnessTargetLufs : -16,
      themeKey: typeof ui.themeKey === 'string' ? ui.themeKey : 'lsu-night',
    },
    savedAt: Date.now(),
  };

  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(payload));
  } catch (e) {
    console.warn('Autosave failed:', e);
  }
}

export function loadAutosave() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object') return;

    data.pads      = Array.isArray(saved.pads)      ? saved.pads      : [];
    data.sequences = Array.isArray(saved.sequences)  ? saved.sequences : [];

    const savedUi = saved.ui || {};
    ui.currentSeqId  = typeof savedUi.currentSeqId  === 'string'  ? savedUi.currentSeqId  : null;
    ui.seqPanelOpen  = typeof savedUi.seqPanelOpen  === 'boolean' ? savedUi.seqPanelOpen  : true;
    ui.seqEditorOpen = typeof savedUi.seqEditorOpen === 'boolean' ? savedUi.seqEditorOpen : false;
    ui.seqPanelWidth = Number.isFinite(savedUi.seqPanelWidth)     ? savedUi.seqPanelWidth : null;
    ui.loudnessTargetLufs = Number.isFinite(savedUi.loudnessTargetLufs)
      ? Math.max(-36, Math.min(-6, savedUi.loudnessTargetLufs))
      : -16;
    ui.themeKey      = typeof savedUi.themeKey === 'string' ? savedUi.themeKey : 'lsu-night';
  } catch (e) {
    console.warn('Autosave restore failed:', e);
  }
}

// ── Project file save / open / new ───────────────────────────

export async function saveProject() {
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

export async function openProject() {
  const selected = await dialogOpen({
    title: 'Open Soundboard Project',
    multiple: false,
    filters: [{ name: 'Soundboard Project', extensions: ['sbp', 'json'] }],
  });
  if (!selected) return;
  try {
    const raw   = await invoke('load_project', { path: selected });
    const saved = JSON.parse(raw);
    stopAll();
    Object.values(rt.howls).forEach(h => h.unload());
    rt.howls  = {};
    rt.active = {};
    data.pads      = saved.pads      || [];
    data.sequences = saved.sequences || [];
    data.pads.forEach(normalizePad);
    data.sequences.forEach(normalizeSeq);
    // Ensure at least one sequence exists
    if (data.sequences.length === 0) {
      data.sequences.push(makeSeq('New Sequence'));
    }
    ui.currentSeqId  = data.sequences[0].id;
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

export function newProject() {
  if (!confirm('Start a new project? Unsaved changes will be lost.')) return;
  stopAll();
  Object.values(rt.howls).forEach(h => h.unload());
  rt.howls  = {};
  rt.active = {};
  data.pads      = [];
  data.sequences = [];
  // Seed a blank sequence so the UI has something to show immediately
  const defaultSeq = makeSeq('New Sequence');
  data.sequences.push(defaultSeq);
  ui.currentSeqId  = defaultSeq.id;
  ui.seqEditorOpen = false;
  renderPadGrid();
  renderSeqList();
  setSequenceEditorOpen(false);
  renderSeqOverview();
  updateSeqTransportUI();
  queueAutosave();
}
