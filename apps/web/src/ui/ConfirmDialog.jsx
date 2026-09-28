/**
 * ConfirmDialog.jsx — the in-app confirmation for destructive commands
 * ("Limpar quadro", opening a file over a non-empty board). Driven by
 * `useUi().askConfirm(...)`, which resolves true/false.
 */

import React from 'react';
import { useUi } from './uiStore.js';
import { Dialog } from './Dialog.jsx';
import { t } from './strings.js';

export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  if (!c) return null;
  const answer = (ok) => useUi.getState().resolveConfirm(ok);
  return (
    <Dialog
      title={c.title}
      onClose={() => answer(false)}
      size="sm"
      testId="confirm-dialog"
      initialFocus="[data-confirm-cancel]"
      footer={
        <>
          <button type="button" className="btn" data-confirm-cancel onClick={() => answer(false)}>
            {t.dialog.cancel}
          </button>
          <button type="button" className={`btn ${c.danger ? 'btn--danger' : 'btn--primary'}`} data-testid="confirm-ok" onClick={() => answer(true)}>
            {c.confirmLabel || t.dialog.confirm}
          </button>
        </>
      }
    >
      <p className="confirm-message">{c.message}</p>
    </Dialog>
  );
}

export default ConfirmDialog;
