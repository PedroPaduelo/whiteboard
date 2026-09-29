/**
 * The board store — the single source of truth every other frontend module
 * codes against.
 *
 * Five invariants hold this together, and everything else follows from them:
 *
 *  1. **`elements` IS the z-order.** Index 0 paints first (furthest back);
 *     the last index paints on top. There is no separate `z` field, and no
 *     action may mutate the array (or an element) in place — every one
 *     returns a new array with new objects for what changed. In-place
 *     mutation is invisible to `subscribe`, which is exactly what
 *     `realtime/sync.js` watches, so an in-place push would never reach other
 *     peers and would still break rendering caches keyed by element object.
 *
 *  2. **`commit(label)` is called BEFORE mutating.** It snapshots the current
 *     elements onto a bounded undo stack, so the snapshot is the state
 *     *before* the change and `undo` is just `replaceAll(top of past)`.
 *     Two commits with the same label inside 500ms coalesce into one entry;
 *     gesture code uses a unique label per gesture (`move:<gestureId>`) and
 *     property edits one label per control (`style:stroke`), so a slider drag
 *     is one undo step and two quick drags are two.
 *
 *  3. **Undo only ever undoes YOUR edits.** Remote ops are applied to the
 *     present AND rebased into every undo/redo snapshot (`rebaseEntry`), so
 *     restoring a snapshot changes only what this user changed since it was
 *     taken. Without that, a Ctrl+Z would delete every element a collaborator
 *     created after your last commit — the diff would faithfully ship those
 *     deletes to everyone.
 *
 *  4. **Selection is a `Set<string>` that only ever holds live ids.** Every
 *     action that removes elements prunes the selection in the same pass.
 *
 *  5. **Connectors never dangle.** Removing an element strips `startId`/
 *     `endId` from any connector that referenced it, locally and for remote
 *     batches alike (the server does the same in `applyOpBatch`).
 *
 * Patch semantics (local `updateElement(s)` and remote `update` ops alike): a
 * value of `null` (or `undefined`) DELETES that key from the element. That is
 * how a connector end is unbound (`{startId: null}`) and how an element
 * leaves its group (`{groupId: null}`); the sync diff turns the missing key
 * back into `null` on the wire, which the server treats the same way.
 */

import { create } from 'zustand';
import {
  IDENTITY_VIEW,
  ZOOM_LIMITS,
  TOOLS,
  GRID,
  reboxPolyline,
  resolveConnectors,
  zoomAt,
  clampZoom,
} from '@whiteboard/shared';
import { DEFAULT_STYLE, GRID_SIZE } from '../editor/constants.js';
import { TOOL_BY_ID } from '../editor/tools.js';

const HISTORY_LIMIT = 50;
const COALESCE_MS = 500;

/** How long a remote cursor survives without an update. Peers leave silently. */
export const CURSOR_TTL_MS = 30_000;

/** Mirrors `RealtimeClient.status`. The UI renders a dot/label per value. */
export const CONNECTION_STATES = Object.freeze(['idle', 'connecting', 'connected', 'offline', 'disconnected']);

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
    /** Mirrors the realtime client's status: idle|connecting|connected|offline|disconnected. */
    connection: 'idle',

    // interaction
    tool: 'select',
    /** Excalidraw's tool lock (Q): keep the drawing tool after creating an element. */
    toolLocked: false,
    style: { ...DEFAULT_STYLE },
    view: { ...IDENTITY_VIEW },
    /** CSS px of the canvas element, reported by the Canvas' ResizeObserver. */
    viewportSize: { w: 0, h: 0 },
    gridSize: GRID_SIZE,
    /** Grid mode is off by default, like Excalidraw. */
    snapEnabled: false,

    selection: new Set(),
    hoveredId: null,
    editingId: null,

    // collaborators
    peers: [],
    myPeerId: null,
    remoteCursors: new Map(),
    /**
     * What each collaborator has selected: Map peerId -> {ids, color, name}
     * (`renderInteractive`'s `peerSelections`). Only non-empty selections are
     * kept; a peer that leaves the roster takes its entry with it.
     */
    peerSelections: new Map(),

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

/* ========================================================================
   Pure helpers (exported for tests and for the realtime bridge)
   ======================================================================== */

/** Map of id -> element, for O(1) membership tests. */
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
const isConnector = (el) => el.type === 'arrow' || el.type === 'line';

/** Keys whose change moves a polyline's box, so the box must be re-derived. */
const BOX_KEYS = ['points', 'x', 'y', 'w', 'h'];

/** Is `tool` one the app knows? Shared TOOLS plus the editor's TOOLBAR ids. */
function isKnownTool(tool) {
  return typeof tool === 'string' && (TOOLS.includes(tool) || Boolean(TOOL_BY_ID[tool]));
}

/** Same point sequence? x/y only — that is all the wire carries. */
function samePoints(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i]?.x !== b[i]?.x || a[i]?.y !== b[i]?.y) return false;
  }
  return true;
}

/**
 * Is `v` the value `el` already holds under `k`? By content, not reference:
 * every patch that crosses the wire (or is re-applied as a pending op)
 * carries a fresh copy of `points`, and treating an identical copy as a
 * change gave the element a new object — which the history rebase then read
 * as a REMOTE change and wrote into every undo snapshot.
 */
function sameValue(k, current, v) {
  if (current === v) return true;
  if (typeof v !== 'object' || v === null) return false;
  return k === 'points' ? samePoints(current, v) : jsonEqual(current, v);
}

/**
 * Merge a patch onto an element, returning a NEW element (or the same one when
 * the patch changes nothing — compared by content, see `sameValue`).
 * `null`/`undefined` values delete the key; `id` and `type` are identity and
 * never patched. A polyline whose points or box were touched is re-boxed from
 * its points — exactly what the server's `validateElement` does, so local and
 * server agree on the box.
 */
export function mergePatch(el, patch) {
  if (!patch || typeof patch !== 'object') return el;
  let out = null;
  let touchedBox = false;
  for (const k of Object.keys(patch)) {
    if (k === 'id' || k === 'type') continue;
    const v = patch[k];
    if (v === null || v === undefined) {
      if (!(k in el)) continue;
      if (!out) out = { ...el };
      delete out[k];
    } else {
      if (sameValue(k, el[k], v)) continue;
      if (!out) out = { ...el };
      out[k] = v;
    }
    if (BOX_KEYS.includes(k)) touchedBox = true;
  }
  if (!out) return el;
  return isPolyline(out) && touchedBox && Array.isArray(out.points) ? reboxPolyline(out) : out;
}

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

/** The selection/hover/edit fields, pruned against a new element list. */
function prunedInteraction(s, elements) {
  const live = indexById(elements);
  return {
    selection: pruneSelection(s.selection, live),
    hoveredId: s.hoveredId !== null && live.has(s.hoveredId) ? s.hoveredId : null,
    editingId: s.editingId !== null && live.has(s.editingId) ? s.editingId : null,
  };
}

/**
 * Reorder to match `orderedIds`. Unknown ids are ignored and any element the
 * caller forgot keeps its relative position at the end — the same rule the
 * server's `reorder` op follows, so both sides land on the same order.
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
  return sameSequence(next, elements) ? elements : next;
}

/** Same element objects in the same order? (Reference equality per slot.) */
function sameSequence(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Remove ids and detach connectors pointing at them. The connector itself
 * survives — an arrow whose end-box vanished is still a line the user drew;
 * only the *reference* is stripped.
 *
 * @returns {{elements: object[], removed: object[]}}
 */
function removeAndDetach(elements, ids) {
  const gone = ids instanceof Set ? ids : new Set(ids);
  if (gone.size === 0) return { elements, removed: [] };

  const removed = [];
  const kept = [];
  for (const el of elements) {
    if (gone.has(el.id)) removed.push(el);
    else kept.push(el);
  }
  if (removed.length === 0) return { elements, removed };
  return { elements: detachDangling(kept), removed };
}

/**
 * Strip `startId`/`endId` that point at ids not on the board. Non-mutating
 * twin of shared `detachMissingConnectors`. Returns the SAME array when
 * nothing dangles.
 */
function detachDangling(elements) {
  let live = null;
  let out = null;
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (!isConnector(el) || (!el.startId && !el.endId)) continue;
    if (!live) live = new Set(elements.map((e) => e.id));
    const badStart = Boolean(el.startId) && !live.has(el.startId);
    const badEnd = Boolean(el.endId) && !live.has(el.endId);
    if (!badStart && !badEnd) continue;
    const patched = { ...el };
    if (badStart) delete patched.startId;
    if (badEnd) delete patched.endId;
    if (!out) out = elements.slice();
    out[i] = patched;
  }
  return out ?? elements;
}

/**
 * Detach dangling connectors, then re-resolve bound ones with the shared
 * `resolveConnectors` — the same two steps, in the same order, as the
 * server's `applyOpBatch`, so a remote batch lands identically here and there.
 * Element objects that did not change keep their identity.
 */
export function settleConnectors(elements) {
  const detached = detachDangling(elements);
  const resolved = resolveConnectors(detached);
  if (!Array.isArray(resolved) || resolved === detached) return detached;
  return sameSequence(resolved, detached) ? detached : resolved;
}

/**
 * Apply a list of ops (create/update/delete/reorder/clear) to an element
 * list with the server's semantics: creates are idempotent by id and append
 * on top, updates of missing elements are skipped, unknown ids in a reorder
 * are ignored. Pure; returns the SAME array when nothing changed.
 *
 * `rebase: true` is for re-applying this client's UNACKNOWLEDGED ops on top
 * of newer server state: the server has not appended those creates yet and
 * will do so after everything it already holds, so a create whose element is
 * already here is moved to the top (keeping the local object) instead of
 * being skipped. Without it, two people adding a shape at the same moment
 * would each see their own on top.
 *
 * @param {object[]} elements
 * @param {object[]} ops
 * @param {{rebase?: boolean}} [opts]
 * @returns {{elements: object[], geometry: boolean}} `geometry` is true when
 *   a create/update/delete/clear touched the list (connectors need settling)
 */
export function applyOpsToElements(elements, ops, { rebase = false } = {}) {
  let work = elements;
  let copied = false;
  let index = null;
  let geometry = false;

  const own = () => {
    if (!copied) {
      work = work.slice();
      copied = true;
    }
  };
  const positions = () => {
    if (!index) {
      index = new Map();
      for (let i = 0; i < work.length; i++) index.set(work[i].id, i);
    }
    return index;
  };

  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    switch (op.kind) {
      case 'create': {
        const el = op.element;
        if (!el || !el.id) break;
        const at = positions().get(el.id);
        if (at !== undefined) {
          if (!rebase || at === work.length - 1) break;
          own();
          const [existing] = work.splice(at, 1);
          work.push(existing);
          index = null;
          break;
        }
        own();
        index.set(el.id, work.length);
        work.push(el);
        geometry = true;
        break;
      }
      case 'update': {
        const i = op.elementId ? positions().get(op.elementId) : undefined;
        if (i === undefined) break;
        const merged = mergePatch(work[i], op.patch);
        if (merged === work[i]) break;
        own();
        work[i] = merged;
        geometry = true;
        break;
      }
      case 'delete': {
        const i = op.elementId ? positions().get(op.elementId) : undefined;
        if (i === undefined) break;
        own();
        work.splice(i, 1);
        index = null;
        geometry = true;
        break;
      }
      case 'reorder': {
        if (!Array.isArray(op.order)) break;
        const next = orderBy(work, op.order);
        if (next === work) break;
        work = next;
        copied = true;
        index = null;
        break;
      }
      case 'clear': {
        if (work.length === 0) break;
        work = [];
        copied = true;
        index = null;
        geometry = true;
        break;
      }
      default:
        break;
    }
  }
  return { elements: work, geometry };
}

/* ------------------------------------------------------------ history rebase */

/**
 * The survivors (ids in both lists) whose relative order changed from `prev`
 * to `next`: everything outside ONE longest run that kept its order (a
 * longest increasing subsequence of prev positions, O(n log n)). A "bring to
 * front" of one element moves exactly that element; creates and deletes move
 * nothing.
 */
function movedSurvivors(prev, next, after) {
  const posInPrev = new Map();
  let n = 0;
  for (const el of prev) if (after.has(el.id)) posInPrev.set(el.id, n++);
  const seq = [];
  const ids = [];
  for (const el of next) {
    const p = posInPrev.get(el.id);
    if (p === undefined) continue;
    seq.push(p);
    ids.push(el.id);
  }
  const tails = [];
  const link = new Array(seq.length);
  for (let k = 0; k < seq.length; k++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < seq[k]) lo = mid + 1;
      else hi = mid;
    }
    link[k] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = k;
  }
  const kept = new Set();
  for (let k = tails.length > 0 ? tails[tails.length - 1] : -1; k >= 0; k = link[k]) kept.add(ids[k]);
  const moved = new Set();
  if (kept.size === ids.length) return moved;
  for (const id of ids) if (!kept.has(id)) moved.add(id);
  return moved;
}

/**
 * Describe the transition `prev -> next` (a remote batch, a resync) so it can
 * be replayed onto undo/redo snapshots. Changes are found by object identity,
 * which is cheap and exact because nothing mutates in place.
 *
 * `moved` are the survivors whose relative order changed; `order` is the new
 * order when any did (null otherwise); `next` is always the new order, which
 * is where created and moved elements find their neighbours.
 *
 * @returns {null | {created: object[], changed: Map<string,{before:object, after:object}>,
 *   deleted: Set<string>, moved: Set<string>, order: string[]|null, next: string[]}}
 */
export function describeTransition(prev, next) {
  if (prev === next) return null;
  const before = indexById(prev);
  const after = indexById(next);
  const created = [];
  const changed = new Map();
  for (const el of next) {
    const old = before.get(el.id);
    if (!old) created.push(el);
    else if (old !== el) changed.set(el.id, { before: old, after: el });
  }
  const deleted = new Set();
  for (const el of prev) if (!after.has(el.id)) deleted.add(el.id);

  // Did the relative order of the survivors change? (Creates append on top
  // and deletes just vanish; neither is a reorder by itself.)
  const moved = movedSurvivors(prev, next, after);

  if (created.length === 0 && changed.size === 0 && deleted.size === 0 && moved.size === 0) return null;
  const nextIds = next.map((el) => el.id);
  return { created, changed, deleted, moved, order: moved.size > 0 ? nextIds : null, next: nextIds };
}

/**
 * Replay a remote field-level change onto an older version of an element:
 * every key the remote changed takes the remote value (or disappears), and
 * every key it did not touch keeps the snapshot's value. "Changed" is by
 * content (see `sameValue`), so a fresh copy of the same points is not a
 * change that overwrites the snapshot's points.
 */
function applyDelta(el, before, after) {
  let out = null;
  for (const k of Object.keys(after)) {
    if (sameValue(k, before[k], after[k]) || sameValue(k, el[k], after[k])) continue;
    if (!out) out = { ...el };
    out[k] = after[k];
  }
  for (const k of Object.keys(before)) {
    if (k in after || !(k in el)) continue;
    if (!out) out = { ...el };
    delete out[k];
  }
  if (!out) return el;
  return isPolyline(out) && Array.isArray(out.points) ? reboxPolyline(out) : out;
}

/** Positions of ids in a history snapshot, cached per (immutable) array. */
const positionCache = new WeakMap();
function positionsIn(entry) {
  let m = positionCache.get(entry);
  if (!m) {
    m = new Map();
    for (let i = 0; i < entry.length; i++) m.set(entry[i].id, i);
    positionCache.set(entry, m);
  }
  return m;
}

/**
 * Put `place` (id -> element) into `list` next to their neighbours in the
 * board order `nextIds`: right after the nearest element before them there
 * that `list` also holds; at the very bottom when there is none; on the very
 * top when nothing `list` holds comes after them. Elements of `list` that are
 * not on the board any more (deleted locally since the snapshot) keep their
 * place, so undoing that delete still restores them in place.
 */
function placeByNeighbours(list, place, nextIds) {
  const rest = list.filter((el) => !place.has(el.id));
  const inRest = new Set(rest.map((el) => el.id));
  let lastShared = -1;
  for (let i = 0; i < nextIds.length; i++) if (inRest.has(nextIds[i])) lastShared = i;

  const bottom = [];
  const top = [];
  const after = new Map(); // anchor id -> elements that go right after it
  let anchor = null;
  for (let i = 0; i < nextIds.length; i++) {
    const id = nextIds[i];
    if (inRest.has(id)) {
      anchor = id;
      continue;
    }
    const el = place.get(id);
    if (!el) continue;
    if (i > lastShared) top.push(el);
    else if (anchor === null) bottom.push(el);
    else {
      if (!after.has(anchor)) after.set(anchor, []);
      after.get(anchor).push(el);
    }
  }
  const out = bottom;
  for (const el of rest) {
    out.push(el);
    const group = after.get(el.id);
    if (group) out.push(...group);
  }
  out.push(...top);
  return out;
}

/**
 * Rebase one undo/redo snapshot over a remote transition. Returns the SAME
 * array when the transition does not touch it. An element the snapshot shares
 * with the pre-transition present (unchanged locally since the snapshot) is
 * swapped for the post-transition object itself, so identity-based "is this
 * entry a no-op?" checks keep working.
 *
 * Z-order: a remote create is added where it sits among its neighbours on the
 * board (not simply on top — a peer's undo restores things in place), and an
 * element a remote reorder moved is moved the same way relative to its
 * neighbours. Everything else keeps the snapshot's order, so restoring the
 * snapshot reverts only this user's own reorders and deletes.
 */
export function rebaseEntry(entry, t) {
  if (!t) return entry;
  const moved = t.moved ?? new Set();

  // Fast path — updates only, the shape of a remote drag. O(changed) plus a
  // memcpy, instead of a full scan of every snapshot on every frame.
  if (t.created.length === 0 && t.deleted.size === 0 && moved.size === 0) {
    const pos = positionsIn(entry);
    let out = null;
    for (const [id, ch] of t.changed) {
      const i = pos.get(id);
      if (i === undefined) continue;
      const el = entry[i];
      const nextEl = el === ch.before ? ch.after : applyDelta(el, ch.before, ch.after);
      if (nextEl === el) continue;
      if (!out) out = entry.slice();
      out[i] = nextEl;
    }
    if (!out) return entry;
    positionCache.set(out, pos);
    return out;
  }

  let out = [];
  let changed = false;
  for (const el of entry) {
    if (t.deleted.has(el.id)) {
      changed = true;
      continue;
    }
    const ch = t.changed.get(el.id);
    const nextEl = !ch ? el : el === ch.before ? ch.after : applyDelta(el, ch.before, ch.after);
    if (nextEl !== el) changed = true;
    out.push(nextEl);
  }

  // What needs a (new) place: remote creates this snapshot lacks, and the
  // elements a remote reorder moved.
  const place = new Map();
  if (t.created.length > 0) {
    const have = new Set(out.map((el) => el.id));
    for (const el of t.created) if (!have.has(el.id)) place.set(el.id, el);
  }
  if (moved.size > 0) for (const el of out) if (moved.has(el.id)) place.set(el.id, el);
  if (place.size > 0) {
    const nextIds = t.next ?? t.order ?? [];
    const placed = placeByNeighbours(out, place, nextIds);
    if (!sameSequence(placed, out)) {
      out = placed;
      changed = true;
    }
  }
  return changed ? out : entry;
}

/** Rebase both history stacks; returns only the fields that changed. */
function rebaseHistory(s, t) {
  if (!t || (s._past.length === 0 && s._future.length === 0)) return {};
  const past = s._past.map((e) => rebaseEntry(e, t));
  const future = s._future.map((e) => rebaseEntry(e, t));
  const out = {};
  if (past.some((e, i) => e !== s._past[i])) out._past = past;
  if (future.some((e, i) => e !== s._future[i])) out._future = future;
  return out;
}

/** Structural equality for plain JSON values (element payloads). */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!jsonEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!jsonEqual(a[k], b[k])) return false;
  }
  return true;
}

/**
 * Swap each incoming element for the local object when they are equal, so a
 * snapshot that confirms what we already have changes no identities: render
 * caches keep their drawables and the history rebase sees no change.
 */
function reuseEqual(local, incoming) {
  const byId = indexById(local);
  let same = incoming.length === local.length;
  const out = incoming.map((el, i) => {
    const mine = byId.get(el.id);
    const pick = mine && jsonEqual(mine, el) ? mine : el;
    if (pick !== local[i]) same = false;
    return pick;
  });
  return same ? local : out;
}

/** The empty-history fields (hydration of a different board). Fresh objects per call. */
function noHistory() {
  return {
    canUndo: false,
    canRedo: false,
    pastDepth: 0,
    futureDepth: 0,
    _past: [],
    _future: [],
    _lastCommit: { label: null, at: 0 },
  };
}

/* ========================================================================
   Collaborators' selections
   ======================================================================== */

/**
 * A `peerSelections` entry, or null when nothing is selected. Ids are
 * strings, unique, in the order given.
 */
function peerSelectionEntry(ids, { color = null, name = null } = {}) {
  if (!ids || typeof ids === 'string' || typeof ids[Symbol.iterator] !== 'function') return null;
  const list = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    seen.add(id);
    list.push(id);
  }
  return list.length > 0 ? { ids: list, color: color ?? null, name: name ?? null } : null;
}

function samePeerSelection(a, b) {
  if (a.color !== b.color || a.name !== b.name || a.ids.length !== b.ids.length) return false;
  for (let i = 0; i < a.ids.length; i++) if (a.ids[i] !== b.ids[i]) return false;
  return true;
}

/**
 * `peerSelections` after a new roster: entries of peers who left are
 * dropped, a roster entry carrying `selection` sets (or clears) that peer's
 * entry, and colours/names follow the roster. Our own entry (`self`) is never
 * kept: the local selection is drawn from `selection`. Returns the SAME Map
 * when nothing changed.
 */
function rosterSelections(current, roster, onRoster, self) {
  let next = null;
  const write = () => (next ??= new Map(current));
  for (const id of current.keys()) if (!onRoster.has(id) || id === self) write().delete(id);
  for (const p of roster) {
    if (!p || !p.id || p.id === self) continue;
    const prev = (next ?? current).get(p.id);
    const carried = Array.isArray(p.selection);
    if (!carried && !prev) continue;
    const entry = peerSelectionEntry(carried ? p.selection : prev.ids, {
      color: p.color ?? prev?.color ?? null,
      name: p.name ?? prev?.name ?? null,
    });
    if (!entry) {
      if (prev) write().delete(p.id);
    } else if (!prev || !samePeerSelection(prev, entry)) {
      write().set(p.id, entry);
    }
  }
  return next ?? current;
}

/* ========================================================================
   The store
   ======================================================================== */

export const useBoardStore = create((set, get) => ({
  ...initialState(),

  // ----------------------------------------------------------------- board

  setBoardId(id) {
    set({ boardId: id ?? null });
  },

  /**
   * Board metadata changed (rename, theme) — from a PATCH response or a
   * `{type:'board'}` broadcast. Merges onto the current board when it is the
   * same one.
   */
  setBoard(board) {
    set((s) => {
      if (!board) return { board: null };
      const merged = s.board && s.board.id === board.id ? { ...s.board, ...board } : { ...board };
      return { board: merged, boardId: board.id ?? s.boardId };
    });
  },

  /**
   * Hydrate from a `BoardSnapshot` (first load, board switch). Wipes history:
   * a hydration is never undoable.
   *
   * A snapshot OLDER than what this board already holds (same board id, lower
   * rev) is ignored unless `force` is set: the HTTP seed can land after the
   * socket's newer `ready`, and applying it would roll the board back.
   * Callers that need the live session's pending edits re-applied on top use
   * `resyncSnapshot` instead (the realtime bridge does).
   */
  setSnapshot({ board, elements, rev } = {}, { force = false } = {}) {
    const cur = get();
    if (
      !force &&
      board &&
      cur.board &&
      cur.boardId === board.id &&
      typeof rev === 'number' &&
      rev < cur.rev
    ) {
      return;
    }
    const els = Array.isArray(elements) ? elements.slice() : [];
    set((s) => ({
      board: board ?? s.board,
      boardId: board ? board.id : s.boardId,
      elements: els,
      rev: typeof rev === 'number' ? rev : s.rev,
      ...prunedInteraction(s, els),
      ...noHistory(),
    }));
  },

  /**
   * Converge on the server's snapshot while keeping this user's pending edits:
   * the new present is `snapshot + pendingOps` (ops not yet acknowledged,
   * re-applied in order on top, then one connector-settling pass). For the
   * SAME board the transition is treated like a remote batch — the undo/redo
   * stacks are rebased, not wiped — so a reconnect does not cost the user
   * their history. For a different board it is a plain hydration.
   *
   * Must run inside `withRemote` (it is the network's state, not an edit).
   */
  resyncSnapshot({ board, elements, rev } = {}, pendingOps = []) {
    set((s) => {
      const sameBoard = Boolean(board) && s.boardId === board.id;
      let target = Array.isArray(elements) ? elements : [];
      if (Array.isArray(pendingOps) && pendingOps.length > 0) {
        target = applyOpsToElements(target, pendingOps, { rebase: true }).elements;
      }
      target = settleConnectors(target);
      if (sameBoard) target = reuseEqual(s.elements, target);
      else target = target.slice();

      const base = {
        board: board ? (s.board && s.board.id === board.id ? { ...s.board, ...board } : board) : s.board,
        boardId: board ? board.id : s.boardId,
        rev: typeof rev === 'number' ? rev : s.rev,
      };
      if (!sameBoard) {
        return { ...base, elements: target, ...prunedInteraction(s, target), ...noHistory() };
      }
      if (target === s.elements) return base;
      const history = rebaseHistory(s, describeTransition(s.elements, target));
      return { ...base, elements: target, ...prunedInteraction(s, target), ...history };
    });
  },

  setStatus(status) {
    set({ status });
  },

  setError(error) {
    set({ error: error ?? null });
  },

  /** Realtime connection status, pushed by the realtime bridge. */
  setConnection(status) {
    if (!CONNECTION_STATES.includes(status)) return;
    if (get().connection === status) return;
    set({ connection: status });
  },

  /**
   * The board rev last seen from the server (ready, ack, broadcast, resync).
   * Informational: WS ops are last-writer-wins and carry no `baseRev`.
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
   * Add one element on TOP of the z-order (end of the array). An id already
   * on the board is ignored: the server would reject the create as a
   * duplicate, and the batch with it.
   *
   * Callers commit FIRST (`commit('add')` then `addElement(el)`). These
   * actions deliberately do NOT commit themselves: a hidden commit would add a
   * second history entry per gesture, so one Ctrl+Z would undo half of it.
   */
  addElement(el) {
    if (!el || !el.id) return;
    set((s) => (s.elements.some((e) => e.id === el.id) ? {} : { elements: [...s.elements, el] }));
  },

  /** Add many in one render (a preset drop, a paste). Commit first for one undo step. */
  addElements(els) {
    const list = Array.isArray(els) ? els.filter((e) => e && e.id) : [];
    if (list.length === 0) return;
    set((s) => {
      const have = new Set(s.elements.map((e) => e.id));
      const fresh = [];
      for (const el of list) {
        if (have.has(el.id)) continue;
        have.add(el.id);
        fresh.push(el);
      }
      return fresh.length === 0 ? {} : { elements: [...s.elements, ...fresh] };
    });
  },

  /**
   * Merge `patch` onto one element (see `mergePatch`: null deletes a key,
   * polylines re-box from their points). To move a pen/arrow/line, patch its
   * `points`; its box follows.
   */
  updateElement(id, patch) {
    if (!id || !patch) return;
    get().updateElements([{ id, patch }]);
  },

  /** Apply many patches in one render. A multi-select drag is one store write per frame. */
  updateElements(patches) {
    const list = Array.isArray(patches) ? patches.filter((p) => p && p.id && p.patch) : [];
    if (list.length === 0) return;
    set((s) => {
      const byId = new Map();
      // Several patches for one id in a batch merge in order.
      for (const p of list) byId.set(p.id, byId.has(p.id) ? { ...byId.get(p.id), ...p.patch } : p.patch);
      let touched = false;
      const next = s.elements.map((el) => {
        const patch = byId.get(el.id);
        if (!patch) return el;
        const merged = mergePatch(el, patch);
        if (merged !== el) touched = true;
        return merged;
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
      return { elements, ...prunedInteraction(s, elements) };
    });
  },

  /** Set the full z-order. See `orderBy` for how unknown ids are handled. */
  reorder(orderedIds) {
    if (!Array.isArray(orderedIds)) return;
    set((s) => {
      const next = orderBy(s.elements, orderedIds);
      return next === s.elements ? {} : { elements: next };
    });
  },

  /**
   * Wholesale replacement: undo/redo and file import. It must NOT touch
   * history (it IS the history) and it must prune the selection. The sync
   * bridge ships it as a normal diff — creates, updates, deletes and a
   * reorder only when the order really differs.
   */
  replaceAll(els) {
    const next = Array.isArray(els) ? els.slice() : [];
    set((s) => ({ elements: next, ...prunedInteraction(s, next) }));
  },

  /**
   * Apply a batch of ops that arrived from the network, in order, then ONE
   * connector-settling pass (detach + resolveConnectors, like the server).
   * Never creates history entries — someone else's edit is not something you
   * Ctrl+Z — but it IS replayed onto the undo/redo snapshots, so your own
   * undo does not revert it. Must run inside `withRemote`.
   *
   * `pendingOps` are this client's own ops the server has not acknowledged
   * yet. The server will apply them AFTER the batch being received, so they
   * are re-applied on top (`rebase` semantics) before connectors settle:
   * without that, a peer's move of a shape I am dragging would win here
   * while mine wins on the server.
   */
  applyRemoteOps(ops, pendingOps = []) {
    const list = Array.isArray(ops) ? ops.filter((op) => op && typeof op === 'object' && op.kind) : [];
    if (list.length === 0) return;
    const mine = Array.isArray(pendingOps) ? pendingOps : [];
    set((s) => {
      const first = applyOpsToElements(s.elements, list);
      const second = mine.length > 0 ? applyOpsToElements(first.elements, mine, { rebase: true }) : first;
      const applied = second.elements;
      const geometry = first.geometry || second.geometry;
      const next = geometry ? settleConnectors(applied) : applied;
      if (next === s.elements) return {};
      const history = rebaseHistory(s, describeTransition(s.elements, next));
      return { elements: next, ...prunedInteraction(s, next), ...history };
    });
  },

  /** One remote op. Same as `applyRemoteOps([op])`. */
  applyRemoteOp(op) {
    if (!op) return;
    get().applyRemoteOps([op]);
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
    set({ selection: new Set() });
  },

  setHovered(id) {
    const next = id ?? null;
    if (get().hoveredId === next) return;
    set({ hoveredId: next });
  },

  setEditing(id) {
    set({ editingId: id ?? null });
  },

  // ------------------------------------------------------------ tool & style

  /**
   * Switch tools, Excalidraw-style: always ends any in-place text edit, and
   * picking anything other than `select`/`hand` clears the selection (you are
   * about to draw, not to edit what was selected). Unknown tools are ignored.
   */
  setTool(tool) {
    if (!isKnownTool(tool)) return;
    set((s) => {
      const out = { tool, editingId: null };
      if (tool !== 'select' && tool !== 'hand' && s.selection.size > 0) out.selection = new Set();
      return out;
    });
  },

  setToolLocked(locked) {
    set({ toolLocked: Boolean(locked) });
  },

  toggleToolLocked() {
    set((s) => ({ toolLocked: !s.toolLocked }));
  },

  /** Merge into the current drawing style. `undefined` values are ignored. */
  setStyle(patch) {
    if (!patch || typeof patch !== 'object') return;
    set((s) => {
      const next = { ...s.style };
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) next[k] = v;
      return { style: next };
    });
  },

  setGridSize(n) {
    const size = Number(n);
    if (!Number.isFinite(size)) return;
    set({ gridSize: size <= 0 ? 0 : Math.min(Math.max(size, GRID.min), GRID.max) });
  },

  toggleSnap() {
    set((s) => ({ snapEnabled: !s.snapEnabled }));
  },

  setSnapEnabled(on) {
    set({ snapEnabled: Boolean(on) });
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

  /** The canvas' CSS size, from its ResizeObserver. Ignored when unchanged. */
  setViewportSize(size) {
    const w = Math.max(0, Number(size?.w) || 0);
    const h = Math.max(0, Number(size?.h) || 0);
    const cur = get().viewportSize;
    if (cur.w === w && cur.h === h) return;
    set({ viewportSize: { w, h } });
  },

  // ---------------------------------------------------------------- history

  /**
   * Snapshot the CURRENT elements so the next mutation is undoable. Call
   * this BEFORE mutating. Two calls with the same label within 500ms merge
   * into one entry (the older snapshot is kept).
   */
  commit(label = 'edit') {
    set((s) => {
      const t = now();
      const coalesce = s._lastCommit.label === label && t - s._lastCommit.at < COALESCE_MS && s._past.length > 0;
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

  /**
   * Restore the previous snapshot. Entries identical to the present (a commit
   * that was never followed by a change, e.g. a click without a drag) are
   * skipped, so Ctrl+Z never "does nothing".
   */
  undo() {
    const s = get();
    let past = s._past;
    while (past.length > 0 && sameSequence(past[past.length - 1], s.elements)) past = past.slice(0, -1);
    if (past.length === 0) {
      if (past !== s._past) {
        set({ _past: past, canUndo: false, pastDepth: 0, _lastCommit: { label: null, at: 0 } });
      }
      return;
    }
    const previous = past[past.length - 1];
    const future = [...s._future, s.elements.slice()];
    const trimmed = future.length > HISTORY_LIMIT ? future.slice(future.length - HISTORY_LIMIT) : future;
    get().replaceAll(previous);
    set({
      _past: past.slice(0, -1),
      _future: trimmed,
      canUndo: past.length > 1,
      canRedo: true,
      pastDepth: past.length - 1,
      futureDepth: trimmed.length,
      // Break coalescing, or the next commit would merge into the entry we
      // just consumed and undo would appear to do nothing.
      _lastCommit: { label: null, at: 0 },
    });
  },

  redo() {
    const s = get();
    let future = s._future;
    while (future.length > 0 && sameSequence(future[future.length - 1], s.elements)) future = future.slice(0, -1);
    if (future.length === 0) {
      if (future !== s._future) set({ _future: future, canRedo: false, futureDepth: 0 });
      return;
    }
    const next = future[future.length - 1];
    const past = [...s._past, s.elements.slice()];
    const trimmed = past.length > HISTORY_LIMIT ? past.slice(past.length - HISTORY_LIMIT) : past;
    get().replaceAll(next);
    set({
      _past: trimmed,
      _future: future.slice(0, -1),
      canUndo: true,
      canRedo: future.length > 1,
      pastDepth: trimmed.length,
      futureDepth: future.length - 1,
      _lastCommit: { label: null, at: 0 },
    });
  },

  // ------------------------------------------------------------------ peers

  setMyPeerId(id) {
    set({ myPeerId: id ?? null });
  },

  /**
   * Replace the roster. Cursors and selections of peers no longer on it are
   * dropped in the same write — a peer that left must not leave its arrow,
   * or its outline around a shape, on the board.
   *
   * A roster entry that carries `selection` (an array of element ids) is the
   * server's record of that peer's selection and replaces ours: that is how
   * someone joining late sees what the others already have selected.
   */
  setPeers(peers) {
    const list = Array.isArray(peers) ? peers : [];
    set((s) => {
      const out = { peers: list };
      const ids = new Set(list.map((p) => p && p.id));
      if (s.remoteCursors.size > 0) {
        let changed = false;
        const next = new Map();
        for (const [id, cur] of s.remoteCursors) {
          if (ids.has(id)) next.set(id, cur);
          else changed = true;
        }
        if (changed) out.remoteCursors = next;
      }
      const selections = rosterSelections(s.peerSelections, list, ids, s.myPeerId);
      if (selections !== s.peerSelections) out.peerSelections = selections;
      return out;
    });
  },

  /**
   * A collaborator's selection changed (`peer-selection`). An empty list
   * removes the entry; the same ids again change nothing (no re-render).
   * @param {string} peerId
   * @param {{ids?: Iterable<string>, color?: string|null, name?: string|null}} sel
   */
  setPeerSelection(peerId, sel) {
    if (!peerId) return;
    set((s) => {
      if (peerId === s.myPeerId) return {};
      const prev = s.peerSelections.get(peerId);
      const peer = s.peers.find((p) => p && p.id === peerId);
      const entry = peerSelectionEntry(sel?.ids, {
        color: sel?.color ?? peer?.color ?? prev?.color ?? null,
        name: sel?.name ?? peer?.name ?? prev?.name ?? null,
      });
      if (!entry) {
        if (!prev) return {};
        const next = new Map(s.peerSelections);
        next.delete(peerId);
        return { peerSelections: next };
      }
      if (prev && samePeerSelection(prev, entry)) return {};
      const next = new Map(s.peerSelections);
      next.set(peerId, entry);
      return { peerSelections: next };
    });
  },

  /** A remote pointer, in BOARD units, with the peer's name and colour. */
  upsertCursor(peerId, cur) {
    if (!peerId) return;
    set((s) => {
      const prev = s.remoteCursors.get(peerId);
      const next = new Map(s.remoteCursors);
      next.set(peerId, {
        x: Number(cur?.x) || 0,
        y: Number(cur?.y) || 0,
        name: cur?.name ?? prev?.name ?? null,
        color: cur?.color ?? prev?.color ?? null,
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

/** Read the whole state outside React — canvas, exports, tests, the sync bridge. */
export const getState = () => useBoardStore.getState();
