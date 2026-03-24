// ═══════════════════════════════════════════════════════════════
//  SOUNDBOARD  –  main.js  (boot entry point)
//
//  Business logic lives in src/js/*.js modules.
//  This file wires up DOM event listeners and runs the boot
//  sequence after DOMContentLoaded.
// ═══════════════════════════════════════════════════════════════

import { data, rt, ui, makeSeq, normalizePad, normalizeSeq, getSeq, sliderToSec, SILENCE_STEP_PAD_ID, SEQ_LIST_ONLY_WIDTH, PAD_COLOR_PALETTE } from './js/state.js';
import { setSequencerPanelOpen, setSequenceEditorOpen, syncSeqDefaultCrossfadeUI, getSequencerEditorWidthBounds, resolvePanelWidthForRowVisibility } from './js/resize.js';
import { startProgressLoop } from './js/audio.js';
import { stopSequencer, stopAll } from './js/sequencer.js';
import { renderPadGrid } from './js/pad-ui.js';
import { renderSeqList, renderSeqOverview, renderSeqSteps, updateSeqTransportUI, selectSequence, openSeqEditor } from './js/seq-ui.js';
import { openNewPadModal, closePadModal, savePadModal, deletePad, syncPadModalDisplays, syncPadTrimDisplays, previewPadModalClip, matchPadModalLoudness, onPadWaveformPointerDown, onPadWaveformPointerMove, onPadWaveformPointerUp, openStepModal, closeStepModal, saveStepModal, updateStepModalDuration, onStepSilenceDurationInput, setStepSilenceDurationPreset, syncSwatches, browseAudioFiles, syncPadPlaybackSpeedDisplay, onPadPlaybackSpeedChange, onPadTargetLufsInput, syncProjectTargetLufsUI, resetProjectLoudnessRecalcUI } from './js/modals.js';
import { queueAutosave, saveAutosave, loadAutosave, saveProject, openProject, newProject } from './js/persistence.js';
import { showConfirmDialog } from './js/dialogs.js';

window.addEventListener('DOMContentLoaded', () => {
  const AVAILABLE_THEMES = new Set(['midnight', 'tokyo-night', 'dracula', 'one-dark', 'nord', 'gruvbox-dark', 'lsu-night']);
  const coarsePointerQuery = window.matchMedia('(pointer: coarse)');
  const clampPadSizePercent = value => Math.max(70, Math.min(130, Number(value) || 100));

  const applyTheme = themeKey => {
    const resolved = AVAILABLE_THEMES.has(themeKey) ? themeKey : 'lsu-night';
    ui.themeKey = resolved;
    document.documentElement.dataset.theme = resolved;
  };

  // -- Restore autosave ----------------------------------------
  loadAutosave();
  applyTheme(ui.themeKey);

  const applyPadSizePercent = value => {
    const percent = clampPadSizePercent(value);
    ui.padSizePercent = percent;
    document.documentElement.style.setProperty('--pad-scale', (percent / 100).toFixed(3));

    const slider = document.getElementById('pad-size-slider');
    if (slider) slider.value = String(percent);
    const display = document.getElementById('pad-size-display');
    if (display) display.textContent = `${percent}%`;
  };

  applyPadSizePercent(ui.padSizePercent);
  syncProjectTargetLufsUI();
  resetProjectLoudnessRecalcUI();

  const syncPointerCoarseStatus = isCoarse => {
    document.body.classList.toggle('pointer-coarse', !!isCoarse);
    document.body.dataset.pointerMode = isCoarse ? 'coarse' : 'fine';

    const indicator = document.getElementById('pointer-coarse-indicator');
    if (indicator) {
      indicator.textContent = isCoarse ? 'Pointer: coarse detected' : 'Pointer: fine';
      indicator.dataset.mode = isCoarse ? 'coarse' : 'fine';
    }
  };

  syncPointerCoarseStatus(coarsePointerQuery.matches);
  if (typeof coarsePointerQuery.addEventListener === 'function') {
    coarsePointerQuery.addEventListener('change', event => syncPointerCoarseStatus(event.matches));
  } else if (typeof coarsePointerQuery.addListener === 'function') {
    coarsePointerQuery.addListener(event => syncPointerCoarseStatus(event.matches));
  }

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
  const padReorderBtn = document.getElementById('btn-pad-reorder');
  const tabletModeBtn = document.getElementById('btn-tablet-mode');
  const toggleSequencerBtn = document.getElementById('btn-toggle-sequencer');
  const themeSelect = document.getElementById('theme-select');
  const padSizeSlider = document.getElementById('pad-size-slider');
  const padSizeDenseBtn = document.getElementById('btn-pad-size-dense');
  const padSizeTouchBtn = document.getElementById('btn-pad-size-touch');
  const padSizeDefaultBtn = document.getElementById('btn-pad-size-default');
  const closeSeqEditorBtn = document.getElementById('btn-close-seq-editor');
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
  if (tabletModeBtn) {
    const syncTabletModeButton = () => {
      const enabled = !!ui.tabletMode;
      tabletModeBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      tabletModeBtn.textContent = `Tablet Mode: ${enabled ? 'On' : 'Off'}`;
      tabletModeBtn.classList.toggle('active', enabled);
      document.body.classList.toggle('tablet-mode', enabled);
      document.body.dataset.tabletMode = enabled ? 'on' : 'off';
    };

    syncTabletModeButton();
    tabletModeBtn.addEventListener('click', () => {
      ui.tabletMode = !ui.tabletMode;
      syncTabletModeButton();
      queueAutosave();
    });
  }
  if (padReorderBtn) {
    const syncPadReorderButton = () => {
      const enabled = !!ui.padReorderMode;
      padReorderBtn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
      padReorderBtn.textContent = `Reorder Pads: ${enabled ? 'On' : 'Off'}`;
      padReorderBtn.classList.toggle('active', enabled);
      document.body.classList.toggle('pad-reorder-mode', enabled);
    };
    syncPadReorderButton();
    padReorderBtn.addEventListener('click', () => {
      ui.padReorderMode = !ui.padReorderMode;
      syncPadReorderButton();
      queueAutosave();
    });
  }
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

  if (padSizeSlider) {
    padSizeSlider.value = String(clampPadSizePercent(ui.padSizePercent));
    padSizeSlider.addEventListener('input', e => {
      applyPadSizePercent(e.target.value);
      queueAutosave();
    });
  }

  const applyPadSizePreset = percent => {
    applyPadSizePercent(percent);
    queueAutosave();
  };

  if (padSizeDenseBtn) {
    padSizeDenseBtn.addEventListener('click', () => applyPadSizePreset(80));
  }
  if (padSizeTouchBtn) {
    padSizeTouchBtn.addEventListener('click', () => applyPadSizePreset(115));
  }
  if (padSizeDefaultBtn) {
    padSizeDefaultBtn.addEventListener('click', () => applyPadSizePreset(100));
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
  document.getElementById('pad-modal-close').addEventListener('click',    savePadModal);
  document.getElementById('pad-modal-cancel').addEventListener('click',   closePadModal);
  document.getElementById('pad-modal-backdrop').addEventListener('click', savePadModal);
  document.getElementById('pad-modal-save').addEventListener('click',     savePadModal);
  document.getElementById('pad-modal-delete').addEventListener('click', async () => {
    if (!ui.editingPadId) return;
    const confirmed = await showConfirmDialog({
      title: 'Delete Sound',
      message: 'Delete this sound from the board and all sequences?',
      confirmText: 'Delete Sound',
      cancelText: 'Keep Sound',
      danger: true,
    });
    if (confirmed) deletePad(ui.editingPadId);
  });

  // Modal slider live display
  document.getElementById('pad-volume').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadein').addEventListener('input',  syncPadModalDisplays);
  document.getElementById('pad-fadeout').addEventListener('input', syncPadModalDisplays);
  document.getElementById('pad-playback-speed').addEventListener('input', onPadPlaybackSpeedChange);
  document.getElementById('pad-trim-start').addEventListener('input', syncPadTrimDisplays);
  document.getElementById('pad-trim-end').addEventListener('input', syncPadTrimDisplays);
  document.getElementById('pad-target-lufs').addEventListener('input', onPadTargetLufsInput);
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

  if (closeSeqEditorBtn) {
    closeSeqEditorBtn.addEventListener('click', () => {
      setSequenceEditorOpen(false);
      renderSeqList();
      renderSeqOverview();
      updateSeqTransportUI();
      queueAutosave();
    });
  }

  document.getElementById('btn-delete-seq').addEventListener('click', async () => {
    if (!ui.currentSeqId) return;
    const confirmed = await showConfirmDialog({
      title: 'Delete Sequence',
      message: 'Delete this sequence and all of its steps?',
      confirmText: 'Delete Sequence',
      cancelText: 'Keep Sequence',
      danger: true,
    });
    if (!confirmed) return;
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
  const addSilenceBtn = document.getElementById('btn-add-silence');
  if (addSilenceBtn) {
    addSilenceBtn.addEventListener('click', () => openStepModal(SILENCE_STEP_PAD_ID));
  }

  // -- Step modal -----------------------------------------------
  document.getElementById('step-modal-close').addEventListener('click',    closeStepModal);
  document.getElementById('step-modal-cancel').addEventListener('click',   closeStepModal);
  document.getElementById('step-modal-backdrop').addEventListener('click', closeStepModal);
  document.getElementById('step-modal-save').addEventListener('click',     saveStepModal);
  document.getElementById('step-pad-select').addEventListener('change',    updateStepModalDuration);
  const silenceDurationSlider = document.getElementById('step-silence-duration-slider');
  if (silenceDurationSlider) {
    silenceDurationSlider.addEventListener('input', onStepSilenceDurationInput);
  }
  const stepSilencePreset1 = document.getElementById('btn-step-silence-1');
  const stepSilencePreset2 = document.getElementById('btn-step-silence-2');
  const stepSilencePreset5 = document.getElementById('btn-step-silence-5');
  const stepSilencePreset10 = document.getElementById('btn-step-silence-10');
  if (stepSilencePreset1) stepSilencePreset1.addEventListener('click', () => setStepSilenceDurationPreset(1));
  if (stepSilencePreset2) stepSilencePreset2.addEventListener('click', () => setStepSilenceDurationPreset(2));
  if (stepSilencePreset5) stepSilencePreset5.addEventListener('click', () => setStepSilenceDurationPreset(5));
  if (stepSilencePreset10) stepSilencePreset10.addEventListener('click', () => setStepSilenceDurationPreset(10));

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
