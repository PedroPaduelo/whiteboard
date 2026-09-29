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
 * label (two quick duplicates, or two deletes, are two undo steps);
 * repeatable controls use a stable one so they coalesce (a held arrow key on
 * the same selection, keys held on a slider). A pointer drag on a control is
 * scoped by a gesture id instead (`applyStyle(patch, {gesture})`): one undo
 * step however long the button is held, pauses included.
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

import { LIMITS, ZOOM_LIMITS, fitView, stepZoom, tryValidateElement } from '@whiteboard/shared';
import { useBoardStore } from '../store/boardStore.js';
import { DUPLICATE_OFFSET, FONT_SIZES, NUDGE, NUDGE_SHIFT } from './constants.js';
import { cloneElements, createElement, newId, styleKeysFor, isText, isContainer } from './elements.js';
import { fitTextElement, labelBox, labelKeyOf, lineHeightPx, measureLine, textOf, wrapText } from './text.js';
import { commonBounds, elementBounds } from './handles.js';
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
/**
 * True while the last menu Copy / Cut reached ONLY `memoryClipboard` (no
 * async clipboard and the execCommand fallback refused too): the system
 * clipboard then holds something OLDER, and a paste must prefer the
 * in-memory copy (Excalidraw's PREFER_APP_CLIPBOARD). Cleared by any write
 * that did reach the system clipboard — ours, or a native copy/cut on the
 * page (`noteSystemClipboardWrite`).
 */
let preferMemoryClipboard = false;

/**
 * Copy `text` with the legacy `document.execCommand('copy')` on a throwaway
 * read-only textarea: the fallback where `navigator.clipboard` is missing (an
 * http origin reached by LAN IP or hostname) or refuses. It works inside the
 * click that picked the menu item. Focus goes back where it was. Returns
 * whether the browser reported the copy done; false without a DOM.
 */
export function copyTextViaExecCommand(text, doc = globalThis.document) {
  if (!doc?.body || typeof doc.execCommand !== 'function' || typeof doc.createElement !== 'function') return false;
  const active = doc.activeElement;
  const area = doc.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  // Off-screen but rendered (a display:none field cannot be selected); 12pt
  // keeps iOS from zooming in on it.
  area.style.cssText = 'position:fixed;top:0;left:-9999px;width:1px;height:1px;border:0;padding:0;margin:0;opacity:0;font-size:12pt';
  doc.body.appendChild(area);
  let ok = false;
  try {
    area.select();
    area.setSelectionRange?.(0, text.length);
    ok = Boolean(doc.execCommand('copy'));
  } catch {
    ok = false;
  }
  area.remove();
  try {
    if (active && active !== doc.body) active.focus?.({ preventScroll: true });
  } catch {
    /* the element went away with the menu */
  }
  return ok;
}

/**
 * Put `text` on the system clipboard from a menu (a native copy event fills
 * `clipboardData` itself): the async clipboard first, then the execCommand
 * fallback. Remembers whether it got there (`preferMemoryClipboard`).
 */
async function writeSystemClipboard(text) {
  let ok = false;
  const clip = globalThis.navigator?.clipboard;
  if (typeof clip?.writeText === 'function') {
    try {
      await clip.writeText(text);
      ok = true;
    } catch {
      /* permission denied / not focused: try the fallback */
    }
  }
  if (!ok) ok = copyTextViaExecCommand(text);
  preferMemoryClipboard = !ok;
  return ok;
}

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

/**
 * Plain pasted text as a text element can hold it: line breaks normalised to
 * '\n', then cut to LIMITS.MAX_TEXT (the server rejects a longer text) — never
 * in the middle of a surrogate pair, which would leave half an emoji.
 * `truncated` says whether anything was dropped, so the caller can say so.
 * @returns {{text: string, truncated: boolean}}
 */
export function clampPastedText(raw, max = LIMITS.MAX_TEXT) {
  const text = String(raw ?? '').replace(/\r\n?/g, '\n');
  if (text.length <= max) return { text, truncated: false };
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // a high surrogate whose pair is past the cut
  return { text: text.slice(0, end), truncated: true };
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

/** A single word is never allowed to widen a shape past this many font sizes (a pasted URL would). */
const MAX_WORD_EM = 20;
/** How much of the label box width is the shape's width, per type (see text.js labelBox). */
const LABEL_WIDTH_RATIO = { ellipse: Math.SQRT1_2, diamond: 0.5 };

/**
 * Grow `size` (a shape width or height) until `inner(size)` — the label box's
 * matching side for that size — reaches `need`. The label box is linear in the
 * size (minus fixed padding), so one step lands; a couple more absorb rounding.
 */
function growToFit(size, need, ratio, inner) {
  let next = size;
  for (let i = 0; i < 4 && inner(next) < need - 0.01; i++) next += (need - inner(next)) / ratio;
  return Math.ceil(next);
}

/**
 * The geometry a labelled shape (rect, ellipse, diamond, cylinder, sticky)
 * needs so its label fits after a font change: wide enough that no word is
 * split mid-word (capped, so one giant word still wraps), then tall enough
 * for every wrapped line. Shapes only GROW (Excalidraw), about their centre,
 * which also keeps rotated shapes in place.
 *
 * @returns {{x:number, y:number, w:number, h:number}|null} null when it already fits
 */
export function fitContainerToLabel(el) {
  if (!el || !labelKeyOf(el)) return null;
  const text = textOf(el);
  if (!text || !text.trim()) return null;
  const fontFamily = el.fontFamily ?? 'hand';
  const fontSize = el.fontSize ?? FONT_SIZES.M;
  const ratio = el.type === 'sticky' ? 1 : LABEL_WIDTH_RATIO[el.type] ?? 1;

  let w = el.w;
  let h = el.h;
  let widest = 0;
  for (const word of text.split(/\s+/)) if (word) widest = Math.max(widest, measureLine(word, fontFamily, fontSize));
  const needW = Math.min(Math.ceil(widest), fontSize * MAX_WORD_EM);
  if (labelBox({ ...el, w, h }).w < needW) w = growToFit(w, needW, ratio, (size) => labelBox({ ...el, w: size, h }).w);

  const lines = wrapText(text, labelBox({ ...el, w, h }).w, fontFamily, fontSize);
  const needH = Math.ceil(lines.length * lineHeightPx(fontSize));
  if (labelBox({ ...el, w, h }).h < needH) h = growToFit(h, needH, ratio, (size) => labelBox({ ...el, w, h: size }).h);

  if (w === el.w && h === el.h) return null;
  return { x: el.x - (w - el.w) / 2, y: el.y - (h - el.h) / 2, w, h };
}

/**
 * Is any element at least partly inside the viewport? `size` is the canvas'
 * CSS size. The "Voltar ao conteúdo" pill shows while this is false on a
 * board with content; stops at the first visible element.
 */
export function anyElementVisible(elements, view, size) {
  if (!elements?.length || !size) return false;
  const z = view?.zoom || 1;
  const x0 = -(view?.panX ?? 0) / z;
  const y0 = -(view?.panY ?? 0) / z;
  const x1 = x0 + size.w / z;
  const y1 = y0 + size.h / z;
  for (const el of elements) {
    const b = elementBounds(el);
    if (b.x <= x1 && b.x + b.w >= x0 && b.y <= y1 && b.y + b.h >= y0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * Groups (nested)
 * ------------------------------------------------------------------ */

/**
 * The group structure of a board.
 *
 * The model has ONE `groupId` per element. Nesting rides on the rule it
 * already has for legacy frames (EDITOR_CONTRACT §1): an element whose own
 * `id` is some other element's `groupId` is a member of that group too, and
 * scene.js `expandSelectionToGroups` follows that link outward ("a frame
 * that is itself in a group pulls that outer group in"). So an element can
 * carry an inner group's link to its parent: the inner group is keyed by the
 * element's id (the element is the group's ANCHOR) and the element's own
 * `groupId` names the group around it.
 *
 *     A {groupId: N}   B {groupId: 'A'}   C {groupId: N}
 *     -> group 'A' = {A, B}, nested in group N = {A, B, C}
 *
 * Grouping a group with something else nests it this way, and ungrouping
 * removes ONE level, so the inner group comes back (Excalidraw). Grouping
 * used to give every picked element one fresh key, which flattened the inner
 * group for good.
 *
 * @returns {{byId: Map<string, object>, keys: Set<string>,
 *   chains: Map<string, string[]>, members: Map<string, Set<string>>}}
 *   `chains`: element id -> its group keys, innermost first;
 *   `members`: group key -> every element inside it, nested ones included.
 */
export function groupTree(elements = []) {
  const byId = new Map();
  const keys = new Set();
  for (const el of elements) {
    byId.set(el.id, el);
    if (el.groupId) keys.add(el.groupId);
  }
  const chains = new Map();
  const members = new Map();
  for (const el of elements) {
    const chain = [];
    // An anchor's innermost group is the one named by its id; everyone
    // else's is its groupId. A key's parent is its anchor's groupId.
    let k = keys.has(el.id) ? el.id : el.groupId ?? null;
    while (k && !chain.includes(k)) {
      chain.push(k);
      k = byId.get(k)?.groupId ?? null;
    }
    chains.set(el.id, chain);
    for (const key of chain) {
      let set = members.get(key);
      if (!set) members.set(key, (set = new Set()));
      set.add(el.id);
    }
  }
  return { byId, keys, chains, members };
}

/**
 * How a selection splits into what `group()` would put side by side: whole
 * groups (for each picked element, the OUTERMOST of its groups that lies
 * entirely inside the selection) and loose elements (in no group, or only in
 * groups that are partly selected — after double-clicking into a group).
 */
function groupUnits(elements, picked) {
  const tree = groupTree(elements);
  const pickedIds = new Set(picked.map((el) => el.id));
  const whole = new Map();
  const isWhole = (key) => {
    if (!whole.has(key)) {
      let ok = true;
      for (const id of tree.members.get(key) ?? []) {
        if (!pickedIds.has(id)) {
          ok = false;
          break;
        }
      }
      whole.set(key, ok);
    }
    return whole.get(key);
  };
  const units = new Set();
  const loose = [];
  for (const el of picked) {
    let unit = null;
    // Groups only grow outward, so the first partly selected one ends the walk.
    for (const key of tree.chains.get(el.id) ?? []) {
      if (!isWhole(key)) break;
      unit = key;
    }
    if (unit) units.add(unit);
    else loose.push(el);
  }
  return { tree, units, loose };
}

/**
 * What the group buttons can do for the selection: `canGroup` is false when
 * fewer than two elements are selected or the selection is ALREADY exactly
 * one group (`group()` would do nothing, so the UI does not offer it);
 * `canUngroup` when something selected is in a group.
 */
export function groupAvailability(state = S()) {
  const picked = selectedElements(state);
  if (!picked.length) return { canGroup: false, canUngroup: false };
  const { tree, units, loose } = groupUnits(state.elements, picked);
  return {
    canGroup: picked.length > 1 && !(loose.length === 0 && units.size === 1),
    canUngroup: picked.some((el) => tree.chains.get(el.id)?.length > 0),
  };
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

/**
 * One zoom-in (`dir` > 0) or zoom-out (< 0) step about the viewport centre.
 * The step is ADDED (shared `stepZoom`, ±10 percentage points), as in
 * Excalidraw, so the footer reads 110%, 120%… and 90%, 80%… — a ×1.25 factor
 * gave 125, 156, 195, 244%. The new zoom is set exactly (not as a factor of
 * the old one), so a run of steps never drifts into 119.99999%.
 */
function stepViewZoom(dir) {
  const s = S();
  const zoom = s.view.zoom || 1;
  const next = stepZoom(zoom, dir);
  if (next === zoom) return;
  const { w, h } = viewportSize(s);
  const centre = { x: w / 2, y: h / 2 };
  const c = screenToBoardPoint(centre, s.view);
  s.setView({ zoom: next, panX: centre.x - c.x * next, panY: centre.y - c.y * next });
}

/** The in-place text editor's textarea (editor/TextEditor.jsx). */
const TEXT_EDITOR_SELECTOR = '[data-testid="text-editor"]';

/**
 * End an open text / label edit the way leaving the field does: blurring the
 * textarea runs its commit (TextEditor commits on blur, exactly once), which
 * writes the text to the store synchronously. Returns whether an edit was
 * open. A no-op without a DOM (node tests) or without an editor.
 */
export function commitActiveTextEdit(doc = typeof document !== 'undefined' ? document : null) {
  const active = doc?.activeElement;
  if (!active || typeof active.matches !== 'function' || !active.matches(TEXT_EDITOR_SELECTOR)) return false;
  active.blur();
  return true;
}

/**
 * The nudge label: a held arrow key coalesces while the SAME elements are
 * nudged; nudging another selection is its own undo step even inside the
 * store's 500 ms window (a fixed 'nudge' merged A's and C's nudges).
 */
let nudgeScope = { ids: null, label: null };
function nudgeLabel(ids) {
  const prev = nudgeScope.ids;
  const same = prev && prev.size === ids.length && ids.every((id) => prev.has(id));
  if (!same) nudgeScope = { ids: new Set(ids), label: once('nudge') };
  return nudgeScope.label;
}

/**
 * The arrow-key step in board units (Excalidraw): with grid mode on, a plain
 * arrow moves one grid cell, so a snapped element stays on the grid, and
 * Shift+arrow moves 1 unit for fine placement; otherwise 1 unit, and Shift
 * NUDGE_SHIFT. (The step used to ignore the grid: one press knocked a snapped
 * element off it.)
 */
export function nudgeStep(shiftKey, state = S()) {
  const grid = state?.snapEnabled && state.gridSize > 0 ? state.gridSize : 0;
  if (grid) return shiftKey ? NUDGE : grid;
  return shiftKey ? NUDGE_SHIFT : NUDGE;
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
      // Unique: two deletes in quick succession are two undo steps.
      api.commit(once('delete'));
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

  /**
   * Copy the selection to the system clipboard (menus; Ctrl+C uses the copy
   * event). Without an async clipboard it falls back to execCommand('copy');
   * if that fails too, the in-memory copy still pastes here — and wins over
   * the older system text on the next paste, Ctrl+V included. Resolves
   * whether the system clipboard got it (false for an empty selection).
   */
  async copy() {
    const text = actions.selectionClipboardText();
    if (!text) return false;
    return writeSystemClipboard(text);
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

  /** Cut to the system clipboard (menus; Ctrl+X uses the cut event), with copy()'s fallbacks. */
  async cut() {
    const text = actions.cutSelection();
    if (!text) return false;
    return writeSystemClipboard(text);
  },

  /**
   * What a paste EVENT (Ctrl+V) should paste, given the system clipboard's
   * text: that text, unless the last menu Copy / Cut could only reach the
   * in-memory clipboard — then the system text is older than it, and the
   * in-memory copy wins (it used to paste the stale system text instead).
   */
  clipboardTextForPaste(systemText) {
    if (preferMemoryClipboard && memoryClipboard) return memoryClipboard;
    return systemText ?? '';
  },

  /**
   * The page just put something on the system clipboard through a native
   * copy / cut (Ctrl+C on a text field or on the board): it is now newer than
   * any in-memory-only copy, so pastes follow the system clipboard again.
   */
  noteSystemClipboardWrite() {
    preferMemoryClipboard = false;
  },

  /**
   * Paste clipboard text centred on `at` (board units; default the viewport
   * centre). Our JSON pastes elements with fresh ids and remapped bindings;
   * any other text becomes a text element, cut to the element text limit
   * (with a toast saying so). `text` null reads the system clipboard (menus),
   * falling back to the last in-app copy; when the browser will not let the
   * page read it and there is no in-app copy, the toast says to use the
   * keyboard instead (`keyHint`, e.g. 'Ctrl+V').
   * @param {string|null} [textOrNull]
   * @param {{x:number, y:number}|null} [at]
   * @param {{keyHint?: string}} [opts]
   * @returns {Promise<object[]>} the inserted elements
   */
  async paste(textOrNull = null, at = null, { keyHint = '' } = {}) {
    let text = textOrNull;
    if (text == null) {
      let readFailed = false;
      if (preferMemoryClipboard && memoryClipboard) {
        text = memoryClipboard;
      } else {
        const clip = globalThis.navigator?.clipboard;
        if (typeof clip?.readText === 'function') {
          try {
            text = await clip.readText();
          } catch {
            readFailed = true; // permission denied
          }
        } else {
          readFailed = true; // no async clipboard (http origin)
        }
        if (!text) text = memoryClipboard;
      }
      if (!text) {
        toast.info(readFailed ? t.toast.pasteBlocked(keyHint) : t.toast.nothingToPaste);
        return [];
      }
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
    const { text: str, truncated } = clampPastedText(text);
    if (!str.trim()) {
      toast.info(t.toast.nothingToPaste);
      return [];
    }
    // The limit is the server's (a longer text is rejected): keep what fits,
    // but never drop the rest silently.
    if (truncated) toast.info(t.toast.pasteTruncated(LIMITS.MAX_TEXT));
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

  /**
   * Group the selection under a fresh group key. Whole groups in it are
   * NESTED, not flattened (see groupTree): a group keyed by an element (a
   * legacy frame, or one nested before) hangs in by its anchor's groupId; a
   * group with a free key first gets an anchor — one of its direct members
   * that anchors nothing else, whose id becomes the inner group's key. Only
   * a group made purely of other groups has no member that could carry the
   * link (one groupId per element); that one level merges into the new
   * group, and the groups inside it stay. Returns false for fewer than two
   * elements or a selection that already is exactly one group.
   */
  group() {
    const s = S();
    const picked = selectedElements(s);
    if (picked.length < 2) return false;
    const { tree, units, loose } = groupUnits(s.elements, picked);
    if (!loose.length && units.size === 1) return false; // already exactly one group
    const groupId = newId();
    const patches = new Map();
    const setGroup = (el, next) => {
      if ((el.groupId ?? null) !== next) patches.set(el.id, { id: el.id, patch: { groupId: next } });
    };
    // Loose elements join directly (leaving a partly selected group, as before).
    for (const el of loose) setGroup(el, groupId);
    for (const key of units) {
      const anchor = tree.byId.get(key);
      if (anchor) {
        setGroup(anchor, groupId);
        continue;
      }
      const direct = s.elements.filter((el) => el.groupId === key);
      const lead = direct.find((el) => !tree.keys.has(el.id));
      if (lead) {
        for (const el of direct) if (el !== lead) setGroup(el, lead.id);
        setGroup(lead, groupId);
      } else {
        for (const el of direct) setGroup(el, groupId);
      }
    }
    s.commit(once('group'));
    s.updateElements([...patches.values()]);
    return true;
  },

  /**
   * Ungroup ONE level (Excalidraw): each selected whole group is dissolved,
   * its direct members moving up into the group around it (none for a
   * top-level group), so a group nested inside it comes back as it was. A
   * member picked on its own (inside a double-clicked group) leaves its
   * innermost group; a legacy frame picked on its own frees its children.
   */
  ungroup() {
    const s = S();
    const picked = selectedElements(s);
    if (!picked.length) return false;
    const { tree, units, loose } = groupUnits(s.elements, picked);
    const patches = new Map();
    const setGroup = (el, next) => {
      if ((el.groupId ?? null) !== next) patches.set(el.id, { id: el.id, patch: { groupId: next } });
    };
    const parentOf = (key) => {
      const parent = tree.byId.get(key)?.groupId ?? null;
      return parent === key ? null : parent;
    };
    const dissolve = (key) => {
      const parent = parentOf(key);
      for (const el of s.elements) if (el.groupId === key) setGroup(el, parent);
    };
    for (const key of units) dissolve(key);
    for (const el of loose) {
      const inner = tree.chains.get(el.id)?.[0];
      if (!inner) continue;
      if (inner === el.id) dissolve(inner);
      else setGroup(el, parentOf(inner));
    }
    if (!patches.size) return false;
    s.commit(once('ungroup'));
    s.updateElements([...patches.values()]);
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
    s.commit(nudgeLabel(picked.map((el) => el.id)));
    s.updateElements([...patches, ...bind]);
    return true;
  },

  /* --- view --------------------------------------------------------- */

  /** One step in (the + button, Ctrl+=): +10 percentage points, about the viewport centre. */
  zoomIn() {
    stepViewZoom(1);
  },

  /** One step out (the − button, Ctrl+-): −10 percentage points, about the viewport centre. */
  zoomOut() {
    stepViewZoom(-1);
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

  /**
   * Bring the content back into view (Excalidraw's "Scroll back to
   * content"): centred at the current zoom, or framed when it would not fit
   * at this zoom (never magnifying). Returns false on an empty board.
   */
  scrollToContent() {
    const s = S();
    const b = commonBounds(s.elements);
    if (!b) return false;
    const { w, h } = viewportSize(s);
    const z = s.view.zoom || 1;
    if (b.w * z > w || b.h * z > h) {
      setViewFit(b, Math.min(z, FIT_MAX_ZOOM));
      return true;
    }
    s.setView({ zoom: z, panX: Math.round(w / 2 - (b.x + b.w / 2) * z), panY: Math.round(h / 2 - (b.y + b.h / 2) * z) });
    return true;
  },

  /** Grid mode (shows the grid and snaps), Excalidraw's Ctrl+'. */
  toggleGrid() {
    S().toggleSnap();
  },

  /* --- style ------------------------------------------------------------ */

  /**
   * Change a style property: the default for new elements AND the selection.
   * Each selected element receives only the keys its type uses
   * (`styleKeysFor`), free text is re-measured after font changes (and a
   * labelled shape grows to keep its label inside, `fitContainerToLabel`), and
   * the whole edit is ONE undo step labelled by the control (`style:stroke`), so a
   * burst of changes (keys held on a slider, a colour-picker drag) coalesces.
   *
   * `gesture`: an id for one pointer drag on a control (the opacity slider),
   * from pointerdown to pointerup. Its first change commits and the rest
   * ride on that entry, so the drag is ONE undo step even when the button is
   * held still for longer than the store's 500 ms coalescing window.
   *
   * Sticky notes keep their own default colour (`style.stickyFill`): a
   * background picked while a note is selected (or the sticky tool is active)
   * becomes the next note's colour, not every rectangle's.
   *
   * @param {object} patch e.g. `{stroke: '#e03131'}`
   * @param {{gesture?: string|null}} [opts]
   * @returns {boolean} whether any element changed
   */
  applyStyle(patch, { gesture = null } = {}) {
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
      if ('fontFamily' in p || 'fontSize' in p) {
        if (isText(el)) {
          Object.assign(p, fitTextElement({ ...el, ...p }));
          refit.push(el.id);
        } else {
          // A labelled shape grows so its label still fits the new font.
          const fit = fitContainerToLabel({ ...el, ...p });
          if (fit) {
            Object.assign(p, fit);
            refit.push(el.id);
          }
        }
      }
      patches.push({ id: el.id, patch: p });
    }
    if (!patches.length) return false;
    const bind = refit.length ? resolveBindingPatches(applyPatches(s.elements, patches), refit) : [];
    const label = `style:${[...keys].sort().join('+')}${gesture ? `:${gesture}` : ''}`;
    // A gesture commits once: while the last undo entry is still its own
    // (nothing else committed, no undo since), later changes join it.
    if (!gesture || S()._lastCommit?.label !== label) s.commit(label);
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
   *
   * An open text / label edit is COMMITTED first (Excalidraw). The toolbar's
   * buttons keep focus in the textarea (they prevent mousedown), so without
   * this its blur-commit never ran: `setTool` cleared `editingId`, the editor
   * unmounted, and what was typed was lost (or, for a new text, the editor
   * lingered over the new tool).
   */
  selectTool(tool) {
    commitActiveTextEdit();
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
      // `error` is the Portuguese reason for the person; `detail` (the
      // parser's or validator's own English message) is for the console only.
      if (res.detail) console.warn('[actions] open failed:', res.code, res.detail);
      toast.error(res.error ? `${t.toast.openFailed}. ${res.error}` : t.toast.openFailed);
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
