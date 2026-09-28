/**
 * commands.js — UI-level commands that need a dialog around an editor action:
 * pick a file, confirm a destructive step. The menu, the welcome screen and
 * the keyboard map (Ctrl+O) all call these, so the confirmation is never
 * skipped by one entry point.
 */

import { useBoardStore } from '../store/boardStore.js';
import { actions } from '../editor/actions.js';
import { useUi } from './uiStore.js';
import { toast } from './toast.js';
import { t } from './strings.js';

/** Ask for one file. Resolves null on cancel (where the browser reports it). */
export function pickFile(accept) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const done = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file ?? null);
    };
    input.addEventListener('change', () => done(input.files && input.files[0]));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** "Abrir…": pick a saved board file and replace the board (confirming first). */
export async function openBoardFile() {
  const file = await pickFile('.json,.whiteboard,application/json');
  if (!file) return false;
  if (useBoardStore.getState().elements.length > 0) {
    const ok = await useUi.getState().askConfirm({
      title: t.confirm.openTitle,
      message: t.confirm.openMessage,
      confirmLabel: t.confirm.openConfirm,
    });
    if (!ok) return false;
  }
  const res = await actions.importFile(file);
  return Boolean(res?.ok);
}

/** "Limpar quadro": confirm, then clear as one undo step. */
export async function confirmClearCanvas() {
  if (useBoardStore.getState().elements.length === 0) return false;
  const ok = await useUi.getState().askConfirm({
    title: t.confirm.clearTitle,
    message: t.confirm.clearMessage,
    confirmLabel: t.confirm.clearConfirm,
  });
  if (!ok) return false;
  const done = actions.clearCanvas();
  if (done) toast.info(t.toast.cleared);
  return done;
}
