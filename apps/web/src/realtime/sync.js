/**
 * The bridge between the store and the realtime client.
 *
 * The store owns element mutations; the realtime client owns the network.
 * This file is the only thing that connects them, and it works by DIFFING:
 * a store subscription compares the previous `elements` array with the new
 * one and turns the difference into ops. Diffing rather than instrumenting
 * every action is deliberate — the store then has exactly one job (hold
 * state) and no action has to remember to notify, so a future action cannot
 * forget.
 *
 * Four rules make this correct:
 *
 *  1. **Never re-enter on your own writes.** A mutation applied from the
 *     network runs inside `withRemote`, so the subscription that fires
 *     synchronously inside it sees the guard, advances its baseline and emits
 *     nothing. Getting this backwards means every drag draws twice.
 *
 *  2. **Debounce into batches.** A drag emits ~60 updates a second; ops
 *     accumulate for BATCH_MS and go out together, one `update` per element.
 *
 *  3. **Every transition is a plain diff — undo and redo included.** An undo
 *     used to be shipped as `clear` + re-create of the whole board, which
 *     wiped whatever collaborators had added since. Now it is exactly the
 *     creates/updates/deletes that differ (and the store rebases its undo
 *     stack over remote edits, so that diff only reverts YOUR changes).
 *
 *  4. **A removed key is sent as its "cleared" value.** Unbinding a
 *     connector end deletes `startId` locally; the patch carries
 *     `startId: null`, which the server treats as "remove the field". Keys the
 *     server cannot null get their rendering default instead (`locked:false`,
 *     `rotation:0`, …) so an undo of "lock" or of a first rotation still
 *     reaches everyone.
 *
 * A board switch (the store's `boardId` changes) is never a user edit: the
 * baseline moves and nothing is shipped, so leftovers from board A can never
 * be sent to board B.
 */

import * as shared from '@whiteboard/shared';
import { realtime } from './realtime.js';
import { collapseOps } from './ops.js';
import { useBoardStore } from '../store/boardStore.js';

export { collapseOps };

/** How long ops accumulate before being flushed. ~3 frames at 60fps. */
export const BATCH_MS = 50;

/**
 * True while a remote op is being applied. The store's `set` is synchronous,
 * so the subscription runs inside the guarded call; a counter (not a flag)
 * keeps a nested application from clearing it early.
 */
let applyingRemote = 0;

/** True when the current change came from the network, not from a user. */
export const isApplyingRemote = () => applyingRemote > 0;

/** Run a store mutation that must NOT be re-broadcast. */
export function withRemote(fn) {
  applyingRemote += 1;
  try {
    return fn();
  } finally {
    applyingRemote -= 1;
  }
}

/* ------------------------------------------------------------------ diffing */

/** What the renderer draws for an absent `stroke` on arrows, lines and pen strokes (shape.js DEFAULT_INK). */
const DEFAULT_INK = '#1e1e1e';

/** What the renderer draws for an absent `strokeWidth` (shape.js resolveStyle). */
const DEFAULT_STROKE_WIDTH = 2;

/** Patch keys the server accepts `null` for, meaning "remove the field". */
const NULLABLE_KEYS = new Set(
  Array.isArray(shared.NULLABLE_PATCH_KEYS) ? shared.NULLABLE_PATCH_KEYS : ['startId', 'endId', 'groupId', 'label'],
);

/**
 * The value that says "this key is gone" to the server, for a key that
 * disappeared from `el`. `undefined` means it cannot be expressed (the key is
 * left alone on the server — only harmless keys such as timestamps land here).
 * Defaults match the renderer's defaults for absent fields, so the server's
 * explicit value draws exactly like the local missing one.
 */
export function clearedValue(key, el) {
  if (NULLABLE_KEYS.has(key)) return null;
  switch (key) {
    case 'locked':
      return false;
    case 'rotation':
      return 0;
    case 'opacity':
      return 1;
    case 'strokeStyle':
      return 'solid';
    case 'stroke':
      // Arrows, lines and pen strokes with no stroke are drawn in the default
      // ink (render/shape.js resolveStyle); an explicit 'none' would make
      // them invisible on every other screen.
      return el?.type === 'arrow' || el?.type === 'line' || el?.type === 'pen' ? DEFAULT_INK : 'none';
    case 'fill':
      return 'none';
    case 'strokeWidth':
      return DEFAULT_STROKE_WIDTH;
    case 'roughness':
      return 1;
    case 'fillStyle':
      return 'solid';
    case 'roundness':
      return 'sharp';
    case 'fontFamily':
      return 'hand';
    case 'fontSize':
      return el?.type === 'text' ? 24 : 20;
    case 'align':
      return el?.type === 'text' || el?.type === 'sticky' ? 'left' : 'center';
    case 'startArrowhead':
      return 'none';
    case 'endArrowhead':
      return el?.type === 'arrow' ? 'arrow' : 'none';
    default:
      return undefined;
  }
}

/** Same point sequence (x/y only — that is all the wire carries)? */
function samePoints(pa, pb) {
  if (pa === pb) return true;
  if (!Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;
  for (let i = 0; i < pa.length; i++) {
    if (pa[i]?.x !== pb[i]?.x || pa[i]?.y !== pb[i]?.y) return false;
  }
  return true;
}

/** Structural equality for plain JSON values (nested arrays/objects). */
function jsonEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  for (const k of ka) if (!jsonEqual(a[k], b[k])) return false;
  return true;
}

/**
 * The patch to send for a changed element: only what actually differs.
 * Exported for tests.
 * @returns {object|null}
 */
export function diffElement(before, after) {
  const patch = {};
  for (const k of Object.keys(after)) {
    if (k === 'id' || k === 'type') continue; // identity, never an update
    const v = after[k];
    if (v === undefined || v === null) continue; // treated as absent, below
    if (k === 'points') {
      if (!samePoints(before.points, v)) patch.points = v.map((p) => ({ x: p.x, y: p.y }));
      continue;
    }
    if (before[k] === v) continue;
    if (typeof v === 'object' && jsonEqual(before[k], v)) continue;
    patch[k] = v;
  }
  for (const k of Object.keys(before)) {
    if (k === 'id' || k === 'type') continue;
    if (before[k] === undefined || before[k] === null) continue;
    if (after[k] !== undefined && after[k] !== null) continue;
    const cleared = clearedValue(k, after);
    if (cleared !== undefined) patch[k] = cleared;
  }
  return Object.keys(patch).length > 0 ? patch : null;
}

/**
 * Turn an elements-array transition into ops. Pure — exported so it can be
 * tested without a socket.
 *
 * Order is part of the board, so it is checked too: the server appends a
 * `create` on top, which is wrong when the new element sits lower (an undo
 * of a delete restores it in place). The server's resulting order is
 * simulated and a `reorder` is added only when it would differ.
 *
 * The ops come out in DEPENDENCY order, because a big change (an import, a
 * paste, an undo of either) is shipped in several batches and the server
 * settles each batch on its own:
 *
 *  1. deletes first — they make room: with creates first, replacing a full
 *     board passed MAX_ELS halfway and the server refused the rest;
 *  2. creates, each bound connector after the element(s) it is bound to —
 *     the server drops a binding to an element not on the board yet at the
 *     end of a batch (detachMissingConnectors), and so do peers;
 *  3. updates (which may bind to something just created);
 *  4. the reorder, when needed, last.
 *
 * @param {object[]} prev
 * @param {object[]} next
 * @param {(kind: string, fields?: object) => object} makeOp
 * @returns {{ops: object[], full: false}}
 */
export function diffElements(prev, next, makeOp) {
  const before = new Map(prev.map((el) => [el.id, el]));
  const after = new Map(next.map((el) => [el.id, el]));
  const ops = [];

  for (const el of prev) {
    if (!after.has(el.id)) ops.push(makeOp('delete', { elementId: el.id }));
  }

  const created = [];
  const updates = [];
  for (const el of next) {
    const old = before.get(el.id);
    if (!old) {
      created.push(el);
      continue;
    }
    if (old === el) continue;
    const patch = diffElement(old, el);
    if (patch) updates.push(makeOp('update', { elementId: el.id, patch }));
  }

  const createdIds = orderCreates(created);
  const createdById = new Map(created.map((el) => [el.id, el]));
  for (const id of createdIds) ops.push(makeOp('create', { element: createdById.get(id) }));
  ops.push(...updates);

  // What order would the server end up with? Survivors keep prev's order and
  // creates are appended in the order they were sent.
  const simulated = [];
  for (const el of prev) if (after.has(el.id)) simulated.push(el.id);
  simulated.push(...createdIds);
  let reordered = simulated.length !== next.length;
  for (let i = 0; !reordered && i < next.length; i++) if (simulated[i] !== next[i].id) reordered = true;
  if (reordered) ops.push(makeOp('reorder', { order: next.map((el) => el.id) }));

  return { ops, full: false };
}

const isConnector = (el) => el?.type === 'arrow' || el?.type === 'line';

/**
 * The ids of `created` (in z-order) in the order to SEND their creates: z-order,
 * except that a connector bound to an element created later waits until that
 * element has been sent. Only non-connectors can be binding targets (shared
 * `resolveConnectors` ignores a binding to another connector), so one
 * deferral step is enough.
 */
function orderCreates(created) {
  const ids = created.map((el) => el.id);
  if (created.length < 2) return ids;
  const createdIds = new Set(ids);
  const targets = new Set(created.filter((el) => !isConnector(el)).map((el) => el.id));
  const sent = new Set();
  const out = [];
  /** targetId -> connectors waiting for it */
  const waiting = new Map();
  const blockers = new Map();

  const send = (el) => {
    out.push(el.id);
    sent.add(el.id);
    const waiters = waiting.get(el.id);
    if (!waiters) return;
    waiting.delete(el.id);
    for (const w of waiters) {
      const left = blockers.get(w.id) - 1;
      blockers.set(w.id, left);
      if (left === 0) send(w);
    }
  };

  for (const el of created) {
    const deps = isConnector(el)
      ? [...new Set([el.startId, el.endId])].filter((id) => id && id !== el.id && createdIds.has(id) && targets.has(id) && !sent.has(id))
      : [];
    if (deps.length === 0) {
      send(el);
      continue;
    }
    blockers.set(el.id, deps.length);
    for (const id of deps) {
      if (!waiting.has(id)) waiting.set(id, []);
      waiting.get(id).push(el);
    }
  }
  return out;
}

/* --------------------------------------------------------------- StoreSync */

export class StoreSync {
  /**
   * @param {import('./realtime.js').RealtimeClient} [client]
   * @param {{getState?: () => object, subscribe?: Function}} [store]
   */
  constructor(client = realtime, store = useBoardStore) {
    this.client = client;
    this.store = store;
    this.pending = [];
    this.timer = null;
    this.unsubscribe = null;
    const st = store.getState();
    this.prevElements = st.elements;
    this.prevBoardId = st.boardId;
  }

  /** Start bridging. Idempotent — calling twice keeps one subscription. */
  start() {
    if (this.unsubscribe) return this;
    const st = this.store.getState();
    this.prevElements = st.elements;
    this.prevBoardId = st.boardId;
    this.unsubscribe = this.store.subscribe((state) => this._onChange(state));
    return this;
  }

  /** Stop bridging and flush whatever is still queued. */
  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this.flush();
  }

  /** Ops computed but not yet handed to the client (the current debounce window). */
  pendingOps() {
    return this.pending.slice();
  }

  _onChange(state) {
    // A different board (or none): hydration/reset, never an edit. Checked on
    // EVERY store change, not only element changes, or a bare `setBoardId`
    // would leave the guard armed and swallow the first real edit.
    if (state.boardId !== this.prevBoardId) {
      this.prevBoardId = state.boardId;
      this.prevElements = state.elements;
      return;
    }

    const next = state.elements;
    const prev = this.prevElements;
    if (next === prev) return;

    // Advance the baseline FIRST, unconditionally: a remote create left out
    // of the baseline would be re-shipped as ours by the next local edit.
    this.prevElements = next;

    // Our own echo, a resync, a hydration: not a user edit.
    if (isApplyingRemote()) return;

    const { ops } = diffElements(prev, next, (kind, fields) => this.client.makeOp(kind, fields));
    if (ops.length === 0) return;

    this.pending.push(...ops);
    this._schedule();
  }

  _schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, BATCH_MS);
  }

  /** Hand everything queued to the client now (collapsed). */
  flush() {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pending.length === 0) return;
    const batch = collapseOps(this.pending);
    this.pending = [];
    this.client.sendOps(batch);
  }
}

/**
 * The one instance, bound to the realtime singleton. Exported as a class too,
 * so a test can drive a fake client through the exact same code path.
 */
export const storeSync = new StoreSync();
