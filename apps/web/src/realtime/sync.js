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
 * Three rules make this correct:
 *
 *  1. **Never re-enter on your own writes.** A mutation applied from a remote
 *     broadcast sets `applyingRemote` for the duration of the `set()` call,
 *     so the subscription that fires synchronously inside it sees the guard
 *     and emits nothing. Getting this backwards means every drag draws
 *     twice, once locally and once again when the echo comes back.
 *
 *  2. **Debounce into batches.** A drag emits ~60 updates a second. Sending
 *     60 messages a second per peer is what makes a collaborative canvas
 *     feel laggy, so ops accumulate and go out together on a short timer.
 *
 *  3. **Undo/redo encodes as clear + create.** A diff would be tidier, but
 *     undo is rarely hit compared to dragging, and an encoding that is
 *     occasionally wasteful is far better than one that is occasionally
 *     wrong.
 */

import { realtime } from './realtime.js';
import { useBoardStore, getState, historyEpoch } from '../store/boardStore.js';

/** How long ops accumulate before being flushed. ~3 frames at 60fps. */
const BATCH_MS = 50;

/**
 * True while a remote op is being applied. The store's `set` is synchronous,
 * so a single boolean is enough — no reentrancy depth needed, but a counter
 * is used anyway so a nested application cannot clear the flag early.
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

/** Field-by-field shallow equality, ignoring key order. */
function shallowEqual(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (k === 'points') {
      // Points are arrays of objects; compare as a sequence of coordinates
      // so a drag that rewrites the identical point list is not an update.
      const pa = a.points;
      const pb = b.points;
      if (!pa || !pb || pa.length !== pb.length) return false;
      for (let i = 0; i < pa.length; i++) {
        if (pa[i]?.x !== pb[i]?.x || pa[i]?.y !== pb[i]?.y) return false;
      }
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

/** The patch to send for a changed element: only what actually differs. */
function diffElement(before, after) {
  const patch = {};
  for (const k of Object.keys(after)) {
    if (k === 'id' || k === 'type') continue; // identity, never an update
    if (k === 'points') {
      if (!shallowEqual({ points: before.points }, { points: after.points })) {
        patch.points = after.points.map((p) => ({ x: p.x, y: p.y }));
      }
      continue;
    }
    if (before[k] !== after[k]) patch[k] = after[k];
  }

  // A key that DISAPPEARED (a detached startId) deliberately does not become
  // `patch[k] = undefined`. Two reasons, both verified against the shared
  // validator: `undefined` and `null` are both stripped by `sanitisePatch`, so
  // the clear would never reach the server; and the server does not need it —
  // `applyOpBatch` runs `detachMissingConnectors` itself whenever the batch
  // touches geometry, which is exactly the batch that removed the anchor.
  // The local detach still happened (see `removeAndDetach`), so this client
  // is already consistent; the server reaches the same state on its own.

  return Object.keys(patch).length > 0 ? patch : null;
}

/** Same id sequence on both sides? */
const sameOrder = (a, b) => a.length === b.length && a.every((el, i) => el.id === b[i].id);

/**
 * Turn an elements-array transition into ops. Pure — exported so it can be
 * tested without a socket.
 *
 * @param {object[]} prev
 * @param {object[]} next
 * @param {(op: object) => object} makeOp
 * @param {boolean} [forceFull] encode as clear+create (undo/redo)
 * @returns {{ops: object[], full: boolean}} `full` means clear+create.
 */
export function diffElements(prev, next, makeOp, forceFull = false) {
  const before = new Map(prev.map((el) => [el.id, el]));
  const after = new Map(next.map((el) => [el.id, el]));

  // Wholesale replacement: an undo, a redo, or a very large jump. clear +
  // create is always correct whatever the two boards have in common, and
  // for undo it is the encoding the contract asks for.
  if (forceFull) {
    return { ops: [makeOp('clear'), ...next.map((el) => makeOp('create', { element: el }))], full: true };
  }

  const ops = [];

  for (const el of next) {
    const old = before.get(el.id);
    if (!old) {
      ops.push(makeOp('create', { element: el }));
      continue;
    }
    const patch = diffElement(old, el);
    if (patch) ops.push(makeOp('update', { elementId: el.id, patch }));
  }

  for (const el of prev) {
    if (!after.has(el.id)) ops.push(makeOp('delete', { elementId: el.id }));
  }

  // A reorder that changed nothing else still has to be shipped, but only
  // when the SETS match — otherwise the creates/deletes above already carry
  // the new order and a reorder op would be redundant.
  if (ops.length === 0 && !sameOrder(prev, next)) {
    ops.push(makeOp('reorder', { order: next.map((el) => el.id) }));
  }

  return { ops, full: false };
}

export class StoreSync {
  /**
   * @param {import('./realtime.js').RealtimeClient} [client]
   */
  constructor(client = realtime) {
    this.client = client;
    this.pending = [];
    this.timer = null;
    this.unsubscribe = null;
    this.prevElements = getState().elements;
    this.epoch = historyEpoch.value;
  }

  /** Start bridging. Idempotent — calling twice keeps one subscription. */
  start() {
    if (this.unsubscribe) return this;
    this.prevElements = getState().elements;
    this.epoch = historyEpoch.value;
    this.unsubscribe = useBoardStore.subscribe((state) => this._onChange(state));
    return this;
  }

  /** Stop bridging and flush whatever is still queued. */
  stop() {
    if (this.unsubscribe) this.unsubscribe();
    this.unsubscribe = null;
    this._flush();
  }

  _onChange(state) {
    const next = state.elements;
    const prev = this.prevElements;
    if (next === prev) return;

    // Advance the diff baseline FIRST, unconditionally. A remote create is
    // the clearest way to get this wrong: if the baseline is left pointing at
    // the pre-create board, the next local edit diffs against a board that
    // never had that element and re-ships the remote peer's create as our own.
    this.prevElements = next;

    // Our own echo, or a resync: not a user edit, so it must not be shipped.
    // (Safe to check after the baseline update — a remote change is already
    // accounted for, and must never reach the network.)
    if (isApplyingRemote()) return;

    // An undo/redo bumped the epoch: ship the whole board as clear + create
    // rather than trying to describe the difference. Rare, and always right.
    const forceFull = this.epoch !== historyEpoch.value;
    this.epoch = historyEpoch.value;

    const { ops } = diffElements(prev, next, (kind, fields) => this.client.makeOp(kind, fields), forceFull);
    if (ops.length === 0) return;

    this.pending.push(...ops);
    this._schedule();
  }

  _schedule() {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush();
    }, BATCH_MS);
  }

  _flush() {
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
 * Fold a batch of ops down to one per element.
 *
 * Debouncing the SEND is not enough on its own. A drag produces a real diff
 * on every frame — 60 `update` ops for the same element in 50ms — and
 * sending those is exactly the "collaborative canvas feels laggy" problem:
 * 60 messages a second per peer, each one superseded by the next.
 *
 * Only `update` ops merge, and only for the same `elementId`. Creates,
 * deletes and reorders are NOT collapsed: a create followed by a delete of
 * the same element is a real intent, and collapsing it would mean the server
 * never learns the element existed. Every surviving op keeps its ORIGINAL
 * opId, so the server's opId dedupe still recognises a retried batch.
 *
 * @param {object[]} ops
 * @returns {object[]} a new array, in first-seen order
 */
export function collapseOps(ops) {
  // Everything BEFORE a `clear` is dead: a clear wipes the board, so any
  // create/update/delete ahead of it is overwritten and only costs bytes.
  // This happens for real when two undos land in one debounce window —
  // `clear, create, update, clear, create` — where the middle update is
  // already superseded. Dropping it keeps the batch honest about the final
  // state instead of shipping ops the server will throw away.
  const lastClear = ops.reduce((acc, op, i) => (op.kind === 'clear' ? i : acc), -1);
  const live = lastClear === -1 ? ops : ops.slice(lastClear);

  const out = [];
  const byElement = new Map();

  for (const op of live) {
    if (op.kind === 'update' && op.elementId) {
      const existing = byElement.get(op.elementId);
      if (existing) {
        // Same element twice in one window: one op, merged patch, LAST value
        // wins. The element is sent once with its final geometry, which is
        // all the server needs to converge.
        existing.patch = { ...existing.patch, ...op.patch };
        continue;
      }
      const entry = { ...op, patch: { ...op.patch } };
      byElement.set(op.elementId, entry);
      out.push(entry);
      continue;
    }
    out.push(op);
  }

  return out;
}

/**
 * The one instance. Exported as a class too, so a test can drive a fake
 * client through the exact same code path.
 */
export const storeSync = new StoreSync();

/**
 * Start the bridge. Called once by `useRealtime` on connect. Safe to call
 * repeatedly — `start()` is a no-op when already subscribed, which is what
 * makes a StrictMode double-mount safe.
 */
export function startSync() {
  storeSync.start();
}

/** Stop the bridge. Called on unmount; flushes first so nothing is lost. */
export function stopSync() {
  storeSync.stop();
}
