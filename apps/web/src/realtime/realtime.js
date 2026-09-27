/**
 * The WebSocket client. ONE instance for the whole app, created at module
 * scope so the outbox survives remounts: switching boards in the UI, or a
 * React StrictMode double-mount in dev, must not drop queued ops on the
 * floor. A per-hook socket would lose edits on every route change.
 *
 * Three behaviours here are the difference between collaboration that works
 * and collaboration that "usually works":
 *
 *  1. **The outbox.** Ops are appended to a queue and flushed when the
 *     socket is open. They carry the `baseRev` the client last saw, so the
 *     server can reject the batch if the board moved. Offline edits are not
 *     lost and are not silently applied to a board that changed underneath
 *     them.
 *
 *  2. **Conflict means resync, never replay.** On `ack` with
 *     `status:'conflict'` the outbox is DROPPED and a resync is requested.
 *     Replaying stale ops onto a moved board is how you corrupt a diagram:
 *     the other user's edit gets overwritten and nobody can tell why.
 *
 *  3. **Bounded backoff with jitter, then give up.** A server restart makes
 *     every browser reconnect at once; without jitter that is a thundering
 *     herd that keeps the server down. And a client that retries forever
 *     looks exactly like "collaboration is broken, no reason given" — so
 *     after the attempt budget is spent the client reports `disconnected`
 *     and stops, and the UI can say so.
 *
 * Malformed frames are ignored, never thrown: a server bug or a proxy
 * injecting garbage must not take the app down.
 */

import { WS_URL } from '../api/client.js';
import { getActorId, newOpId } from '../api/client.js';
import { WS_MSG, OP_RESULT } from '@whiteboard/shared';

/** Server-side cursor rate limit is ~30/s; match it, plus a trailing send. */
const CURSOR_INTERVAL_MS = 33;

/** Backoff: 1s, 2s, 4s ... capped at 15s, with jitter. */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 15_000;

/** After this many consecutive failures we stop and surface `disconnected`. */
const MAX_ATTEMPTS = 8;

/** Safety valve: never let the outbox grow without bound. */
const MAX_OUTBOX = 500;

const jitter = (ms) => Math.round(ms * (0.7 + Math.random() * 0.6));

export class RealtimeClient {
  constructor() {
    /** @type {WebSocket|null} */
    this.ws = null;
    this.boardId = null;
    this.peerId = null;
    this.name = 'Anonymous';

    /** Ops queued but not yet acknowledged. */
    this.outbox = [];

    /** The board rev this client last saw. Sent as `baseRev` on every batch. */
    this.rev = 0;

    this.status = 'idle'; // idle | connecting | connected | offline | disconnected
    this.attempts = 0;
    this.reconnectTimer = null;
    this.heartbeatTimer = null;
    this.pruneTimer = null;
    this.intentionallyClosed = false;

    this._cursorPending = null;
    this._cursorTimer = null;
    this._lastCursorSent = 0;

    /**
     * Handlers wired by `useRealtime`. Kept as a bag rather than passed per
     * call so a remount does not have to re-open the socket just to swap a
     * callback.
     */
    this.handlers = {
      onReady: null,
      onOp: null,
      onAck: null,
      onPeerCursor: null,
      onPresence: null,
      onResync: null,
      onStatus: null,
      onError: null,
    };
  }

  // ------------------------------------------------------------- lifecycle

  /**
   * Open the socket and join a board. Idempotent per board: calling it with
   * the board we are already on is a no-op, which is what makes a
   * StrictMode double-mount harmless.
   *
   * @param {string} boardId
   * @param {{name?: string}} [opts]
   */
  connect(boardId, { name } = {}) {
    if (!boardId) return;
    if (name) this.name = name;

    if (this.ws && this.boardId === boardId &&
        (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    // A different board: tear the old one down, but KEEP the outbox — the
    // ops belong to the client, and dropping them is data loss.
    if (this.ws || this.boardId) this._teardown();

    this.boardId = boardId;
    this.intentionallyClosed = false;
    this.attempts = 0;
    this._open();
  }

  /** Close the socket and stop all timers. Safe to call when not connected. */
  disconnect() {
    this.intentionallyClosed = true;
    this._teardown();
    this._setStatus('idle');
  }

  _teardown() {
    this._clearReconnect();
    this._clearHeartbeat();
    this._clearPrune();
    this._clearCursorTimer();

    if (this.ws) {
      // Detach before closing: a close event from a socket we no longer
      // care about must not schedule a reconnect for the old board.
      this.ws.onopen = null;
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onclose = null;
      try {
        this.ws.close();
      } catch {
        /* already closing */
      }
      this.ws = null;
    }
    this.peerId = null;
  }

  _open() {
    if (!this.boardId) return;
    this._setStatus('connecting');

    let ws;
    try {
      ws = new WebSocket(WS_URL);
    } catch (err) {
      this._fail(err instanceof Error ? err.message : 'WebSocket constructor threw');
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      if (this.ws !== ws) return; // a stale socket finished opening
      this.attempts = 0;
      this._setStatus('connected');
      this._send({
        type: WS_MSG.JOIN,
        boardId: this.boardId,
        peerId: getActorId(this.boardId),
        peer: { name: this.name },
      });
      this._startHeartbeat();
    };

    ws.onmessage = (event) => this._receive(event);

    ws.onerror = () => {
      // The error event carries no useful detail by design; `onclose` always
      // follows and carries the code we act on.
      this._report('WebSocket error');
    };

    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this._clearHeartbeat();
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
   * @param {object[]} ops
   */
  sendOps(ops) {
    const list = Array.isArray(ops) ? ops.filter((o) => o && o.opId && o.kind) : [];
    if (list.length === 0) return;

    for (const op of list) {
      this.outbox.push({ ...op, boardId: op.boardId || this.boardId, at: op.at || Date.now() });
    }

    // Oldest-first: ops are order-dependent on the server, so a full outbox
    // is trimmed from the NEW end (the freshest local state), never the old.
    if (this.outbox.length > MAX_OUTBOX) {
      this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
    }

    this._flush();
  }

  _flush() {
    if (!this._isOpen() || this.outbox.length === 0) return;

    // One batch per frame-ish window; a drag emits 60 updates a second and
    // they go as ONE message.
    const batch = this.outbox.splice(0, 200);
    for (const op of batch) {
      op.baseRev = this.rev;
      op.actorId = getActorId(this.boardId);
    }

    this._send({ type: WS_MSG.OPS, boardId: this.boardId, ops: batch, baseRev: this.rev });
    // Put them back at the front until an ack says what happened. `unshift`
    // in order preserves the exact sequence the server must see.
    this.outbox.unshift(...batch);
  }

  /**
   * Broadcast a cursor position, throttled to the server's rate with a
   * trailing send so the final position always lands.
   * @param {{x:number,y:number}} p  board units
   */
  sendCursor(p) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
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
    if (!this._cursorPending || !this._isOpen()) return;
    this._lastCursorSent = Date.now();
    this._send({ type: WS_MSG.CURSOR, boardId: this.boardId, cursor: this._cursorPending });
    this._cursorPending = null;
  }

  _send(msg) {
    if (!this._isOpen()) return false;
    try {
      this.ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      this._report(err instanceof Error ? err.message : 'send failed');
      return false;
    }
  }

  // -------------------------------------------------------------- receive

  /** Parse and dispatch one frame. Anything malformed is dropped, not thrown. */
  _receive(event) {
    let msg;
    try {
      msg = JSON.parse(typeof event?.data === 'string' ? event.data : '');
    } catch {
      this._report('ignoring a malformed frame (bad JSON)');
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') {
      this._report('ignoring a frame with no type');
      return;
    }

    try {
      switch (msg.type) {
        case WS_MSG.READY: {
          this.peerId = msg.peerId ?? null;
          this.rev = Number(msg.rev) || 0;
          if (Array.isArray(msg.peers)) this.handlers.onPresence?.(msg.peers);
          this.handlers.onReady?.(msg);
          // If the server is ahead of us we are missing ops: take its state
          // from `ready`, then resync BEFORE flushing, or our stale baseRev
          // conflicts immediately and the outbox is dropped.
          this._flush();
          break;
        }

        case WS_MSG.OP_BROADCAST: {
          const ops = Array.isArray(msg.ops) ? msg.ops : [];
          if (Number.isFinite(msg.rev)) this.rev = msg.rev;
          this.handlers.onOp?.(ops, msg);
          break;
        }

        case WS_MSG.OP_ACK: {
          const result = msg.result ?? {};
          if (Number.isFinite(result.rev)) this.rev = result.rev;

          if (result.status === OP_RESULT.CONFLICT) {
            // The board moved. Drop the outbox and resync — do NOT replay.
            this.outbox = [];
            this.handlers.onResync?.({ reason: 'conflict', rev: result.rev ?? null });
          } else {
            // applied or duplicate: both mean these ops are the server's now.
            const acked = new Set(Array.isArray(result.applied) ? result.applied : []);
            this.outbox = this.outbox.filter((op) => !acked.has(op.opId));
            this.handlers.onAck?.(result, msg);
            // More arrived while the ack was in flight.
            if (this.outbox.length > 0) this._flush();
          }
          break;
        }

        case WS_MSG.CURSOR_BROADCAST: {
          if (msg.peerId === this.peerId) break; // our own cursor, echoed
          this.handlers.onPeerCursor?.(msg.peerId, msg.cursor ?? msg, msg);
          break;
        }

        case WS_MSG.PRESENCE: {
          this.handlers.onPresence?.(Array.isArray(msg.peers) ? msg.peers : []);
          break;
        }

        case WS_MSG.RESYNC: {
          if (Number.isFinite(msg.rev)) this.rev = msg.rev;
          this.outbox = [];
          this.handlers.onResync?.({ reason: 'missed-ops', rev: msg.rev ?? null });
          break;
        }

        case WS_MSG.BYE: {
          this._clearHeartbeat();
          break;
        }

        default:
          // An unknown message type is a newer server. Ignoring it is
          // correct; throwing would break every client on an older build.
          break;
      }
    } catch (err) {
      this._report(err instanceof Error ? err.message : 'handler threw');
    }
  }

  // -------------------------------------------------------------- backoff

  /** Connection failed. Retry with jittered backoff, or give up and say so. */
  _fail(reason) {
    this._clearHeartbeat();
    this.outbox.length = 0; // ops that were in flight are gone; the next batch is what we have

    if (this.intentionallyClosed) {
      this._setStatus('idle');
      return;
    }

    this.attempts += 1;
    if (this.attempts > MAX_ATTEMPTS) {
      // Give up. An infinite silent retry loop is indistinguishable from a
      // broken app; a definite `disconnected` lets the UI explain itself.
      this._setStatus('disconnected');
      this._report(`giving up after ${MAX_ATTEMPTS} attempts: ${reason}`);
      return;
    }

    this._setStatus('offline');
    const delay = jitter(Math.min(BACKOFF_BASE_MS * 2 ** (this.attempts - 1), BACKOFF_MAX_MS));
    this._clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._open();
    }, delay);
  }

  _startHeartbeat() {
    this._clearHeartbeat();
    // The server drops peers silent past its TTL; pinging at a third of that
    // is cheap and keeps us on the roster.
    this.heartbeatTimer = setInterval(() => {
      this._send({ type: WS_MSG.PING, boardId: this.boardId });
    }, 10_000);
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

  _clearPrune() {
    if (this.pruneTimer !== null) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = null;
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
    return Boolean(this.ws) && this.ws.readyState === WebSocket.OPEN;
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this.handlers.onStatus?.(status);
  }

  _report(message) {
    this.handlers.onError?.(message);
  }

  // ------------------------------------------------------------ test hooks

  /** Build a well-formed op, so sync.js does not repeat the boilerplate. */
  makeOp(kind, fields = {}) {
    return { opId: newOpId(), boardId: this.boardId, kind, at: Date.now(), ...fields };
  }
}

/**
 * The singleton. Module scope, on purpose: a second instance would mean a
 * second outbox and a second socket for the same user.
 */
export const realtime = new RealtimeClient();
