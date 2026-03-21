// ═══════════════════════════════════════════════════════════════
//  RESIZE — sequencer panel width management
// ═══════════════════════════════════════════════════════════════

import {
  ui,
  SEQ_LIST_ONLY_WIDTH,
  SEQ_EDITOR_MIN_WIDTH,
  SOUNDBOARD_MIN_WIDTH,
  SEQ_ROW_OVERFLOW_STEP,
  SEQ_ROW_OVERFLOW_HYSTERESIS,
} from './state.js';

export function getSequencerEditorWidthBounds() {
  const hasEditor = !!ui.seqEditorOpen && !!ui.currentSeqId;
  const measuredMin = hasEditor ? SEQ_EDITOR_MIN_WIDTH : SEQ_LIST_ONLY_WIDTH;
  const viewportMax = Math.max(SEQ_LIST_ONLY_WIDTH, window.innerWidth - SOUNDBOARD_MIN_WIDTH);
  const minWidth = Math.min(measuredMin, viewportMax);
  const preferredMax = Math.round(window.innerWidth * 0.78);
  const maxWidth = Math.max(minWidth, Math.min(viewportMax, preferredMax));
  return { minWidth, maxWidth };
}

export function hasSequencerRowOverflow() {
  if (!ui.seqEditorOpen || !ui.currentSeqId) return false;
  const editor = document.getElementById('seq-editor');
  if (!editor || editor.hidden) return false;

  const rows = Array.from(editor.querySelectorAll('.seq-step-row'));
  if (rows.length === 0) return false;

  const sample = rows.length > 14 ? rows.slice(0, 14) : rows;
  return sample.some(row => (row.scrollWidth - row.clientWidth) > SEQ_ROW_OVERFLOW_HYSTERESIS);
}

export function resolvePanelWidthForRowVisibility(panel, requestedWidth, bounds) {
  let candidate = Math.max(bounds.minWidth, Math.min(bounds.maxWidth, requestedWidth));
  if (!panel || !ui.seqEditorOpen || !ui.currentSeqId || window.innerWidth <= 980) {
    return candidate;
  }

  const prevWidth    = panel.style.width;
  const prevMinWidth = panel.style.minWidth;
  const setTempWidth = width => {
    panel.style.width    = `${width}px`;
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

  panel.style.width    = prevWidth;
  panel.style.minWidth = prevMinWidth;
  return candidate;
}

export function setSequencerPanelOpen(open) {
  ui.seqPanelOpen = open;
  const workspace = document.getElementById('app-workspace');
  const toggleBtn = document.getElementById('btn-toggle-sequencer');
  const panel     = document.getElementById('sequencer-panel');
  if (workspace) workspace.classList.toggle('seq-open', open);
  if (workspace) workspace.classList.toggle('seq-editor-open', open && ui.seqEditorOpen && !!ui.currentSeqId);
  if (toggleBtn) toggleBtn.textContent = open ? 'Hide Sequencer' : 'Show Sequencer';
  if (panel)     panel.setAttribute('aria-hidden', open ? 'false' : 'true');
}

export function setSequenceEditorOpen(open) {
  const panel = document.getElementById('sequencer-panel');
  // Capture the live editor width before any class toggles can reflow layout.
  const widthBeforeToggle = panel ? panel.getBoundingClientRect().width : NaN;

  ui.seqEditorOpen = !!open;
  const editor    = document.getElementById('seq-editor');
  const workspace = document.getElementById('app-workspace');
  const hasEditor = !!ui.seqEditorOpen && !!ui.currentSeqId;

  if (editor) editor.hidden = !ui.seqEditorOpen || !ui.currentSeqId;
  if (panel) {
    panel.classList.toggle('editor-open', hasEditor);
    if (window.innerWidth <= 980) {
      panel.style.width    = '';
      panel.style.minWidth = '';
    } else if (hasEditor) {
      const hasSavedWidth = Number.isFinite(ui.seqPanelWidth);
      const expanded  = hasSavedWidth ? ui.seqPanelWidth : panel.getBoundingClientRect().width;
      const { minWidth, maxWidth } = getSequencerEditorWidthBounds();
      let bounded = Math.max(minWidth, Math.min(maxWidth, Math.round(expanded)));
      // Only auto-expand for overflow the first time when no saved width exists.
      // If the user has manually resized, preserve that width when re-opening editor.
      if (!hasSavedWidth) {
        bounded = resolvePanelWidthForRowVisibility(panel, bounded, { minWidth, maxWidth });
      }
      ui.seqPanelWidth         = bounded;
      panel.style.width        = `${bounded}px`;
      panel.style.minWidth     = `${bounded}px`;
    } else {
      if (Number.isFinite(widthBeforeToggle) && widthBeforeToggle > SEQ_LIST_ONLY_WIDTH + 20) {
        ui.seqPanelWidth = Math.round(widthBeforeToggle);
      }
      panel.style.width    = `${SEQ_LIST_ONLY_WIDTH}px`;
      panel.style.minWidth = `${SEQ_LIST_ONLY_WIDTH}px`;
    }
  }
  if (workspace) workspace.classList.toggle('seq-editor-open', ui.seqPanelOpen && hasEditor);
}

export function syncSeqDefaultCrossfadeUI(seq) {
  const slider  = document.getElementById('seq-default-crossfade');
  const display = document.getElementById('seq-default-crossfade-display');
  const sec = seq ? Math.max(0, seq.defaultCrossfade || 0) : 0;
  if (slider)  slider.value = String(Math.round(sec * 10));
  if (display) display.textContent = `${sec.toFixed(1)} s`;
}
