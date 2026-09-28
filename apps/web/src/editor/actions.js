/**
 * actions.js — every editing intent, as plain functions over the board store.
 *
 * The keyboard map (ui/shortcuts.js), the main menu, the context menu, the
 * properties panel and the library all call THESE functions, so an intent has
 * exactly one implementation: Ctrl+D, "Duplicar" in the context menu and the
 * panel's duplicate button cannot drift apart. (The old app had the intents on
 * a component-local ref that the keyboard handler never saw, which is how
 * copy, paste, duplicate and keyboard zoom all ended up dead.)
 *
 * Each action reads `useBoardStore.getState()` when it runs — never a
 * captured copy — and follows the store's rule: `commit(label)` BEFORE the
 * mutation, so every action is one undo step. Discrete actions use a unique
 * label (two quick duplicates are two undo steps); repeatable controls use a
 * stable one so they coalesce (a slider drag, a held arrow key).
 *
 * No DOM is required: everything runs under `node --test`. Browser-only bits
 * (the async clipboard, file download, the image picker) are feature-detected
 * and degrade to an in-memory clipboard or a no-op.
 *
 * Clipboard format (system clipboard, text/plain):
 *     {"type":"whiteboard/clipboard","elements":[…]}
 * Pasting clones with FRESH ids (editor/elements.js cloneElements), so a
 * pasted arrow stays bound to the pasted box and never to the original.
 */

import { LIMITS, ZOOM_LIMITS, fitView, tryValidateElement } from '@whiteboard/shared';
import { useBoardStore } from '../store/boardStore.js';
import { DUPLICATE_OFFSET, ZOOM_BUTTON_FACTOR } from './constants.js';
import { cloneElements, createElement, newId, styleKeysFor, isText, isContainer } from './elements.js';
import { fitTextElement } from './text.js';
import { commonBounds } from './handles.js';
import { moveElements, applyPatches, resolveBindingPatches } from './scene.js';
import { serializeBoard, parseBoardFile, downloadBlob } from './export/export.js';
import { openImagePicker, insertImageFiles } from './image.js';
import { toast } from '../ui/toast.js';
import { t } from '../ui/strings.js';

/** `type` of the JSON we put on the system clipboard. */
export const CLIPBOARD_TYPE = 'whiteboard/clipboard';

/** Padding (screen px) around content for zoom-to-fit. */
const FIT_PADDING = 64;
/** Zoom-to-fit never magnifies past 100% (a lone sticky should not fill the screen)… */
const FIT_MAX_ZOOM = 1;
/** …but zoom-to-selection may, up to this. */
const SELECTION_MAX_ZOOM = 4;

const S = () => useBoardStore.getState();

let labelSeq = 0;
/** A commit label unique to one invocation of a discrete action. */
const once = (name) => `${name}:${Date.now().toString(36)}${(labelSeq += 1)}`;

/**
 * The live store as a "handle" (getState + actions), the shape the legacy
 * shortcut contract passes around (`handler({store})`).
 */
const liveHandle = {
  getState: () => S(),
  commit: (label) => S().commit(label),
  removeElements: (ids) => S().removeElements(ids),
  clearSelection: () => S().clearSelection(),
};

/** Last thing we copied, for browsers without an async clipboard (http origins). */
let memoryClipboard = null;

/* ------------------------------------------------------------------ *
 * Helpers (exported for the UI and for tests)
 * ------------------------------------------------------------------ */

/** Selected elements, in z-order. */
export function selectedElements(state = S()) {
  const sel = state.selection;
  if (!sel || sel.size === 0) return [];
  return state.elements.filter((el) => sel.has(el.id));
}

/** The canvas' CSS size, falling back to the window (or a sane constant in node). */
export function viewportSize(state = S()) {
  const v = state.viewportSize;
  if (v && v.w > 0 && v.h > 0) return { w: v.w, h: v.h };
  if (typeof window !== 'undefined' && window.innerWidth > 0) return { w: window.innerWidth, h: window.innerHeight };
  return { w: 1280, h: 800 };
}

/** Screen (canvas-relative CSS px) -> board units. */
export function screenToBoardPoint(p, view = S().view) {
  const z = view.zoom || 1;
  return { x: (p.x - view.panX) / z, y: (p.y - view.panY) / z };
}

/** The board point at the centre of the viewport. */
export function viewportCenter(state = S()) {
  const { w, h } = viewportSize(state);
  return screenToBoardPoint({ x: w / 2, y: h / 2 }, state.view);
}

/** Serialise elements for the system clipboard. */
export function serializeClipboard(elements) {
  return JSON.stringify({ type: CLIPBOARD_TYPE, elements });
}

/**
 * Elements from clipboard text, or null when the text is not ours. Each
 * element is re-validated: the clipboard is outside input.
 * @returns {object[]|null}
 */
export function parseClipboard(text) {
  if (typeof text !== 'string' || !text.includes(CLIPBOARD_TYPE)) return null;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (!data || data.type !== CLIPBOARD_TYPE || !Array.isArray(data.elements)) return null;
  const out = [];
  for (const raw of data.elements.slice(0, LIMITS.MAX_ELS)) {
    const res = tryValidateElement(raw);
    if (res.valid) out.push(res.element);
  }
  return out;
}

/** A file name from a board title (keeps accents, drops path characters). */
export function fileBaseName(title) {
  const base = String(title ?? '')
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/\s+/g, ' ')
    .slice(0, 80)
    .trim();
  return base || 'quadro';
}

/** New z-order ids for a layer move, or null when nothing would change. */
export function reorderIds(elements, selection, mode) {
  const ids = elements.map((el) => el.id);
  const isSel = (id) => selection.has(id);
  let next;
  if (mode === 'front') next = [...ids.filter((id) => !isSel(id)), ...ids.filter(isSel)];
  else if (mode === 'back') next = [...ids.filter(isSel), ...ids.filter((id) => !isSel(id))];
  else if (mode === 'forward') {
    next = ids.slice();
    // Top-down, so a selected block moves up past exactly one unselected element.
    for (let i = next.length - 2; i >= 0; i--) {
      if (isSel(next[i]) && !isSel(next[i + 1])) [next[i], next[i + 1]] = [next[i + 1], next[i]];
    }
  } else if (mode === 'backward') {
    next = ids.slice();
    for (let i = 1; i < next.length; i++) {
      if (isSel(next[i]) && !isSel(next[i - 1])) [next[i - 1], next[i]] = [next[i], next[i - 1]];
    }
  } else return null;
  return next.every((id, i) => id === ids[i]) ? null : next;
}

/** Translate built elements so their bounds are centred on `at`. */
function centreOn(elements, at) {
  const b = commonBounds(elements);
  if (!b) return { dx: 0, dy: 0 };
  return { dx: at.x - (b.x + b.w / 2), dy: at.y - (b.y + b.h / 2) };
}

function setViewFit(bounds, maxZoom) {
  const s = S();
  const { w, h } = viewportSize(s);
  const padding = Math.min(FIT_PADDING, Math.round(Math.min(w, h) * 0.12));
  s.setView(fitView(bounds, { width: w, height: h, padding, min: ZOOM_LIMITS.min, max: maxZoom }));
}

/** Select what was just inserted, back on the select tool (Excalidraw). */
function selectInserted(ids) {
  const s = S();
  if (s.tool !== 'select') s.setTool('select');
  S().select(ids);
}

/* ------------------------------------------------------------------ *
 * The actions
 * ------------------------------------------------------------------ */

export const actions = {
  /**
   * Delete the selection (locked elements are protected), then clear it.
   * `store` is optional: the legacy shortcut contract passes a handle with
   * `getState/commit/removeElements/clearSelection`.
   */
  deleteSelection(store) {
    const api = store ?? liveHandle;
    const st = api.getState();
    const locked = new Set((st.elements ?? []).filter((el) => el.locked).map((el) => el.id));
    const ids = [...(st.selection ?? [])].filter((id) => !locked.has(id));
    if (ids.length) {
      api.commit('delete');
      api.removeElements(ids);
    }
    // Always drop the selection: a stale one makes the next Delete act on nothing.
    api.clearSelection();
    return ids.length > 0;
  },

  duplicateSelection() {
    const s = S();
    const picked = selectedElements(s);
    if (!picked.length) return [];
    const copies = cloneElements(picked, { dx: DUPLICATE_OFFSET, dy: DUPLICATE_OFFSET });
    if (!copies.length) return [];
    s.commit(once('duplicate'));
    s.addElements(copies);
    S().select(copies.map((el) => el.id));
    return copies;
  },

  /** Select everything that is not locked (Excalidraw), on the select tool. */
  selectAll() {
    const s = S();
    if (s.tool !== 'select') s.setTool('select');
    const ids = S().elements.filter((el) => !el.locked).map((el) => el.id);
    S().select(ids);
    return ids.length;
  },

  deselect() {
    const s = S();
    if (s.selection.size === 0) return false;
    s.clearSelection();
    return true;
  },

  /** The clipboard JSON for the current selection (null when empty). Also
   *  remembered in memory for browsers without an async clipboard. */
  selectionClipboardText() {
    const picked = selectedElements();
    if (!picked.length) return null;
    const text = serializeClipboard(picked);
    memoryClipboard = text;
    return text;
  },

  /** Copy the selection to the system clipboard (menus; Ctrl+C uses the copy event). */
  async copy() {
    const text = actions.selectionClipboardText();
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
    } catch {
      /* permission denied / insecure origin: the in-memory copy still pastes here */
    }
  },

  /**
   * The synchronous half of a cut (used by the native `cut` event, which must
   * fill `clipboardData` before it returns): remember the selection's
   * clipboard text, then delete it as one undo step. Returns the text.
   */
  cutSelection() {
    const text = actions.selectionClipboardText();
    if (!text) return null;
    const s = S();
    const ids = selectedElements(s)
      .filter((el) => !el.locked)
      .map((el) => el.id);
    if (ids.length) {
      s.commit(once('cut'));
      s.removeElements(ids);
    }
    S().clearSelection();
    return text;
  },

  /** Cut to the system clipboard (menus; Ctrl+X uses the cut event). */
  async cut() {
    const text = actions.cutSelection();
    if (!text) return;
    try {
      await globalThis.navigator?.clipboard?.writeText(text);
    } catch {
      /* in-memory fallback */
    }
  },

  /**
   * Paste clipboard text centred on `at` (board units; default the viewport
   * centre). Our JSON pastes elements with fresh ids and remapped bindings;
   * any other text becomes a text element. `text` null reads the system
   * clipboard (menus), falling back to the last in-app copy.
   * @returns {Promise<object[]>} the inserted elements
   */
  async paste(textOrNull = null, at = null) {
    let text = textOrNull;
    if (text == null) {
      try {
        text = (await globalThis.navigator?.clipboard?.readText?.()) ?? null;
      } catch {
        text = null;
      }
      if (!text) text = memoryClipboard;
    }
    if (!text) {
      toast.info(t.toast.nothingToPaste);
      return [];
    }
    const s = S();
    const target = at ?? viewportCenter(s);
    const parsed = parseClipboard(text);
    if (parsed) {
      if (!parsed.length) {
        toast.info(t.toast.nothingToPaste);
        return [];
      }
      const { dx, dy } = centreOn(parsed, target);
      const copies = cloneElements(parsed, { dx, dy });
      if (!copies.length) return [];
      s.commit(once('paste'));
      s.addElements(copies);
      selectInserted(copies.map((el) => el.id));
      return copies;
    }
    const str = String(text).replace(/\r\n?/g, '\n').slice(0, LIMITS.MAX_TEXT);
    if (!str.trim()) {
      toast.info(t.toast.nothingToPaste);
      return [];
    }
    const el = createElement('text', { x: target.x, y: target.y, text: str }, s.style);
    const placed = { ...el, x: target.x - el.w / 2, y: target.y - el.h / 2 };
    s.commit(once('paste'));
    s.addElements([placed]);
    selectInserted([placed.id]);
    return [placed];
  },

  /** Insert ready-made elements (library) as one undo step and select them. */
  insertElements(elements, label = 'insert') {
    const list = (elements ?? []).filter(Boolean);
    if (!list.length) return [];
    const s = S();
    s.commit(once(label));
    s.addElements(list);
    selectInserted(list.map((el) => el.id));
    return list;
  },

  /** Group the selection under a fresh group key (flattens existing groups). */
  group() {
    const s = S();
    const picked = selectedElements(s);
    if (picked.length < 2) return false;
    const first = picked[0].groupId;
    if (first && picked.every((el) => el.groupId === first) && s.elements.filter((el) => el.groupId === first).length === picked.length) {
      return false; // already exactly one group
    }
    const groupId = newId();
    s.commit(once('group'));
    s.updateElements(picked.map((el) => ({ id: el.id, patch: { groupId } })));
    return true;
  },

  /** Dissolve the groups in the selection (including legacy frame groups). */
  ungroup() {
    const s = S();
    const picked = selectedElements(s);
    if (!picked.length) return false;
    const selIds = new Set(picked.map((el) => el.id));
    const patches = [];
    for (const el of s.elements) {
      if (!el.groupId) continue;
      // Members of a selected group, and children of a selected legacy frame.
      if (selIds.has(el.id) || selIds.has(el.groupId)) patches.push({ id: el.id, patch: { groupId: null } });
    }
    if (!patches.length) return false;
    s.commit(once('ungroup'));
    s.updateElements(patches);
    return true;
  },

  /** Lock the selection, or unlock it when everything in it is locked. */
  toggleLock() {
    const s = S();
    const picked = selectedElements(s);
    if (!picked.length) return false;
    const lock = !picked.every((el) => el.locked);
    s.commit(once(lock ? 'lock' : 'unlock'));
    // `locked: false`, not null: the server rejects a null `locked`.
    s.updateElements(picked.map((el) => ({ id: el.id, patch: { locked: lock } })));
    return true;
  },

  bringForward: () => reorder('forward'),
  sendBackward: () => reorder('backward'),
  bringToFront: () => reorder('front'),
  sendToBack: () => reorder('back'),

  /** Move the selection by (dx, dy) board units. Held keys coalesce into one undo step. */
  nudge(dx, dy) {
    const s = S();
    const picked = selectedElements(s).filter((el) => !el.locked);
    if (!picked.length || (!dx && !dy)) return false;
    const patches = moveElements(picked, dx, dy);
    const next = applyPatches(s.elements, patches);
    const bind = resolveBindingPatches(
      next,
      picked.map((el) => el.id),
    );
    s.commit('nudge');
    s.updateElements([...patches, ...bind]);
    return true;
  },

  /* --- view --------------------------------------------------------- */

  zoomIn() {
    const s = S();
    const { w, h } = viewportSize(s);
    s.zoomAtScreen({ x: w / 2, y: h / 2 }, ZOOM_BUTTON_FACTOR);
  },

  zoomOut() {
    const s = S();
    const { w, h } = viewportSize(s);
    s.zoomAtScreen({ x: w / 2, y: h / 2 }, 1 / ZOOM_BUTTON_FACTOR);
  },

  /** Exactly 100%, about the viewport centre (not a jump back to the origin). */
  resetZoom() {
    const s = S();
    const { w, h } = viewportSize(s);
    const c = screenToBoardPoint({ x: w / 2, y: h / 2 }, s.view);
    s.setView({ zoom: 1, panX: w / 2 - c.x, panY: h / 2 - c.y });
  },

  zoomToFit() {
    const s = S();
    const b = commonBounds(s.elements);
    if (!b) {
      actions.resetZoom();
      return;
    }
    setViewFit(b, FIT_MAX_ZOOM);
  },

  zoomToSelection() {
    const picked = selectedElements();
    if (!picked.length) {
      actions.zoomToFit();
      return;
    }
    setViewFit(commonBounds(picked), SELECTION_MAX_ZOOM);
  },

  /** Grid mode (shows the grid and snaps), Excalidraw's Ctrl+'. */
  toggleGrid() {
    S().toggleSnap();
  },

  /* --- style ------------------------------------------------------------ */

  /**
   * Change a style property: the default for new elements AND the selection.
   * Each selected element receives only the keys its type uses
   * (`styleKeysFor`), free text is re-measured after font changes, and the
   * whole edit is ONE undo step labelled by the control (`style:stroke`), so a
   * slider drag or a colour-picker drag coalesces.
   *
   * Sticky notes keep their own default colour (`style.stickyFill`): a
   * background picked while a note is selected (or the sticky tool is active)
   * becomes the next note's colour, not every rectangle's.
   *
   * @param {object} patch e.g. `{stroke: '#e03131'}`
   * @returns {boolean} whether any element changed
   */
  applyStyle(patch) {
    if (!patch || typeof patch !== 'object') return false;
    const keys = Object.keys(patch).filter((k) => patch[k] !== undefined);
    if (!keys.length) return false;
    const s = S();
    const picked = selectedElements(s);

    const stickyContext = picked.length ? picked.some((el) => el.type === 'sticky') : s.tool === 'sticky';
    const onlySticky = picked.length ? picked.every((el) => el.type === 'sticky') : s.tool === 'sticky';
    const stylePatch = {};
    for (const k of keys) {
      if (k === 'fill' && stickyContext) {
        if (patch.fill !== 'none' && patch.fill !== 'transparent') stylePatch.stickyFill = patch.fill;
        if (onlySticky) continue;
      }
      stylePatch[k] = patch[k];
    }
    s.setStyle(stylePatch);

    const patches = [];
    const refit = [];
    for (const el of picked) {
      const allowed = styleKeysFor(el.type);
      const p = {};
      for (const k of keys) if (allowed.includes(k) && el[k] !== patch[k]) p[k] = patch[k];
      // A note always has paper.
      if (el.type === 'sticky' && (p.fill === 'none' || p.fill === 'transparent')) delete p.fill;
      if (!Object.keys(p).length) continue;
      if (isText(el) && ('fontFamily' in p || 'fontSize' in p)) {
        Object.assign(p, fitTextElement({ ...el, ...p }));
        refit.push(el.id);
      }
      patches.push({ id: el.id, patch: p });
    }
    if (!patches.length) return false;
    const bind = refit.length ? resolveBindingPatches(applyPatches(s.elements, patches), refit) : [];
    s.commit(`style:${[...keys].sort().join('+')}`);
    S().updateElements([...patches, ...bind]);
    return true;
  },

  /* --- editing ------------------------------------------------------------ */

  /** Enter: edit the single selected text / label. */
  editSelected() {
    const s = S();
    const picked = selectedElements(s);
    if (picked.length !== 1) return false;
    const el = picked[0];
    if (el.locked || !(isText(el) || isContainer(el))) return false;
    s.setEditing(el.id);
    return true;
  },

  /**
   * Pick a tool. The image tool opens the file picker right away (Excalidraw)
   * and inserts at the viewport centre; cancelling returns to select.
   */
  selectTool(tool) {
    const s = S();
    s.setTool(tool);
    if (tool === 'image') void actions.insertImage();
  },

  /** Ask for an image file and insert it at `at` (default: viewport centre). */
  async insertImage(at = null) {
    let file = null;
    try {
      file = await openImagePicker();
    } catch {
      file = null;
    }
    if (!file) {
      if (S().tool === 'image') S().setTool('select');
      return [];
    }
    try {
      return await insertImageFiles([file], at ?? viewportCenter());
    } catch (err) {
      console.warn('[actions] image insert failed', err);
      toast.error(t.toast.imageFailed);
      if (S().tool === 'image') S().setTool('select');
      return [];
    }
  },

  /** Remove every element, as one undo step. */
  clearCanvas() {
    const s = S();
    const ids = s.elements.map((el) => el.id);
    if (!ids.length) return false;
    s.commit(once('clear'));
    s.removeElements(ids);
    S().clearSelection();
    return true;
  },

  /* --- files ---------------------------------------------------------------- */

  /**
   * Replace the board with a saved file (version 1 or 2). Ids are kept, so
   * re-opening a file saved from this board is an update, not a re-create.
   * One undo step. The caller confirms first when the board is not empty.
   * @returns {Promise<{ok:boolean, elements?:object[], error?:string}>}
   */
  async importFile(file) {
    if (!file) return { ok: false, error: 'no file' };
    let text;
    try {
      text = typeof file.text === 'function' ? await file.text() : String(file);
    } catch (err) {
      toast.error(t.toast.openFailed);
      return { ok: false, error: String(err?.message ?? err) };
    }
    const res = parseBoardFile(text);
    if (!res.ok) {
      toast.error(`${t.toast.openFailed}: ${res.error}`);
      return res;
    }
    const s = S();
    s.commit(once('import'));
    s.replaceAll(res.elements);
    S().clearSelection();
    if (S().tool !== 'select') S().setTool('select');
    actions.zoomToFit();
    toast.success(t.toast.opened(res.elements.length));
    return res;
  },

  /** Download the board as a JSON file (openable again with importFile). */
  saveToFile() {
    const s = S();
    const json = serializeBoard(s.elements, { board: s.board });
    downloadBlob(json, `${fileBaseName(s.board?.title)}.whiteboard.json`, 'application/json');
  },
};

function reorder(mode) {
  const s = S();
  if (s.selection.size === 0) return false;
  const next = reorderIds(s.elements, s.selection, mode);
  if (!next) return false;
  s.commit(once(`zorder-${mode}`));
  s.reorder(next);
  return true;
}

export default actions;
