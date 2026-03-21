// ═══════════════════════════════════════════════════════════════
//  SOUNDBOARD  –  main.js  (boot entry point)
//
//  Business logic lives in src/js/*.js modules.
//  This file wires up DOM event listeners and runs the boot
//  sequence after DOMContentLoaded.
// ═══════════════════════════════════════════════════════════════

import { data, rt, ui, makeSeq, normalizePad, normalizeSeq, getSeq, sliderToSec, SEQ_LIST_ONLY_WIDTH, PAD_COLOR_PALETTE } from './js/state.js';
import { setSequencerPanelOpen, setSequenceEditorOpen, syncSeqDefaultCrossfadeUI, getSequencerEditorWidthBounds, resolvePanelWidthForRowVisibility } from './js/resize.js';
import { startProgressLoop } from './js/audio.js';
import { stopSequencer, stopAll } from './js/sequencer.js';
import { renderPadGrid } from './js/pad-ui.js';
import { renderSeqList, renderSeqOverview, renderSeqSteps, updateSeqTransportUI, selectSequence, openSeqEditor } from './js/seq-ui.js';
import { openNewPadModal, closePadModal, savePadModal, deletePad, syncPadModalDisplays, syncPadTrimDisplays, previewPadModalClip, matchPadModalLoudness, onPadWaveformPointerDown, onPadWaveformPointerMove, onPadWaveformPointerUp, openStepModal, closeStepModal, saveStepModal, updateStepModalDuration, syncSwatches, browseAudioFiles, syncPadPlaybackSpeedDisplay, onPadPlaybackSpeedChange } from './js/modals.js';
import { queueAutosave, saveAutosave, loadAutosave, saveProject, openProject, newProject } from './js/persistence.js';

window.addEventListener('DOMContentLoaded', () => {
  const AVAILABLE_THEMES = new Set(['midnight', 'tokyo-night', 'dracula', 'one-dark', 'nord', 'gruvbox-dark', 'lsu-night']);

  const applyTheme = themeKey => {
    const resolved = AVAILABLE_THEMES.has(themeKey) ? themeKey : 'lsu-night';
    ui.themeKey = resolved;
    document.documentElement.dataset.theme = resolved;
  };

  // -- Restore autosave ----------------------------------------
  loadAutosave();
  applyTheme(ui.themeKey);

  // Migrate and normalise loaded data (fills in missing fields from older saves)
  data.pads.forEach(normalizePad);
  data.sequences.forEach(normalizeSeq);

  // Ensure a valid currentSeqId reference
  if (ui.currentSeqId && !getSeq(ui.currentSeqId)) {
    ui.currentSeqId = null;
  }

  // -- Default sequence seed -----------------------------------
  // If no sequences exist (fresh install or cleared autosave), create one so
  // the UI is never in a broken blank state.
  if (data.sequences.length === 0) {
    const defaultSeq = makeSeq('New Sequence');
    data.sequences.push(defaultSeq);
    ui.currentSeqId = defaultSeq.id;
  } else if (!ui.currentSeqId) {
    ui.currentSeqId = data.sequences[0].id;
  }

  // -- Header buttons ------------------------------------------
  const newBtn = document.getElementById('btn-new');
  const openBtn = document.getElementById('btn-open');
  const saveBtn = document.getElementById('btn-save');
  const projectNewBtn = document.getElementById('btn-project-new');
  const projectOpenBtn = document.getElementById('btn-project-open');
  const projectSaveBtn = document.getElementById('btn-project-save');
  const projectMenu = document.getElementById('project-menu');
  const stopAllBtn = document.getElementById('btn-stop-all');
  const toggleSequencerBtn = document.getElementById('btn-toggle-sequencer');
  const themeSelect = document.getElementById('theme-select');
  if (newBtn) newBtn.addEventListener('click', newProject);
  if (openBtn) openBtn.addEventListener('click', openProject);
  if (saveBtn) saveBtn.addEventListener('click', saveProject);
  if (projectNewBtn) {
    projectNewBtn.addEventListener('click', () => {
      newProject();
      if (projectMenu) projectMenu.removeAttribute('open');
    });
  }
  if (projectOpenBtn) {
    projectOpenBtn.addEventListener('click', async () => {
      await openProject();
      if (projectMenu) projectMenu.removeAttribute('open');
    });
  }
  if (projectSaveBtn) {
    projectSaveBtn.addEventListener('click', async () => {
      await saveProject();
      if (projectMenu) projectMenu.removeAttribute('open');
    });
  }
  if (stopAllBtn) stopAllBtn.addEventListener('click', stopAll);
  if (toggleSequencerBtn) {
    toggleSequencerBtn.addEventListener('click', () => {
      setSequencerPanelOpen(!ui.seqPanelOpen);
      queueAutosave();
    });
  }

  if (themeSelect) {
    themeSelect.value = ui.themeKey;
    themeSelect.addEventListener('change', e => {
      applyTheme(e.target.value);
      queueAutosave();
    });
  }

  // -- Sequencer panel resize ----------------------------------
  const seqResizer = document.getElementById('seq-resizer');
  const seqPanel   = document.getElementById('sequencer-panel');
  if (seqResizer && seqPanel) {
    let resizeState         = null;
    let widthRaf            = 0;
    let pendingWidth        = null;
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
        seqPanel.style.width    = '';
        seqPanel.style.minWidth = '';
        return;
      }
      // In list-only mode, keep the panel compact and avoid reapplying stored
      // editor widths that can leave a large blank area.
      if (!ui.seqEditorOpen || !ui.currentSeqId) {
        seqPanel.style.width = `${SEQ_LIST_ONLY_WIDTH}px`;
        seqPanel.style.minWidth = `${SEQ_LIST_ONLY_WIDTH}px`;
        return;
      }
      if (Number.isFinite(ui.seqPanelWidth)) applyPanelWidth(ui.seqPanelWidth);
    };

    syncPanelWidthForViewport();
    window.addEventListener('resize', syncPanelWidthForViewport);

    seqResizer.addEventListener('pointerdown', e => {
      if (window.innerWidth <= 980) return;
      if (!ui.seqEditorOpen || !ui.currentSeqId) return;
      resizeState = {
        pointerId:  e.pointerId,
        startX:     e.clientX,
        startWidth: seqPanel.getBoundingClientRect().width,
      };
      resizeOverflowFloor = null;
      seqPanel.classList.add('resizing');
      seqResizer.setPointerCapture(e.pointerId);
    });

    seqResizer.addEventListener('pointermove', e => {
      if (!resizeState || e.pointerId !== resizeState.pointerId) return;
      const delta = resizeState.startX - e.clientX;
      const next  = resizeState.startWidth + delta;
      queuePanelWidth(next, { duringResize: true });
    });

    const finishResize = e => {
      if (!resizeState || e.pointerId !== resizeState.pointerId) return;
      try { seqResizer.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (widthRaf) { cancelAnimationFrame(widthRaf); widthRaf = 0; }
      if (pendingWidth != null) {
        applyPanelWidth(pendingWidth, { duringResize: true });
        pendingWidth = null;
      }
      resizeOverflowFloor = null;
      seqPanel.classList.remove('resizing');
      resizeState = null;
      queueAutosave();
    };

    seqResizer.addEventListener('pointerup',     finishResize);
    seqResizer.addEventListener('pointercancel', finishResize);
  }

  // -- Pad grid ------------------------------------------------
  const addPadBtn = document.getElementById('btn-add-pad');
  const gridAddBtn = document.getElementById('btn-grid-add');
  if (addPadBtn) addPadBtn.addEventListener('click',  () => openNewPadModal());
  if (gridAddBtn) gridAddBtn.addEventListener('click', () => openNewPadModal());

  // -- Master volume --------------------------------------------
  const masterSlider = document.getElementById('master-volume');
  const masterVal    = document.getElementById('master-volume-val');
  masterSlider.addEventListener('input', () => {
    rt.master = masterSlider.value / 100;
    masterVal.textContent = masterSlider.value + '%';
    Howler.volume(rt.master);  // Howler is a global from lib/howler.min.js
  });

  // -- Pad modal ------------------------------------------------
  document.getElementById('pad-modal-close').addEventListener('click',    closePadModal);
  document.getElementById('pad-modal-cancel').addEventListener('click',   closePadModal);
  document.getElementById('pad-modal-backdrop').addEventListener('click', closePadModal);
  document.getElementById('pad-modal-save').addEventListener('click',     savePadModal);
  document.getElementById('pad-modal-delete').addEventListener('click', () => {
    if (ui.editingPadId && confirm('Delete this sound?')) deletePad(ui.editingPadId);
  });

  // Modal slider live display
  document.getElementById('pad-volume').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadein').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadeout').addEventListener('input', syncPadModalDisplays);
  document.getElementById('pad-playback-speed').addEventListener('input', onPadPlaybackSpeedChange);
  document.getElementById('pad-trim-start').addEventListener('input', syncPadTrimDisplays);
  document.getElementById('pad-trim-end').addEventListener('input', syncPadTrimDisplays);
  document.getElementById('btn-preview-clip').addEventListener('click', previewPadModalClip);
  document.getElementById('btn-match-loudness').addEventListener('click', matchPadModalLoudness);
  const waveformCanvas = document.getElementById('pad-waveform');
  waveformCanvas.addEventListener('pointerdown', onPadWaveformPointerDown);
  waveformCanvas.addEventListener('pointermove', onPadWaveformPointerMove);
  waveformCanvas.addEventListener('pointerup', onPadWaveformPointerUp);
  waveformCanvas.addEventListener('pointercancel', onPadWaveformPointerUp);

  // Color picker ↔ swatches
  const padColorInput = document.getElementById('pad-color');
  const swatchesHost = document.getElementById('pad-color-swatches');
  if (swatchesHost) {
    swatchesHost.innerHTML = PAD_COLOR_PALETTE.map(color => (
      `<button class="swatch" style="--sw:${color}" data-color="${color}" type="button" aria-label="Select ${color} color"></button>`
    )).join('');
  }
  padColorInput.addEventListener('input', e => syncSwatches(e.target.value));
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      padColorInput.value = sw.dataset.color;
      syncSwatches(sw.dataset.color);
    });
  });

  // Browse for audio file(s)
  document.getElementById('btn-browse').addEventListener('click', browseAudioFiles);

  // -- Sequencer controls ---------------------------------------
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

  // -- Step modal -----------------------------------------------
  document.getElementById('step-modal-close').addEventListener('click',    closeStepModal);
  document.getElementById('step-modal-cancel').addEventListener('click',   closeStepModal);
  document.getElementById('step-modal-backdrop').addEventListener('click', closeStepModal);
  document.getElementById('step-modal-save').addEventListener('click',     saveStepModal);
  document.getElementById('step-pad-select').addEventListener('change',    updateStepModalDuration);

  // -- Initial render -------------------------------------------
  setSequencerPanelOpen(ui.seqPanelOpen);
  setSequenceEditorOpen(ui.seqEditorOpen);
  renderPadGrid();
  renderSeqList();
  renderSeqOverview();
  if (ui.currentSeqId && ui.seqEditorOpen) {
    syncSeqDefaultCrossfadeUI(getSeq(ui.currentSeqId));
    renderSeqSteps();
  } else {
    syncSeqDefaultCrossfadeUI(getSeq(ui.currentSeqId));
  }
  updateSeqTransportUI();
  startProgressLoop();

  // -- Persist state on tab close / hide -----------------------
  window.addEventListener('beforeunload', saveAutosave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveAutosave();
  });
});
