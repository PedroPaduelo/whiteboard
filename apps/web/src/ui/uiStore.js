/**
 * uiStore.js — shell state that is not the board: which overlay is open, the
 * theme, the context menu, pending confirmations.
 *
 * It is its own tiny zustand store (not React state in App) for the same
 * reason the editor actions are plain functions: the keyboard handler, the
 * context menu and the menus all need to open/close the same overlays, and
 * reading `useUi.getState()` from an event handler cannot go stale the way a
 * ref to a component's state did (the old split-`uiRef` bug that made Ctrl+D,
 * Ctrl+C and zoom keys dead).
 *
 * Board data never lives here; that is store/boardStore.js.
 */

import { create } from 'zustand';
import { initialTheme, persistTheme } from './theme.js';

/** Overlays closed by Escape, topmost first. The library sidebar is not one:
 *  it is a docked panel with its own close button (Escape there clears the
 *  selection, as everywhere on the board). The colour popover is: Escape
 *  closes just the picker and keeps the selection (Excalidraw). */
const ESCAPE_ORDER = [
  'contextMenu',
  'confirm',
  'moreToolsOpen',
  'menuOpen',
  'nicknameOpen',
  'exportOpen',
  'helpOpen',
  'colorPicker',
  'propsOpen',
];

/** Overlay keys whose "closed" value is null rather than false. */
const NULL_WHEN_CLOSED = new Set(['contextMenu', 'confirm', 'colorPicker']);

export const useUi = create((set, get) => ({
  theme: initialTheme(),
  menuOpen: false,
  moreToolsOpen: false,
  helpOpen: false,
  exportOpen: false,
  libraryOpen: false,
  nicknameOpen: false,
  /** Mobile only: the properties bottom sheet is expanded. */
  propsOpen: false,
  /** `{x, y}` client px, `at` board point, `targetId` — or null. */
  contextMenu: null,
  /** `{title, message, confirmLabel, danger, resolve}` — or null. */
  confirm: null,
  /**
   * The properties panel's open colour popover: the row that owns it
   * ('stroke' | 'fill') or null. Kept here, not in the row, so Escape can
   * close it like any other overlay — in the hex field too.
   */
  colorPicker: null,
  /** Registered by App: go to a board id, or to the list with null. */
  navigate: null,
  /**
   * What the canvas is in the middle of, for the hint line (ui/hints.js
   * GESTURE_HINTS): 'linearMulti' while a connector is placed click by
   * click, 'pointEditing' while one is in point editing, else null. Written
   * by editor/Canvas.jsx.
   */
  gestureHint: null,

  setGestureHint(kind) {
    const next = kind === 'linearMulti' || kind === 'pointEditing' ? kind : null;
    if (get().gestureHint !== next) set({ gestureHint: next });
  },

  setTheme(theme, { persist = false } = {}) {
    if (theme !== 'light' && theme !== 'dark') return;
    if (persist) persistTheme(theme);
    if (get().theme !== theme) set({ theme });
  },

  /** The user's explicit toggle: persisted, unlike a board's default theme. */
  toggleTheme() {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    persistTheme(next);
    set({ theme: next });
  },

  /** Open one overlay by state key ('menuOpen', 'helpOpen', …), closing menus. */
  open(key) {
    set({ [key]: true, menuOpen: key === 'menuOpen', moreToolsOpen: key === 'moreToolsOpen', contextMenu: null });
  },
  close(key) {
    if (get()[key]) set({ [key]: NULL_WHEN_CLOSED.has(key) ? null : false });
  },
  toggle(key) {
    if (get()[key]) get().close(key);
    else get().open(key);
  },

  /** Open the colour popover of one properties row (closing another row's). */
  openColorPicker(row) {
    if (row && get().colorPicker !== row) set({ colorPicker: row });
  },
  /** Close the colour popover; with `row`, only if that row owns it. */
  closeColorPicker(row) {
    const cur = get().colorPicker;
    if (cur && (!row || cur === row)) set({ colorPicker: null });
  },

  openContextMenu(info) {
    set({ contextMenu: info ?? null, menuOpen: false, moreToolsOpen: false });
  },
  closeContextMenu() {
    if (get().contextMenu) set({ contextMenu: null });
  },

  /**
   * Ask the user to confirm something destructive. Resolves true/false; a
   * second request cancels the first (it resolves false).
   * @returns {Promise<boolean>}
   */
  askConfirm({ title, message, confirmLabel, danger = true } = {}) {
    const prev = get().confirm;
    if (prev) prev.resolve(false);
    return new Promise((resolve) => {
      set({ confirm: { title, message, confirmLabel, danger, resolve }, menuOpen: false, contextMenu: null });
    });
  },
  resolveConfirm(ok) {
    const c = get().confirm;
    if (!c) return;
    set({ confirm: null });
    c.resolve(Boolean(ok));
  },

  /** Close every overlay and panel (navigation away from the board). */
  closeAll() {
    const c = get().confirm;
    set({
      menuOpen: false,
      moreToolsOpen: false,
      helpOpen: false,
      exportOpen: false,
      libraryOpen: false,
      nicknameOpen: false,
      propsOpen: false,
      contextMenu: null,
      confirm: null,
      colorPicker: null,
      gestureHint: null,
    });
    if (c) c.resolve(false);
  },

  /** Is any Escape-closable overlay open? */
  anyOverlayOpen() {
    const s = get();
    return ESCAPE_ORDER.some((k) => Boolean(s[k]));
  },

  /**
   * Close the topmost overlay. Returns true when something was closed, so
   * Escape can fall through to "finish edit / clear selection" otherwise.
   */
  closeTopOverlay() {
    const s = get();
    for (const k of ESCAPE_ORDER) {
      if (!s[k]) continue;
      if (k === 'confirm') s.resolveConfirm(false);
      else s.close(k);
      return true;
    }
    return false;
  },
}));

export default useUi;
