// ═══════════════════════════════════════════════════════════════
//  DIALOGS — shared app dialogs (silent in-app confirmation)
// ═══════════════════════════════════════════════════════════════

let activeConfirmResolver = null;

export function showConfirmDialog(options = {}) {
  const {
    title = 'Confirm Action',
    message = 'Are you sure?',
    confirmText = 'Confirm',
    cancelText = 'Cancel',
    danger = true,
  } = options;

  const modal = document.getElementById('confirm-modal');
  const backdrop = document.getElementById('confirm-modal-backdrop');
  const closeBtn = document.getElementById('confirm-modal-close');
  const cancelBtn = document.getElementById('confirm-modal-cancel');
  const confirmBtn = document.getElementById('confirm-modal-confirm');
  const titleEl = document.getElementById('confirm-title');
  const messageEl = document.getElementById('confirm-message');

  if (!modal || !backdrop || !closeBtn || !cancelBtn || !confirmBtn || !titleEl || !messageEl) {
    return Promise.resolve(false);
  }

  if (activeConfirmResolver) {
    activeConfirmResolver(false);
    activeConfirmResolver = null;
  }

  titleEl.textContent = title;
  messageEl.textContent = message;
  cancelBtn.textContent = cancelText;
  confirmBtn.textContent = confirmText;
  confirmBtn.classList.toggle('btn-danger', !!danger);
  confirmBtn.classList.toggle('btn-accent', !danger);

  modal.hidden = false;
  confirmBtn.focus();

  return new Promise(resolve => {
    activeConfirmResolver = resolve;

    const cleanup = () => {
      modal.hidden = true;
      backdrop.removeEventListener('click', onCancel);
      closeBtn.removeEventListener('click', onCancel);
      cancelBtn.removeEventListener('click', onCancel);
      confirmBtn.removeEventListener('click', onConfirm);
      document.removeEventListener('keydown', onKeydown, true);
      if (activeConfirmResolver === resolve) {
        activeConfirmResolver = null;
      }
    };

    const settle = value => {
      cleanup();
      resolve(value);
    };

    const onCancel = () => settle(false);
    const onConfirm = () => settle(true);
    const onKeydown = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };

    backdrop.addEventListener('click', onCancel);
    closeBtn.addEventListener('click', onCancel);
    cancelBtn.addEventListener('click', onCancel);
    confirmBtn.addEventListener('click', onConfirm);
    document.addEventListener('keydown', onKeydown, true);
  });
}
