/**
 * The board store — the single source of truth every other frontend agent
 * codes against.
 *
 * Four invariants hold this together, and everything else follows from them:
 *
 *  1. **`elements` IS the z-order.** Index 0 paints first (furthest back);
 *     the last index paints on top. There is no separate `z` field, and no
 *     action may mutate the array in place — every one returns a new array.
 *     In-place mutation is invisible to `subscribe`, which is exactly what
 *     `realtime/sync.js` watches, so an in-place push would never reach other
 *     peers and would still break React rendering.
 *
 *  2. **`commit(label)` is called BEFORE mutating.** It snapshots the current
 *     elements onto a bounded undo stack, so the snapshot is the state
 *     *before* the change and `undo` is just `replaceAll(top of past)`.
 *     Two commits with the same label inside 500ms coalesce into one entry,
 *     which is what turns "a drag emitted 60 updates" into one Ctrl+Z rather
 *     than sixty.
 *
 *  3. **Selection is a `Set<string>` that only ever holds live ids.** Every
 *     action that removes elements prunes the selection in the same pass.
 *     A selection pointing at a deleted id draws a selection box around
 *     nothing, at coordinates nobody can explain.
 *
 *  4. **Connectors never dangle.** Removing an element strips `startId`/
 *     `endId` from any connector that referenced it. A connector anchored to
 *     a ghost id is a permanent rendering bug: it can never be repositioned,
 *     because every resolve pass looks up an id that does not exist.
 */

import { create } from 'zustand';
import {
  GRID,
  IDENTITY_VIEW,
  ZOOM_LIMITS,
  TOOLS,
  DEFAULT_PALETTE,
  reboxPolyline,
  fitViewCompat,
  zoomAt,
  clampZoom,
} from '@whiteboard/shared';

const HISTORY_LIMIT = 50;
const COALESCE_MS = 500;

/** How long a remote cursor survives without an update. Peers leave silently. */
export const CURSOR_TTL_MS = 30_000;

/**
 * Bumped by `replaceAll` and `setSnapshot` — the two wholesale replacements.
 *
 * `realtime/sync.js` needs to tell "the user undid something" apart from
 * "the user nudged a shape", and the two are indistinguishable by looking at
 * the elements array alone. A plain diff would actually be correct for an
 * undo, but the contract asks for an explicit clear+create there, and a
 * counter is the cheapest way to say so. It is deliberately NOT store state:
 * nothing renders from it, so it must not trigger a re-render.
 */
export const historyEpoch = { value: 0 };

const now = () => Date.now();

/** @returns {object} a fresh state object. `reset()` returns exactly this. */
export function initialState() {
  return {
    // board lifecycle
    boardId: null,
    board: null,
    elements: [],
    rev: 0,
    status: 'idle',
    error: null,

    // interaction
    tool: 'select',
    style: { ...DEFAULT_PALETTE },
    view: { ...IDENTITY_VIEW },
    gridSize: GRID.defaultSize,
    snapEnabled: true,

    selection: new Set(),
    hoveredId: null,
    editingId: null,
  resizingId: null,
    marquee: null,

    // collaborators
    peers: [],
    myPeerId: null,
    remoteCursors: new Map(),

    // history — internal stacks, surfaced as canUndo/canRedo/pastDepth/futureDepth
    canUndo: false,
    canRedo: false,
    pastDepth: 0,
    futureDepth: 0,
    _past: [],
    _future: [],
    _lastCommit: { label: null, at: 0 },
  };
}

/** Map of id -> element, for O(1) membership tests. Rebuilt per action. */
function indexById(elements) {
  const m = new Map();
  for (let i = 0; i < elements.length; i++) m.set(elements[i].id, elements[i]);
  return m;
}

/**
 * Types whose bounding box is DERIVED from `points` rather than authored.
 * Only these rebox; for everything else x/y/w/h is the truth.
 */
const isPolyline = (el) => el.type === 'pen' || el.type === 'arrow' || el.type === 'line';

/** Drop selection/hover/edit ids that no longer exist. Returns the SAME Set if nothing changed. */
function pruneSelection(selection, liveIds) {
  let changed = false;
  const next = new Set();
  for (const id of selection) {
    if (liveIds.has(id)) next.add(id);
    else changed = true;
  }
  return changed ? next : selection;
}

/**
 * Reorder to match `orderedIds`. Unknown ids are ignored and any element the
 * caller forgot keeps its relative position at the end — a reorder that
 * silently dropped elements would be data loss wearing a sorting hat.
 */
function orderBy(elements, orderedIds) {
  const byId = indexById(elements);
  const next = [];
  const seen = new Set();
  for (const id of orderedIds) {
    const el = byId.get(id);
    if (!el || seen.has(id)) continue;
    seen.add(id);
    next.push(el);
  }
  for (const el of elements) if (!seen.has(el.id)) next.push(el);
  return next;
}

/**
 * Remove ids and detach connectors pointing at them. The connector itself
 * survives — an arrow whose end-box vanished is still a line the user drew;
 * only the *reference* is stripped.
 *
 * @returns {{elements: Element[], removed: Element[], detached: number}}
 */
function removeAndDetach(elements, ids) {
  const gone = ids instanceof Set ? ids : new Set(ids);
  if (gone.size === 0) return { elements, removed: [], detached: 0 };

  const removed = [];
  const kept = [];
  for (const el of elements) {
    if (gone.has(el.id)) removed.push(el);
    else kept.push(el);
  }
  if (removed.length === 0) return { elements, removed, detached: 0 };

  let detached = 0;
  const next = kept.map((el) => {
    if (el.type !== 'arrow' && el.type !== 'line') return el;
    const hitStart = Boolean(el.startId) && gone.has(el.startId);
    const hitEnd = Boolean(el.endId) && gone.has(el.endId);
    if (!hitStart && !hitEnd) return el;
    detached += 1;
    const patched = { ...el };
    if (hitStart) delete patched.startId;
    if (hitEnd) delete patched.endId;
    return patched;
  });

  return { elements: next, removed, detached };
}

/** A viewport size, with a DOM fallback for code running before mount. */
function viewportSize(override) {
  const vw = override?.vw ?? (typeof window !== 'undefined' ? window.innerWidth : 1440);
  const vh = override?.vh ?? (typeof window !== 'undefined' ? window.innerHeight : 900);
  return { vw, vh };
}

export const useBoardStore = create((set, get) => ({
  ...initialState(),

  // ----------------------------------------------------------------- board

  setBoardId(id) {
    set({ boardId: id ?? null });
  },

  setBoard(board) {
    set((s) => ({ board: board ?? null, boardId: board ? board.id : s.boardId }));
  },

  /**
   * Hydrate from a `BoardSnapshot`. This is the one place a whole board
   * arrives from the network, so it is also the one place history is
   * dropped — a resync must never become undoable.
   */
  setSnapshot({ board, elements, rev } = {}) {
    const els = Array.isArray(elements) ? elements.slice() : [];
    set((s) => {
      const liveIds = indexById(els);
      return {
        board: board ?? s.board,
        boardId: board ? board.id : s.boardId,
        elements: els,
        rev: typeof rev === 'number' ? rev : s.rev,
        selection: pruneSelection(s.selection, liveIds),
        hoveredId: s.hoveredId !== null && liveIds.has(s.hoveredId) ? s.hoveredId : null,
        editingId: s.editingId !== null && liveIds.has(s.editingId) ? s.editingId : null,
        canUndo: false,
        canRedo: false,
        pastDepth: 0,
        futureDepth: 0,
        _past: [],
        _future: [],
        _lastCommit: { label: null, at: 0 },
      };
    });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error) {
    set({ error: error ?? null });
  },

  /**
   * Advance the board rev without touching elements. Called on every ack and
   * on every remote broadcast, so `baseRev` on the next outgoing batch is the
   * one the server actually has.
   */
  setRev(rev) {
    const n = Number(rev);
    if (!Number.isFinite(n)) return;
    set({ rev: n });
  },

  /** Board switcher and test teardown: wipe back to a clean slate. */
  reset() {
    set(initialState());
  },

  // -------------------------------------------------------------- elements

  /**
   * Add one element on TOP of the z-order (end of the array).
   *
   * Callers commit FIRST (`commit('add')` then `addElement(el)`), per the
   * contract. These actions deliberately do NOT commit themselves: the
   * canvas's `interaction` reducer emits `commit` and `addElement` as
   * separate effects, and a hidden commit here would add a second history
   * entry per gesture, so one Ctrl+Z would undo only half a drag.
   */
  addElement(el) {
    if (!el || !el.id) return;
    set((s) => ({ elements: [...s.elements, el] }));
  },

  /** Add many as ONE history entry — a preset drop is one undo. */
  addElements(els) {
    const list = Array.isArray(els) ? els.filter((e) => e && e.id) : [];
    if (list.length === 0) return;
    set((s) => ({ elements: [...s.elements, ...list] }));
  },

  /**
   * Shallow-merge `patch` onto one element, then REBOX if the patch moved a
   * POLYLINE's points. The rebox is the whole reason this is not just
   * `{...el, ...patch}`: a pen stroke's box is derived from its points, so
   * appending a point without recomputing leaves the box behind the ink —
   * unselectable, unsnappable, unhit-testable.
   *
   * Only pen/arrow/line rebox. For every other type x/y/w/h *is* the truth,
   * so a stray `points` key in a patch must not overwrite it.
   */
  updateElement(id, patch) {
    if (!id || !patch) return;
    set((s) => {
      let touched = false;
      const next = s.elements.map((el) => {
        if (el.id !== id) return el;
        touched = true;
        // id and type are identity, not style: a patch can never change them.
        const merged = { ...el, ...patch, id: el.id, type: el.type };
        return isPolyline(el) && 'points' in patch ? reboxPolyline(merged) : merged;
      });
      return touched ? { elements: next } : {};
    });
  },

  /**
   * Apply many patches as ONE history entry and one render. A multi-select
   * drag is a single Ctrl+Z, not one per element, and re-walks the z-order
   * once instead of once per element.
   */
  updateElements(patches) {
    const list = Array.isArray(patches) ? patches.filter((p) => p && p.id && p.patch) : [];
    if (list.length === 0) return;
    set((s) => {
      const byId = new Map(list.map((p) => [p.id, p.patch]));
      let touched = false;
      const next = s.elements.map((el) => {
        const patch = byId.get(el.id);
        if (!patch) return el;
        touched = true;
        const merged = { ...el, ...patch, id: el.id, type: el.type };
        return isPolyline(el) && 'points' in patch ? reboxPolyline(merged) : merged;
      });
      return touched ? { elements: next } : {};
    });
  },

  /** Remove by id, detach connectors to them, prune the selection. */
  removeElements(ids) {
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (list.length === 0) return;
    set((s) => {
      const { elements, removed } = removeAndDetach(s.elements, list);
      if (removed.length === 0) return {};
      const live = indexById(elements);
      return {
        elements,
        selection: pruneSelection(s.selection, live),
        hoveredId: s.hoveredId !== null && live.has(s.hoveredId) ? s.hoveredId : null,
        editingId: s.editingId !== null && live.has(s.editingId) ? s.editingId : null,
      };
    });
  },

  /** Set the full z-order. See `orderBy` for how unknown ids are handled. */
  reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) return;
    set((s) => ({ elements: orderBy(s.elements, orderedIds) }));
  },

  /**
   * Wholesale replacement, used by undo/redo and by resync. It must NOT
   * touch history (it IS the history) and it must prune the selection.
   */
  replaceAll(els) {
    const next = Array.isArray(els) ? els.slice() : [];
    // Signal to the sync bridge that this is a wholesale swap (undo/redo),
    // not an incremental edit.
    historyEpoch.value += 1;
    set((s) => {
      const live = indexById(next);
      return {
        elements: next,
        selection: pruneSelection(s.selection, live),
        hoveredId: s.hoveredId !== null && live.has(s.hoveredId) ? s.hoveredId : null,
        editingId: s.editingId !== null && live.has(s.editingId) ? s.editingId : null,
      };
    });
  },

  /**
   * Apply one op that arrived from a remote peer. Like `replaceAll` this
   * bypasses history: someone else's edit is not something you Ctrl+Z.
   */
  applyRemoteOp(op) {
    if (!op || typeof op !== 'object') return;
    const { kind } = op;
    if (kind === 'create' && op.element) {
      set((s) =>
        s.elements.some((el) => el.id === op.element.id)
          ? {}
          : { elements: [...s.elements, op.element] },
      );
    } else if (kind === 'update' && op.elementId) {
      set((s) => ({
        elements: s.elements.map((el) => {
          if (el.id !== op.elementId) return el;
          const merged = { ...el, ...op.patch, id: el.id, type: el.type };
          return isPolyline(el) && 'points' in (op.patch ?? {}) ? reboxPolyline(merged) : merged;
        }),
      }));
    } else if (kind === 'delete' && op.elementId) {
      set((s) => {
        const { elements, removed } = removeAndDetach(s.elements, [op.elementId]);
        if (removed.length === 0) return {};
        const live = indexById(elements);
        return {
          elements,
          selection: pruneSelection(s.selection, live),
          hoveredId: s.hoveredId !== null && live.has(s.hoveredId) ? s.hoveredId : null,
          editingId: s.editingId !== null && live.has(s.editingId) ? s.editingId : null,
        };
      });
    } else if (kind === 'reorder' && Array.isArray(op.order)) {
      set((s) => ({ elements: orderBy(s.elements, op.order) }));
    } else if (kind === 'clear') {
      set({ elements: [], selection: new Set(), hoveredId: null, editingId: null });
    }
  },

  // -------------------------------------------------------------- selection

  select(ids, { additive = false } = {}) {
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    set((s) => {
      const live = indexById(s.elements);
      const next = additive ? new Set(s.selection) : new Set();
      for (const id of list) if (live.has(id)) next.add(id);
      return { selection: next };
    });
  },

  toggleSelect(id) {
    if (!id) return;
    set((s) => {
      const live = indexById(s.elements);
      const next = new Set(s.selection);
      if (next.has(id)) next.delete(id);
      else if (live.has(id)) next.add(id);
      return { selection: next };
    });
  },

  clearSelection() {
    set({ selection: new Set(), marquee: null });
  },

  setHovered(id) {
    const next = id ?? null;
    if (get().hoveredId === next) return;
    set({ hoveredId: next });
  },

  /**
   * Which node is mid-resize, if any.
   *
   * The store tracks only the id: React Flow owns the live measurement, and
   * the node model drops its pinned width/height for this node so the
   * measurement is what paints. Storing the measured size here instead would
   * write to the board on every pointermove of a resize — an op per frame and a
   * resync for every peer watching.
   */
  setResizing(id) {
    set({ resizingId: id ?? null });
  },

  setEditing(id) {
    set({ editingId: id ?? null });
  },

  setMarquee(rect) {
    set({ marquee: rect ?? null });
  },

  // ------------------------------------------------------------ tool & style

  setTool(tool) {
    if (!TOOLS.includes(tool)) return;
    set({ tool });
  },

  setStyle(patch) {
    if (!patch) return;
    set((s) => ({ style: { ...s.style, ...patch } }));
  },

  setGridSize(n) {
    const size = Number(n);
    if (!Number.isFinite(size)) return;
    // 0 is legal and means "snapping off".
    set({ gridSize: size < 0 ? 0 : Math.min(size, GRID.max) });
  },

  toggleSnap() {
    set((s) => ({ snapEnabled: !s.snapEnabled }));
  },

  // ------------------------------------------------------------------- view

  setView(v) {
    if (!v) return;
    set((s) => ({
      view: {
        zoom: v.zoom === undefined ? s.view.zoom : clampZoom(Number(v.zoom), ZOOM_LIMITS.min, ZOOM_LIMITS.max),
        panX: Number(v.panX ?? s.view.panX) || 0,
        panY: Number(v.panY ?? s.view.panY) || 0,
      },
    }));
  },

  setZoom(z) {
    set((s) => ({ view: { ...s.view, zoom: clampZoom(Number(z), ZOOM_LIMITS.min, ZOOM_LIMITS.max) } }));
  },

  setPan(x, y) {
    set((s) => ({ view: { ...s.view, panX: Number(x) || 0, panY: Number(y) || 0 } }));
  },

  /** Additive pan in SCREEN px. A view change is never history. */
  panBy(dx, dy) {
    set((s) => ({
      view: { ...s.view, panX: s.view.panX + (Number(dx) || 0), panY: s.view.panY + (Number(dy) || 0) },
    }));
  },

  /**
   * Zoom about a SCREEN point so the board pixel under the cursor stays put.
   * `factor` is a multiplier: 1.2 zooms in, 1/1.2 zooms out.
   */
  zoomAtScreen(screenPt, factor) {
    const f = Number(factor);
    if (!Number.isFinite(f) || f <= 0) return;
    set((s) => ({ view: zoomAt(s.view, { x: Number(screenPt?.x) || 0, y: Number(screenPt?.y) || 0 }, f) }));
  },

  /**
   * Frame every element. Needs a viewport size, so it takes an optional
   * `{vw, vh}` and falls back to the window — the toolbar button has to work
   * before the canvas has reported its size.
   */
  fitToContent(size) {
    const { vw, vh } = viewportSize(size);
    set((s) => ({ view: fitViewCompat(s.elements, vw, vh) }));
  },

  resetView() {
    set({ view: { ...IDENTITY_VIEW } });
  },

  // ---------------------------------------------------------------- history

  /**
   * Snapshot the CURRENT elements so the next mutation is undoable. Call
   * this BEFORE mutating. Two calls with the same label within 500ms merge
   * into one entry — the difference between one undo step for a drag and
   * sixty for the same drag.
   */
  commit(label = 'edit') {
    set((s) => {
      const t = now();
      const coalesce = s._lastCommit.label === label && t - s._lastCommit.at < COALESCE_MS && s._past.length > 0;
      // When coalescing we KEEP the older snapshot: it is the state before
      // the whole gesture, which is the only one worth restoring.
      const past = coalesce ? s._past : [...s._past, s.elements.slice()];
      const trimmed = past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
      return {
        _past: trimmed,
        _future: [],
        canUndo: trimmed.length > 0,
        canRedo: false,
        pastDepth: trimmed.length,
        futureDepth: 0,
        _lastCommit: { label, at: t },
      };
    });
  },

  undo() {
    const s = get();
    if (s._past.length === 0) return;
    const previous = s._past[s._past.length - 1];
    const future = [...s._future, s.elements.slice()];
    const trimmed = future.length > HISTORY_LIMIT ? future.slice(future.length - HISTORY_LIMIT) : future;
    // Through `replaceAll`, not a direct write: that bumps the history epoch
    // so the sync bridge encodes an undo as clear+create rather than
    // guessing a diff, and it prunes the selection.
    get().replaceAll(previous);
    set({
      _past: s._past.slice(0, -1),
      _future: trimmed,
      canUndo: s._past.length > 1,
      canRedo: true,
      pastDepth: s._past.length - 1,
      futureDepth: trimmed.length,
      // Break coalescing, or the next commit would merge into the entry we
      // just consumed and undo would appear to do nothing.
      _lastCommit: { label: null, at: 0 },
    });
  },

  redo() {
    const s = get();
    if (s._future.length === 0) return;
    const next = s._future[s._future.length - 1];
    const past = [...s._past, s.elements.slice()];
    const trimmed = past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
    get().replaceAll(next);
    set({
      _past: trimmed,
      _future: s._future.slice(0, -1),
      canUndo: true,
      canRedo: s._future.length > 1,
      pastDepth: trimmed.length,
      futureDepth: s._future.length - 1,
      _lastCommit: { label: null, at: 0 },
    });
  },

  // ------------------------------------------------------------------ peers

  setMyPeerId(id) {
    set({ myPeerId: id ?? null });
  },

  setPeers(peers) {
    set({ peers: Array.isArray(peers) ? peers : [] });
  },

  upsertCursor(peerId, cur) {
    if (!peerId) return;
    set((s) => {
      const next = new Map(s.remoteCursors);
      next.set(peerId, {
        x: Number(cur?.x) || 0,
        y: Number(cur?.y) || 0,
        name: cur?.name ?? null,
        color: cur?.color ?? null,
        at: Number(cur?.at) || now(),
      });
      return { remoteCursors: next };
    });
  },

  /** Drop cursors that have gone quiet — peers leave without a goodbye. */
  pruneCursors(at = now()) {
    set((s) => {
      if (s.remoteCursors.size === 0) return {};
      let changed = false;
      const next = new Map();
      for (const [id, cur] of s.remoteCursors) {
        if (at - (cur.at ?? 0) > CURSOR_TTL_MS) changed = true;
        else next.set(id, cur);
      }
      return changed ? { remoteCursors: next } : {};
    });
  },
}));

/**
 * Subscribe to store mutations without importing zustand internals.
 * `realtime/sync.js` uses this to turn element changes into ops.
 *
 * @param {(state: object, prevState: object) => void} listener
 * @returns {() => void} unsubscribe
 */
export function subscribe(listener) {
  return useBoardStore.subscribe(listener);
}

/** Read the whole state outside React — canvas exports, tests, the sync bridge. */
export const getState = () => useBoardStore.getState();
