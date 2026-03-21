// ═══════════════════════════════════════════════════════════════
//  SOUNDBOARD  –  main.js  (boot entry point)
//
//  Business logic lives in src/js/*.js modules.
//  This file wires up DOM event listeners and runs the boot
//  sequence after DOMContentLoaded.
// ═══════════════════════════════════════════════════════════════

import { data, rt, ui, makeSeq, normalizePad, normalizeSeq, getSeq, sliderToSec } from './js/state.js';
import { setSequencerPanelOpen, setSequenceEditorOpen, syncSeqDefaultCrossfadeUI, getSequencerEditorWidthBounds, resolvePanelWidthForRowVisibility } from './js/resize.js';
import { startProgressLoop } from './js/audio.js';
import { stopSequencer, stopAll } from './js/sequencer.js';
import { renderPadGrid } from './js/pad-ui.js';
import { renderSeqList, renderSeqOverview, renderSeqSteps, updateSeqTransportUI, selectSequence, openSeqEditor } from './js/seq-ui.js';
import { openNewPadModal, closePadModal, savePadModal, deletePad, syncPadModalDisplays, openStepModal, closeStepModal, saveStepModal, updateStepModalDuration, syncSwatches, browseAudioFiles } from './js/modals.js';
import { queueAutosave, saveAutosave, loadAutosave, saveProject, openProject, newProject } from './js/persistence.js';

window.addEventListener('DOMContentLoaded', () => {
  // -- Restore autosave ----------------------------------------
  loadAutosave();

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
  document.getElementById('btn-new').addEventListener('click', newProject);
  document.getElementById('btn-open').addEventListener('click', openProject);
  document.getElementById('btn-save').addEventListener('click', saveProject);
  document.getElementById('btn-stop-all').addEventListener('click', stopAll);
  document.getElementById('btn-toggle-sequencer').addEventListener('click', () => {
    setSequencerPanelOpen(!ui.seqPanelOpen);
    queueAutosave();
  });

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
      if (Number.isFinite(ui.seqPanelWidth)) applyPanelWidth(ui.seqPanelWidth);
    };

    syncPanelWidthForViewport();
    window.addEventListener('resize', syncPanelWidthForViewport);

    seqResizer.addEventListener('pointerdown', e => {
      if (window.innerWidth <= 980) return;
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
  document.getElementById('btn-add-pad').addEventListener('click',  () => openNewPadModal());
  document.getElementById('btn-grid-add').addEventListener('click', () => openNewPadModal());

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

  // Color picker ↔ swatches
  document.getElementById('pad-color').addEventListener('input', e => syncSwatches(e.target.value));
  document.querySelectorAll('.swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      document.getElementById('pad-color').value = sw.dataset.color;
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
