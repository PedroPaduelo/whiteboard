/**
 * The WebSocket client. ONE instance for the whole app, created at module
 * scope so the outbox survives remounts (a React StrictMode double-mount in
 * dev, a reconnect) — a per-hook socket would lose edits.
 *
 * It owns the NETWORK only. Turning messages into store writes is the job of
 * `bridge.js`, through the `handlers` bag; that split is what lets the whole
 * protocol be tested in node against the real server store.
 *
 * The rules, each one a bug that used to exist:
 *
 *  1. **Exactly one batch in flight.** Ops queue in `outbox`; `_flush` sends
 *     at most MAX_BATCH of them as `inflight` and does nothing more until the
 *     ack for that batch arrives. An ack clears `inflight` and flushes the
 *     next batch. (Re-sending unacked ops with every new batch was an endless
 *     ops→ack→ops loop from the very first edit.)
 *
 *  1b. **A batch is capped by BYTES too.** The server closes the socket with
 *     no ack (1009) on a frame over its maxPayload (8 MiB), so a count-only
 *     cap let one drop of a few big photos wedge the client: reconnect,
 *     re-send the same frame, closed again, forever, with every later edit
 *     queued behind it. Batches now stay under MAX_BATCH_BYTES; a batch the
 *     socket keeps dying on is split, and a single op that can never fit is
 *     dropped, reported and rolled back instead of being retried forever.
 *
 *  2. **Nothing is sent before `ready`.** The server answers ops that arrive
 *     before the join has finished with an error frame instead of an ack, and
 *     an unanswered in-flight batch would stall the outbox forever.
 *
 *  3. **An erroring batch is dropped, never re-sent.** `error` drops it,
 *     reports it (`handlers.onError`) and asks for a resync, which rolls the
 *     local optimistic state back to the server's truth. Re-sending an
 *     invalid batch can only fail again.
 *
 *  4. **No `baseRev`.** WS ops are last-writer-wins in server arrival order
 *     (plus opId dedupe). Board-level optimistic concurrency made two people
 *     editing at the same time conflict constantly.
 *
 *  5. **Offline edits survive.** A dropped socket keeps the outbox (the
 *     in-flight batch goes back to its front); after the reconnect's `ready`
 *     the bridge re-applies everything still pending on top of the fresh
 *     board and the queue is flushed. A re-sent batch the server had already
 *     seen is acked `duplicate` (opId dedupe) and triggers one more resync,
 *     so a replay can never leave this client ahead of the truth.
 *
 *  6. **Switching boards never leaks ops.** Ops still queued for the old
 *     board are posted to IT over HTTP (best effort, deduped by opId) and the
 *     queue is cleared before the new board's socket opens.
 *
 *  6b. **Closing the tab loses nothing.** `pagehide` allows no second step
 *     (a request chained on a response never starts) and ~64 KiB of
 *     keepalive bodies, so the leftovers are ALSO stashed in localStorage
 *     (`stash.js`) and queued again, in order, the next time this browser
 *     opens the board. The server dedupes by opId, so what did land is a
 *     no-op the second time.
 *
 *  7. **Bounded backoff with jitter.** After MAX_ATTEMPTS the status becomes
 *     `disconnected` so the UI can say so, but the client keeps retrying at
 *     the slowest interval (and immediately on `reconnect()`), because the
 *     outbox still holds the user's edits. The browser's `offline` event
 *     says `offline` at once (`markOffline`) — a dead socket can look open
 *     for a long time.
 *
 *  8. **A board that does not exist is final.** An unknown id at join, a
 *     `missing` ack or the server's eviction of a deleted board stops the
 *     client for good (`fatal`, status `disconnected`, queue dropped) and
 *     reports `BOARD_NOT_FOUND`, so the app can say so instead of letting
 *     the user draw into the void.
 *
 * Malformed frames are ignored, never thrown: a server bug or a proxy
 * injecting garbage must not take the app down.
 */

import { WS_MSG as SHARED_WS_MSG, OP_RESULT as SHARED_OP_RESULT, LIMITS } from '@whiteboard/shared';
import { WS_URL, getActorId, newOpId, request } from '../api/client.js';
import { collapseOps } from './ops.js';
import { localStash } from './stash.js';

/** Wire message types (shared names, plus the ones newer than some servers). */
export const MSG = Object.freeze({
  JOIN: 'join',
  READY: 'ready',
  OPS: 'ops',
  OP_BROADCAST: 'op',
  OP_ACK: 'ack',
  CURSOR: 'cursor',
  CURSOR_BROADCAST: 'peer-cursor',
  ACTIVITY: 'activity',
  PRESENCE: 'presence',
  PING: 'ping',
  RESYNC: 'resync',
  BYE: 'bye',
  BOARD: 'board',
  SELECTION: 'selection',
  SELECTION_BROADCAST: 'peer-selection',
  ...SHARED_WS_MSG,
  ERROR: 'error',
});

const RESULT = Object.freeze({
  APPLIED: 'applied',
  DUPLICATE: 'duplicate',
  CONFLICT: 'conflict',
  MISSING: 'missing',
  ERROR: 'error',
  ...SHARED_OP_RESULT,
});

/** Server-side cursor rate limit is ~30/s; match it, plus a trailing send. */
export const CURSOR_INTERVAL_MS = 33;

/**
 * Selection announcements are throttled too: a marquee drag changes the
 * selection on every pointer move. The trailing send makes the final
 * selection land.
 */
export const SELECTION_INTERVAL_MS = 50;

/** Most ids one selection message carries: a selection is a subset of the board. */
export const MAX_SELECTION_IDS = LIMITS?.MAX_ELS ?? 5000;

/** Longest element id the server accepts; anything longer cannot be on the board. */
const MAX_ID_LENGTH = LIMITS?.MAX_ID ?? 40;

/**
 * A list of element ids as it goes on the wire and into the store: strings
 * only, no duplicates, no empty or over-long ids, at most MAX_SELECTION_IDS.
 * Accepts an array, a Set or any iterable; anything else is `[]`.
 * @returns {string[]}
 */
export function normalizeSelectionIds(ids) {
  if (!ids || typeof ids === 'string' || typeof ids[Symbol.iterator] !== 'function') return [];
  const out = [];
  const seen = new Set();
  for (const id of ids) {
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_SELECTION_IDS) break;
  }
  return out;
}

/** Most ops in one `ops` frame (the server rejects bigger batches). */
export const MAX_BATCH = LIMITS?.MAX_OPS_PER_BATCH ?? 200;

/**
 * Byte budget of one `ops` frame (and of one HTTP salvage request). The
 * server's cap is its body limit, 8 MiB by default, for a WS frame and a
 * REST body alike; half of it leaves room for the envelope and for a server
 * configured tighter. A batch always carries at least one op, and a valid op
 * is at most ~2 MB (one image at MAX_IMAGE_CHARS), so every op fits.
 */
export const MAX_BATCH_BYTES = LIMITS?.MAX_BATCH_BYTES ?? 4 * 1024 * 1024;

/** An op bigger than this can never be delivered: it is over the server's cap on its own. */
export const MAX_OP_BYTES = 7 * 1024 * 1024;

/** How small repeated losses of one batch can shrink the byte budget. */
const MIN_BATCH_BYTES = 64 * 1024;

/**
 * Browsers refuse `keepalive` requests once the bodies in flight for a page
 * pass 64 KiB (sendBeacon shares that quota), so a request sent while the
 * page is going away carries at most this much.
 */
export const KEEPALIVE_BYTES = 60_000;

/** Close code for "message too big" (RFC 6455): the frame will never fit. */
const CLOSE_TOO_BIG = 1009;

/** No batch has been lost with the socket. */
const NO_LOSS = Object.freeze({ opId: null, count: 0 });

/**
 * UTF-8 size of a string: what the socket actually sends. Code units past
 * 0x7ff count 3 bytes, so a surrogate pair counts 6 instead of 4 — an upper
 * bound, which is the safe side for a budget.
 */
export function utf8Length(str) {
  let n = str.length;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c > 0x7f) n += c > 0x7ff ? 2 : 1;
  }
  return n;
}

/**
 * Split wire ops into ordered chunks of at most `maxCount` ops and `maxBytes`
 * of JSON each (a chunk always takes at least one op). Ops over MAX_OP_BYTES
 * on their own can never be delivered and come back in `tooBig` instead.
 *
 * @param {object[]} ops  wire ops (already carrying boardId/actorId)
 * @returns {{chunks: object[][], tooBig: object[]}}
 */
export function chunkOps(ops, { maxBytes = MAX_BATCH_BYTES, maxCount = MAX_BATCH } = {}) {
  const chunks = [];
  const tooBig = [];
  let chunk = [];
  let bytes = 0;
  for (const op of ops) {
    const size = utf8Length(JSON.stringify(op)) + 1; // + the comma
    if (size > MAX_OP_BYTES) {
      tooBig.push(op);
      continue;
    }
    if (chunk.length > 0 && (chunk.length >= maxCount || bytes + size > maxBytes)) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(op);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return { chunks, tooBig };
}

/** Past this many queued ops the outbox is compacted (updates merged per element). */
const MAX_OUTBOX = 500;

/** A batch unanswered for this long means a dead socket: reconnect and re-send. */
const ACK_TIMEOUT_MS = 20_000;

/** The server drops peers silent past ~30s; ping at a third of that. */
const HEARTBEAT_MS = 10_000;

/** Backoff: 1s, 2s, 4s ... capped at 15s, with jitter. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

/** After this many consecutive failures the status says `disconnected`. */
const MAX_ATTEMPTS = 8;

/** A `conflict` ack is retried this many times in a row before the batch is dropped. */
const MAX_CONFLICT_RETRIES = 2;

const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

const OPEN = 1;
const CONNECTING = 0;

/**
 * Default HTTP fallback for leftover ops: POST /boards/:id/ops, deduped by
 * opId. `keepalive` lets it outlive the page (`request` drops the flag for a
 * body the browser would refuse it for).
 */
function defaultPostOps(boardId, ops, { keepalive = true } = {}) {
  return request(`/boards/${encodeURIComponent(boardId)}/ops`, {
    method: 'POST',
    body: { ops, actorId: getActorId(boardId) },
    keepalive,
  });
}

/** 4xx other than timeout/rate limit: the server looked at the batch and said no. */
const isRejection = (err) => err?.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;

export class RealtimeClient {
  /**
   * @param {object} [options]  test seams; the app uses the defaults
   * @param {Function} [options.WebSocket]  WebSocket constructor (default: global)
   * @param {string} [options.url]          socket URL (default: WS_URL, absolute)
   * @param {((boardId: string, ops: object[], opts?: {keepalive?: boolean}) => Promise<unknown>)|null} [options.postOps]
   *   HTTP fallback for ops left over when leaving a board; null disables it
   * @param {{save: Function, take: Function, drop: Function}|null} [options.stash]
   *   where undelivered ops wait for the next visit (default: localStorage); null disables it
   * @param {number} [options.ackTimeoutMs]
   * @param {number} [options.heartbeatMs]
   * @param {number} [options.backoffBaseMs]
   * @param {number} [options.backoffMaxMs]
   * @param {number} [options.maxAttempts]
   */
  constructor(options = {}) {
    this.options = {
      WebSocket: options.WebSocket ?? null,
      url: options.url ?? null,
      postOps: options.postOps === undefined ? defaultPostOps : options.postOps,
      stash: options.stash === undefined ? localStash : options.stash,
      ackTimeoutMs: options.ackTimeoutMs ?? ACK_TIMEOUT_MS,
      heartbeatMs: options.heartbeatMs ?? HEARTBEAT_MS,
      backoffBaseMs: options.backoffBaseMs ?? BACKOFF_BASE_MS,
      backoffMaxMs: options.backoffMaxMs ?? BACKOFF_MAX_MS,
      maxAttempts: options.maxAttempts ?? MAX_ATTEMPTS,
    };

    /** @type {WebSocket|null} */
    this.ws = null;
    this.boardId = null;
    /** Our server-assigned peer id (from `ready`). */
    this.peerId = null;
    /** Presence name (the nickname). null lets the server pick a fallback. */
    this.name = null;
    /** True between `ready` and the socket going away: only then are ops sent. */
    this.joined = false;

    /** Ops queued and not yet sent (or sent on a socket that died). */
    this.outbox = [];
    /** The one batch awaiting its ack: `{ops, resent, sentAt}` or null. */
    this.inflight = null;
    /** opIds transmitted at least once and not yet resolved; never compacted. */
    this.sentIds = new Set();
    /** Current byte budget of a batch; shrinks when the socket keeps dying on one. */
    this.batchBytes = MAX_BATCH_BYTES;
    /** The batch lost with the socket last time (first opId) and how many times in a row. */
    this._lost = NO_LOSS;

    /** Highest board rev seen (ready, ack, broadcast, resync). Informational. */
    this.rev = 0;

    this.status = 'idle'; // idle | connecting | connected | offline | disconnected
    this.attempts = 0;
    this.intentionallyClosed = false;
    /** Set when the server says the board does not exist: retrying is pointless. */
    this.fatal = false;

    /** Current tool, re-announced after every (re)join. */
    this.activity = null;

    /**
     * What this user has selected (element ids), re-announced after every
     * (re)join: the server's record of a peer starts empty.
     */
    this.selection = [];
    /** The selection last put on the current socket (a key), or null: nothing sent yet. */
    this._selectionSent = null;
    this._selectionTimer = null;
    this._lastSelectionSent = 0;

    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.ackTimer = null;

    this._cursorPending = null;
    this._cursorTimer = null;
    this._lastCursorSent = 0;
    this._conflictStreak = 0;

    /**
     * Handlers wired by `bridge.js`. A bag rather than per-call callbacks so a
     * remount does not have to re-open the socket just to swap a callback.
     */
    this.handlers = {
      onReady: null, // (readyMsg)
      onOp: null, // (ops, msg)
      onAck: null, // (result, {ops, replayed})
      onPeerCursor: null, // (peerId, {x, y, name, color}, msg)
      onPeerSelection: null, // (peerId, {ids, name, color}, msg)
      onPresence: null, // (peers)
      onBoard: null, // (board)
      onResync: null, // ({reason, rev})
      onStatus: null, // (status)
      onError: null, // (message, {code?, kind, ops?})
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Open the socket and join a board. Idempotent per board: calling it with
   * the board we are already on (socket open or opening) is a no-op.
   *
   * @param {string} boardId
   * @param {{name?: string}} [opts]
   */
  connect(boardId, { name } = {}) {
    if (!boardId) return;
    if (name) this.name = String(name);

    const sameBoard = this.boardId === boardId;
    if (sameBoard && this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) return;

    this._teardown();
    if (!sameBoard && this.boardId) {
      // Ops for the old board go to the old board, never to this one.
      this._salvage(this.boardId);
      this.rev = 0;
    }
    if (!sameBoard) {
      this.batchBytes = MAX_BATCH_BYTES;
      this._lost = NO_LOSS;
      // Ids from the old board mean nothing on this one.
      this.selection = [];
    }

    this.boardId = boardId;
    this.intentionallyClosed = false;
    this.fatal = false;
    this.attempts = 0;
    this._restoreStash(boardId);
    this._clearReconnect();
    this._setStatus('connecting');
    this._open();
  }

  /**
   * Close the socket and stop all timers. Anything still unacknowledged is
   * posted over HTTP (deduped server-side by opId), so leaving a board right
   * after an edit does not lose it. Safe to call when not connected.
   *
   * @param {{unloading?: boolean}} [opts]  `unloading`: the page is going away
   *   (pagehide), so nothing can wait for a response — see `_salvage`
   */
  disconnect({ unloading = false } = {}) {
    this.intentionallyClosed = true;
    this._clearReconnect();
    this._teardown();
    this._salvage(this.boardId, { unloading });
    this._setStatus('idle');
  }

  /**
   * The browser lost the network (the window's `offline` event). A socket can
   * look open long after that: the server never answers a ping, and only an
   * unacked batch would notice, after ACK_TIMEOUT_MS. So say `offline` NOW
   * and drop the socket (the in-flight batch goes back to the queue).
   * `reconnect()` on the `online` event brings it back; a slow retry covers
   * an `online` event that never comes.
   */
  markOffline() {
    if (!this.boardId || this.intentionallyClosed || this.fatal || this.status === 'idle') return;
    this._clearReconnect();
    this._teardown();
    this._setStatus('offline');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, this.options.backoffMaxMs);
  }

  /**
   * Queue again what an earlier visit to `boardId` stashed because it might
   * not have been delivered before the page went away. They go FIRST (they
   * are older than anything queued now) and count as sent: they may well have
   * landed, so a later patch must never be merged into them.
   */
  _restoreStash(boardId) {
    const stashed = this.options.stash?.take?.(boardId);
    if (!Array.isArray(stashed) || stashed.length === 0) return;
    const queued = new Set(this.pendingOps().map((op) => op.opId));
    const restored = [];
    for (const op of stashed) {
      if (queued.has(op.opId)) continue;
      queued.add(op.opId);
      this.sentIds.add(op.opId);
      restored.push({ ...op, boardId });
    }
    this.outbox.unshift(...restored);
  }

  /** Drop the socket (if any) and connect again now, with a fresh attempt budget. */
  reconnect() {
    if (!this.boardId) return;
    this.intentionallyClosed = false;
    this.fatal = false;
    this.attempts = 0;
    this._clearReconnect();
    this._teardown();
    this._setStatus('connecting');
    this._open();
  }

  /**
   * Change the presence name. The server only takes a name at join time, so
   * a live connection re-joins (a new peer id; pending ops are kept).
   */
  setName(name) {
    const next = name ? String(name) : null;
    if (!next || next === this.name) return;
    this.name = next;
    if (this.ws && !this.intentionallyClosed) this.reconnect();
  }

  /** Every op not yet acknowledged, in send order (in-flight batch first). */
  pendingOps() {
    return this.inflight ? [...this.inflight.ops, ...this.outbox] : this.outbox.slice();
  }

  _teardown() {
    this._clearHeartbeat();
    this._clearCursorTimer();
    this._clearSelectionTimer();
    // The next socket is a new peer to the server, with no selection on record.
    this._selectionSent = null;
    this._clearAckTimer();

    if (this.ws) {
      // Detach before closing: a close event from a socket we no longer
      // care about must not schedule a reconnect.
      const ws = this.ws;
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.joined = false;
    this.peerId = null;
    this._requeueInflight();
  }

  _open() {
    if (!this.boardId) return;
    const WS = this.options.WebSocket ?? (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!WS) {
      this._fail('WebSocket is not available');
      return;
    }

    let ws;
    try {
      ws = new WS(this.options.url ?? WS_URL);
    } catch (err) {
      this._fail(err instanceof Error ? err.message : 'WebSocket constructor threw');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // a stale socket finished opening
      const join = { type: MSG.JOIN, boardId: this.boardId, peerId: getActorId(this.boardId) };
      if (this.name) join.peer = { name: this.name };
      this._send(join);
      this._startHeartbeat();
    };

    ws.onmessage = (event) => {
      if (this.ws !== ws) return;
      this._receive(event);
    };

    ws.onerror = () => {
      // The error event carries no detail by design; `onclose` follows.
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.joined = false;
      this._clearHeartbeat();
      this._clearAckTimer();
      this._noteLostBatch(event?.code);
      this._requeueInflight();
      if (this.intentionallyClosed) {
        this._setStatus('idle');
        return;
      }
      this._fail(event?.reason || `connection closed (${event?.code ?? 'no code'})`);
    };
  }

  // ----------------------------------------------------------------- send

  /**
   * Queue ops and try to flush. Safe when offline — that is the point.
   * Ops made for a different board than the current one are refused.
   * @param {object[]} ops
   */
  sendOps(ops) {
    const list = Array.isArray(ops) ? ops.filter((o) => o && o.opId && o.kind) : [];
    if (list.length === 0) return;

    for (const op of list) {
      if (op.boardId && this.boardId && op.boardId !== this.boardId) {
        this._report(`dropped an op for board ${op.boardId} while on ${this.boardId}`, { kind: 'ops', ops: [op] });
        continue;
      }
      // Never stamp baseRev: WS ops are last-writer-wins.
      const { baseRev: _ignored, ...rest } = op;
      this.outbox.push({ ...rest, boardId: this.boardId ?? op.boardId ?? null, at: op.at || Date.now() });
    }

    // A long offline stretch of dragging: fold the queue instead of dropping
    // anything. Ops already sent once are frozen (the server may hold them).
    if (this.outbox.length > MAX_OUTBOX) {
      this.outbox = collapseOps(this.outbox, { frozen: this.sentIds });
    }

    this._flush();
  }

  /** True when a batch may go out: socket open AND joined. */
  _canSend() {
    return this.joined && this._isOpen();
  }

  _flush() {
    if (this.inflight || this.outbox.length === 0 || !this._canSend()) return;

    // Take ops from the head while they fit BOTH caps: MAX_BATCH ops and
    // `batchBytes` of JSON (the first op always goes, whatever its size). The
    // frame is assembled from the per-op JSON, so nothing is stringified twice.
    const boardId = this.boardId;
    const actorId = getActorId(boardId);
    const head = `{"type":${JSON.stringify(MSG.OPS)},"boardId":${JSON.stringify(boardId)},"ops":[`;
    const ops = [];
    const parts = [];
    const tooBig = [];
    let bytes = head.length + 2;
    let taken = 0;
    for (; taken < this.outbox.length && ops.length < MAX_BATCH; taken++) {
      const op = this.outbox[taken];
      const json = JSON.stringify({ ...op, boardId, actorId: op.actorId ?? actorId });
      const size = utf8Length(json) + 1;
      if (size > MAX_OP_BYTES) {
        tooBig.push(op);
        continue;
      }
      if (ops.length > 0 && bytes + size > this.batchBytes) break;
      ops.push(op);
      parts.push(json);
      bytes += size;
    }
    this.outbox.splice(0, taken);
    if (tooBig.length > 0) this._dropUndeliverable(tooBig);
    if (ops.length === 0) {
      this._flush();
      return;
    }

    const resent = ops.some((op) => this.sentIds.has(op.opId));
    for (const op of ops) this.sentIds.add(op.opId);

    this.inflight = { ops, resent, bytes, sentAt: Date.now() };
    if (!this._sendRaw(`${head}${parts.join(',')}]}`)) {
      this._requeueInflight();
      return;
    }
    this._armAckTimer();
  }

  /** Put the in-flight batch back at the head of the outbox (socket gone). */
  _requeueInflight() {
    this._clearAckTimer();
    if (!this.inflight) return;
    const { ops } = this.inflight;
    this.inflight = null;
    this.outbox.unshift(...ops);
  }

  /**
   * The socket went away with a batch in flight (closed, or no ack in time).
   * Re-sending it unchanged is right for a network blip and an endless loop
   * for a frame the server will never take — it closes an oversized frame
   * with 1009 (or just drops the connection) and never acks it. So a batch
   * lost twice in a row, or once with 1009, is split (the byte budget drops
   * below its size); a lone op closed with 1009 can never fit and is dropped,
   * reported and rolled back by a resync. Call BEFORE the batch is requeued.
   */
  _noteLostBatch(code) {
    const batch = this.inflight;
    if (!batch || batch.ops.length === 0) return;
    const head = batch.ops[0].opId;
    this._lost = { opId: head, count: this._lost.opId === head ? this._lost.count + 1 : 1 };
    const tooBig = code === CLOSE_TOO_BIG;
    if (!tooBig && this._lost.count < 2) return;
    if (batch.ops.length > 1) {
      this.batchBytes = Math.max(MIN_BATCH_BYTES, Math.min(this.batchBytes, Math.floor(batch.bytes / 2)));
      return;
    }
    if (tooBig) {
      this._clearAckTimer();
      this.inflight = null;
      this._lost = NO_LOSS;
      this._dropUndeliverable(batch.ops);
    }
  }

  /** Ops no frame can carry: never sent again. Reported, and a resync rolls them back locally. */
  _dropUndeliverable(ops) {
    for (const op of ops) this.sentIds.delete(op.opId);
    this._report(`dropped ${ops.length} op(s) too big to send`, { kind: 'ops', code: 'PAYLOAD_TOO_LARGE', ops });
    this._requestResync('too-big');
  }

  /**
   * Leaving `boardId`: post whatever is still unacknowledged to it over HTTP
   * and clear the queue. Best effort — the server dedupes by opId, so a batch
   * that did land over the socket is a harmless no-op.
   *
   * Requests are split like socket batches (count AND bytes), and chained so
   * they land in order: a batch that updates an element must not overtake the
   * one that creates it. What fails to go out is stashed for the next visit
   * (unless the server rejected it: that can only fail again).
   *
   * `unloading` (the tab is closing): nothing chained on a response will run
   * and only ~64 KiB of keepalive bodies may be in flight. Everything is
   * stashed first; then ONE keepalive request carries the oldest ops that fit
   * (several at once could land out of order). The rest arrives with the
   * stash, on the next visit, in order. Only when the stash cannot be written
   * does the rest go out too, as plain requests, on the chance that they make
   * it before the page is torn down.
   */
  _salvage(boardId, { unloading = false } = {}) {
    this._requeueInflight();
    const frozen = this.sentIds;
    const queued = this.outbox;
    this.outbox = [];
    this.sentIds = new Set();
    this._lost = NO_LOSS;
    if (!boardId || queued.length === 0 || this.fatal) return; // a board that is gone takes nothing

    // A drag's frames fold into one update per element: less to deliver.
    const actorId = getActorId(boardId);
    const wire = collapseOps(queued, { frozen }).map((op) => ({ ...op, boardId, actorId: op.actorId ?? actorId }));
    const stash = this.options.stash;
    const post = typeof this.options.postOps === 'function' ? this.options.postOps : null;
    const save = (ops) => ops.length > 0 && Boolean(stash?.save?.(boardId, ops));

    const { chunks, tooBig } = chunkOps(wire, { maxBytes: unloading ? KEEPALIVE_BYTES : MAX_BATCH_BYTES });
    if (tooBig.length > 0) {
      this._report(`dropped ${tooBig.length} op(s) too big to send`, { kind: 'salvage', code: 'PAYLOAD_TOO_LARGE' });
    }
    const deliverable = chunks.flat();

    if (unloading) {
      const stashed = save(deliverable);
      if (!post || chunks.length === 0) return;
      const quiet = (p) => Promise.resolve(p).catch(() => {});
      quiet(post(boardId, chunks[0], { keepalive: true }));
      if (!stashed) for (const chunk of chunks.slice(1)) quiet(post(boardId, chunk, { keepalive: false }));
      return;
    }

    if (!post) {
      save(deliverable);
      return;
    }
    let delivered = 0;
    let chain = Promise.resolve();
    for (const chunk of chunks) {
      chain = chain.then(() => post(boardId, chunk)).then(() => {
        delivered += 1;
      });
    }
    chain.catch((err) => {
      const rest = chunks.slice(delivered).flat();
      if (!isRejection(err)) save(rest);
      // Not 'ops': nothing was rolled back on screen, and not BOARD_NOT_FOUND
      // either — this is the board being LEFT, not the one on screen.
      this._report(`could not deliver ${rest.length} pending op(s) to board ${boardId}: ${err?.message ?? err}`, {
        kind: 'salvage',
        code: err?.code ?? null,
      });
    });
  }

  /**
   * Broadcast a cursor position, throttled to the server's rate with a
   * trailing send so the final position always lands.
   * @param {{x:number,y:number}} p  BOARD units
   */
  sendCursor(p) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
    if (!this._canSend()) return;
    this._cursorPending = { x: p.x, y: p.y };

    const since = Date.now() - this._lastCursorSent;
    if (since >= CURSOR_INTERVAL_MS) {
      this._emitCursor();
      return;
    }

    if (this._cursorTimer === null) {
      this._cursorTimer = setTimeout(() => {
        this._cursorTimer = null;
        this._emitCursor();
      }, CURSOR_INTERVAL_MS - since);
    }
  }

  _emitCursor() {
    if (!this._cursorPending || !this._canSend()) return;
    this._lastCursorSent = Date.now();
    this._send({ type: MSG.CURSOR, boardId: this.boardId, cursor: this._cursorPending });
    this._cursorPending = null;
  }

  /**
   * Tell the room which elements this user has selected, so everyone else
   * sees them outlined in this user's colour (Excalidraw's collaborator
   * selection). Throttled with a trailing send, like the cursor; an
   * unchanged selection is not sent again. Remembered while offline and
   * announced after every join. An empty list clears it for the others.
   * @param {Iterable<string>} ids  element ids
   */
  sendSelection(ids) {
    this.selection = normalizeSelectionIds(ids);
    if (!this._canSend()) return;
    const since = Date.now() - this._lastSelectionSent;
    if (since >= SELECTION_INTERVAL_MS) {
      this._emitSelection();
      return;
    }
    if (this._selectionTimer === null) {
      this._selectionTimer = setTimeout(() => {
        this._selectionTimer = null;
        this._emitSelection();
      }, SELECTION_INTERVAL_MS - since);
    }
  }

  _emitSelection() {
    if (!this._canSend()) return;
    const key = this.selection.join('\n');
    if (key === this._selectionSent) return;
    // Nothing selected and nothing ever sent on this socket: the server
    // already records an empty selection for a fresh peer.
    if (this._selectionSent === null && this.selection.length === 0) return;
    this._lastSelectionSent = Date.now();
    if (this._send({ type: MSG.SELECTION, boardId: this.boardId, ids: this.selection })) this._selectionSent = key;
  }

  /** Tell the room which tool we hold (shown in the roster). Re-sent after every join. */
  sendActivity(tool) {
    if (typeof tool !== 'string' || !tool) return;
    this.activity = tool;
    if (this._canSend()) this._send({ type: MSG.ACTIVITY, boardId: this.boardId, text: tool });
  }

  _send(msg) {
    return this._sendRaw(JSON.stringify(msg));
  }

  _sendRaw(data) {
    if (!this._isOpen()) return false;
    try {
      this.ws.send(data);
      return true;
    } catch (err) {
      this._report(err instanceof Error ? err.message : 'send failed', { kind: 'socket' });
      return false;
    }
  }

  /** Ask the bridge to converge on the server's snapshot. */
  _requestResync(reason) {
    this.handlers.onResync?.({ reason, rev: this.rev });
  }

  // -------------------------------------------------------------- receive

  /** Parse and dispatch one frame. Anything malformed is dropped, not thrown. */
  _receive(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event?.data === 'string' ? event.data : '');
    } catch {
      this._report('ignoring a malformed frame (bad JSON)', { kind: 'protocol' });
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this._report('ignoring a frame with no type', { kind: 'protocol' });
      return;
    }

    try {
      switch (msg.type) {
        case MSG.READY: {
          this.joined = true;
          this.peerId = msg.peerId ?? null;
          this.rev = Number(msg.rev) || 0;
          // A fresh start — unless a batch keeps dying with the socket: then
          // the backoff must keep growing until an ack says it got through.
          if (this._lost.count === 0) this.attempts = 0;
          this._conflictStreak = 0;
          this._setStatus('connected');
          // The bridge replaces the local board with this snapshot and
          // re-applies everything still pending on top, THEN we flush.
          this.handlers.onReady?.(msg);
          if (this.activity) this._send({ type: MSG.ACTIVITY, boardId: this.boardId, text: this.activity });
          this._selectionSent = null;
          this._emitSelection();
          this._flush();
          break;
        }

        case MSG.OP_BROADCAST: {
          const ops = Array.isArray(msg.ops) ? msg.ops : [];
          if (Number.isFinite(msg.rev)) this.rev = Math.max(this.rev, msg.rev);
          this.handlers.onOp?.(ops, msg);
          break;
        }

        case MSG.OP_ACK:
          this._onAck(msg.result && typeof msg.result === 'object' ? msg.result : {});
          break;

        case MSG.CURSOR_BROADCAST: {
          if (!msg.peerId || msg.peerId === this.peerId) break; // our own cursor, echoed
          const c = msg.cursor ?? msg;
          if (!Number.isFinite(c?.x) || !Number.isFinite(c?.y)) break;
          this.handlers.onPeerCursor?.(
            msg.peerId,
            { x: c.x, y: c.y, name: msg.name ?? c.name ?? null, color: msg.color ?? c.color ?? null },
            msg,
          );
          break;
        }

        case MSG.SELECTION_BROADCAST: {
          if (!msg.peerId || msg.peerId === this.peerId) break; // our own, echoed
          const ids = msg.ids ?? msg.selection;
          if (!Array.isArray(ids)) break;
          this.handlers.onPeerSelection?.(
            msg.peerId,
            { ids: normalizeSelectionIds(ids), name: msg.name ?? null, color: msg.color ?? null },
            msg,
          );
          break;
        }

        case MSG.PRESENCE:
          this.handlers.onPresence?.(Array.isArray(msg.peers) ? msg.peers : []);
          break;

        case MSG.BOARD:
          if (msg.board && typeof msg.board === 'object') this.handlers.onBoard?.(msg.board);
          break;

        case MSG.RESYNC:
          // Sent to us alone after one of our batches lost a race. Pending
          // edits are KEPT: the bridge re-applies them on the fresh snapshot.
          if (Number.isFinite(msg.rev)) this.rev = Math.max(this.rev, msg.rev);
          this._requestResync('server');
          break;

        case MSG.ERROR: {
          const code = typeof msg.code === 'string' ? msg.code : null;
          // An unknown board at join, or the board deleted while we are on
          // it (the server evicts the room with this same error).
          if (code === 'BOARD_NOT_FOUND') this._boardGone();
          this._report(typeof msg.text === 'string' ? msg.text : 'server error', { kind: 'protocol', code });
          break;
        }

        case MSG.BYE:
          this._clearHeartbeat();
          break;

        default:
          // An unknown type is a newer server. Ignoring it is correct.
          break;
      }
    } catch (err) {
      this._report(err instanceof Error ? err.message : 'handler threw', { kind: 'protocol' });
    }
  }

  /** The answer to our in-flight batch. */
  _onAck(result) {
    this._clearAckTimer();
    const batch = this.inflight;
    this.inflight = null;
    if (Number.isFinite(result.rev) && result.rev > 0) this.rev = Math.max(this.rev, result.rev);
    // The server got a frame through and answered: the link works.
    this._lost = NO_LOSS;
    this.attempts = 0;

    if (!batch) {
      // Not waiting for anything (a stale ack after a reconnect). Nothing to clear.
      this._flush();
      return;
    }

    const status = result.status;
    const opIds = batch.ops.map((op) => op.opId);
    const forget = () => {
      for (const id of opIds) this.sentIds.delete(id);
    };

    if (status === RESULT.APPLIED || status === RESULT.DUPLICATE) {
      // The whole batch is the server's now (applied this time, or by an
      // earlier delivery of the same opIds). `applied` names them on newer
      // servers; older ones only list what took effect in `appliedOps`.
      forget();
      this._conflictStreak = 0;
      const acked = Array.isArray(result.applied)
        ? result.applied
        : Array.isArray(result.appliedOps)
          ? result.appliedOps.map((op) => op?.opId).filter(Boolean)
          : opIds;
      const freshCount = Array.isArray(result.appliedOps) ? result.appliedOps.length : batch.ops.length;
      // Some of it had already landed: a replay after a reconnect. The local
      // re-application may have put an older value over a newer remote one,
      // so converge once more on the server's snapshot.
      const replayed = status === RESULT.DUPLICATE || freshCount < batch.ops.length;
      this.handlers.onAck?.(result, { ops: batch.ops, acked, replayed });
      if (replayed) this._requestResync('replayed');
    } else if (status === RESULT.CONFLICT) {
      // Only possible for ops carrying baseRev, which this client never
      // sends. The batch was NOT applied: retry it (a couple of times at
      // most) and converge on the server's state meanwhile.
      this._conflictStreak += 1;
      if (this._conflictStreak <= MAX_CONFLICT_RETRIES) {
        this.outbox.unshift(...batch.ops);
      } else {
        forget();
        this._conflictStreak = 0;
        this._report(result.message || 'batch rejected (conflict)', { kind: 'ops', code: 'REV_CONFLICT', ops: batch.ops });
      }
      this._requestResync('conflict');
    } else if (status === RESULT.MISSING) {
      // The board is gone (deleted while open). Nothing queued can ever
      // land, and retrying is pointless: stop for good and say so.
      forget();
      this._boardGone();
      this._report(result.message || 'board not found', { kind: 'ops', code: 'BOARD_NOT_FOUND', ops: batch.ops });
      return;
    } else {
      // `error`, or a status this client does not know: drop, report, resync.
      // Re-sending an invalid batch can only fail again.
      forget();
      this._report(result.message || `batch rejected (${status ?? 'no status'})`, {
        kind: 'ops',
        code: result.code ?? null,
        ops: batch.ops,
      });
      this._requestResync('error');
    }

    this._flush();
  }

  /**
   * The server says this board does not exist. Final: the queue is dropped
   * (nothing in it can ever land, now or from a stash), the socket closed,
   * no reconnect is scheduled, and the status says `disconnected`.
   */
  _boardGone() {
    this.fatal = true;
    this._clearAckTimer();
    this.inflight = null;
    this.outbox = [];
    this.sentIds.clear();
    this._lost = NO_LOSS;
    this.options.stash?.drop?.(this.boardId);
    this._clearReconnect();
    this._teardown();
    this._setStatus('disconnected');
  }

  // -------------------------------------------------------------- backoff

  /** Connection failed. Retry with jittered backoff; say `disconnected` past the budget. */
  _fail(reason) {
    this._clearHeartbeat();
    this.joined = false;
    this._requeueInflight();

    if (this.intentionallyClosed) {
      this._setStatus('idle');
      return;
    }
    if (this.fatal) {
      // The server said the board does not exist: stop, and say so.
      this._setStatus('disconnected');
      return;
    }

    this.attempts += 1;
    const { backoffBaseMs, backoffMaxMs, maxAttempts } = this.options;
    // With the browser offline, failing is expected and `offline` is the
    // honest label; `disconnected` is for a network that is up and still fails.
    const browserOffline = typeof navigator !== 'undefined' && navigator.onLine === false;
    if (this.attempts > maxAttempts && !browserOffline) {
      if (this.status !== 'disconnected') {
        this._report(`connection lost after ${maxAttempts} attempts: ${reason}`, { kind: 'socket' });
      }
      this._setStatus('disconnected');
    } else {
      this._setStatus('offline');
    }

    const delay = jitter(Math.min(backoffBaseMs * 2 ** (Math.min(this.attempts, 30) - 1), backoffMaxMs));
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this._send({ type: MSG.PING, boardId: this.boardId });
    }, this.options.heartbeatMs);
  }

  _armAckTimer() {
    this._clearAckTimer();
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null;
      if (!this.inflight) return;
      // A big batch on a slow link may still be uploading: not dead yet.
      if (this._isOpen() && this.ws.bufferedAmount > 0) {
        this._armAckTimer();
        return;
      }
      // The socket looks open but nothing comes back: treat it as dead. The
      // batch goes back to the outbox and is re-sent after the reconnect.
      this._noteLostBatch(null);
      this._teardown();
      this._fail('no ack from the server');
    }, this.options.ackTimeoutMs);
  }

  _clearAckTimer() {
    if (this.ackTimer !== null) {
      clearTimeout(this.ackTimer);
      this.ackTimer = null;
    }
  }

  _clearHeartbeat() {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  _clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _clearSelectionTimer() {
    if (this._selectionTimer !== null) {
      clearTimeout(this._selectionTimer);
      this._selectionTimer = null;
    }
  }

  _clearCursorTimer() {
    if (this._cursorTimer !== null) {
      clearTimeout(this._cursorTimer);
      this._cursorTimer = null;
    }
    this._cursorPending = null;
  }

  _isOpen() {
    return Boolean(this.ws) && this.ws.readyState === OPEN;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  _report(message, info = {}) {
    this.handlers.onError?.(message, { kind: 'socket', ...info });
  }

  /** Build a well-formed op for the current board (used by the sync bridge). */
  makeOp(kind, fields = {}) {
    return { opId: newOpId(), boardId: this.boardId, kind, at: Date.now(), ...fields };
  }
}

/**
 * The singleton. Module scope, on purpose: a second instance would mean a
 * second outbox and a second socket for the same user.
 */
export const realtime = new RealtimeClient();
