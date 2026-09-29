/**
 * modal.js — "is a modal dialog open?", and the clipboard guard built on it.
 *
 * While a modal (help, export, a confirmation, the nickname dialog) is open
 * the board behind it takes no input: the keyboard map already stops there
 * (App.jsx), and the same test must hold for the clipboard. Ctrl+X / Ctrl+V
 * arrive as native `cut` / `paste` events, which the keydown check never
 * sees — they used to cut the selection or paste onto the board BEHIND an
 * open dialog, and ship that to every collaborator.
 *
 * Plain JS (no JSX) so node tests can import it.
 */

import { useUi } from './uiStore.js';
import { isTypingTarget } from './shortcuts.js';

/** uiStore keys of the overlays that are modal (they own the keyboard). */
export const MODAL_KEYS = Object.freeze(['helpOpen', 'exportOpen', 'confirm', 'nicknameOpen']);

/** Is a modal dialog open in this UI state (default: the live store)? */
export function isModalOpen(state = useUi.getState()) {
  return MODAL_KEYS.some((k) => Boolean(state?.[k]));
}

const CLIPBOARD_EVENTS = ['copy', 'cut', 'paste'];

/**
 * Keep clipboard events away from the board while a modal is open.
 *
 * Installed once, at startup (main.jsx), on the window in the CAPTURE phase:
 * registered before React mounts anything, it runs before every other
 * window-capture listener — including the canvas' image-paste handler — and
 * stops the event there, so no board handler (App's copy/cut/paste, the
 * canvas' image paste) ever sees it. Only propagation is stopped, never the
 * default: a paste into the nickname field, or copying text selected in the
 * help dialog, still works. Events aimed at a text field pass untouched.
 *
 * @param {Window|EventTarget} target
 * @param {() => boolean} [modalOpen]
 * @returns {() => void} uninstall
 */
export function installModalClipboardGuard(target = globalThis.window, modalOpen = () => isModalOpen()) {
  if (!target?.addEventListener) return () => {};
  const guard = (e) => {
    if (!modalOpen() || isTypingTarget(e.target)) return;
    e.stopImmediatePropagation();
  };
  for (const type of CLIPBOARD_EVENTS) target.addEventListener(type, guard, { capture: true });
  return () => {
    for (const type of CLIPBOARD_EVENTS) target.removeEventListener(type, guard, { capture: true });
  };
}
