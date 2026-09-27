/**
 * `@fastify/websocket` wiring: one route, one message loop, no business logic.
 *
 * Everything worth testing lives in `hub.js`. This file is the adapter between
 * the real `ws` socket and that hub, and it is written as if the network is
 * hostile: every message is untrusted JSON, and a bug in here must never take
 * the process down.
 *
 * Two invariants worth stating up front, because they are the difference
 * between a board that feels shared and one that feels haunted:
 *
 *  1. **Echo suppression.** An op batch is acked to its sender and broadcast to
 *     everyone ELSE. Echoing to the sender makes a client that already applied
 *     the op optimistically draw it twice.
 *  2. **Trailing cursor.** The cursor is rate-limited, but the last position is
 *     always delivered, even if it arrives 2ms after the previous one. Dropping
 *     it freezes the remote ghost short of where the pointer actually is.
 */

import websocket from '@fastify/websocket';
import { API, WS_MSG, validateOps, colorForPeer } from '@whiteboard/shared';
import { Hub } from './hub.js';

/** Must match `config.BODY_LIMIT`, or a big op batch is cut off mid-parse. */
const MAX_PAYLOAD = 8 * 1024 * 1024;

/** A socket that never identifies itself is closed. Slow-loris guard. */
const JOIN_TIMEOUT_MS = 10_000;

/** How long we hold a partially-received frame before giving up on it. */
const FRAME_TIMEOUT_MS = 30_000;

/** The board is unbounded, but a NaN or a 1e300 is not a coordinate. */
const CURSOR_BOUND = 1e7;

function clampCoord(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v < -CURSOR_BOUND ? -CURSOR_BOUND : v > CURSOR_BOUND ? CURSOR_BOUND : v;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function toText(data) {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return String(data);
}

/** `'/api' + '/api/ws'` would double the prefix; the route is built once. */
function joinPath(prefix, suffix) {
  if (!prefix) return suffix;
  if (suffix.startsWith(prefix)) return suffix;
  return `${prefix.replace(/\/+$/, '')}${suffix}`;
}

/**
 * Registered as a normal Fastify plugin, so it gets the whole instance and may
 * decorate it. `app.js` calls it as
 * `app.register(websocketPlugin, { config, store, hub })` and mounts REST under
 * `config.apiPrefix`; this route lives on the ROOT scope, so it has to spell
 * the prefix out itself.
 *
 * @param {import('fastify').FastifyInstance} fastify
 * @param {Object} [opts]
 * @param {Object} [opts.config]    the frozen runtime config (bootstrap's)
 * @param {Object} [opts.store]     the Store; falls back to `fastify.store`
 * @param {Object} [opts.hub]       an existing Hub; one is built when absent
 * @param {string} [opts.path]      overrides the derived route
 * @param {number} [opts.peerTtlMs]
 * @param {number} [opts.cursorRateMs]
 * @param {number} [opts.maxPayload]
 * @param {() => number} [opts.now]      injectable clock (hub + cursor limiter)
 * @param {() => string} [opts.newId]    injectable peer id factory
 */
export async function wsPlugin(fastify, opts = {}) {
  const { config, now, newId } = opts;

  const peerTtlMs = opts.peerTtlMs ?? config?.wsPeerTtlMs ?? 30_000;
  const cursorRateMs = opts.cursorRateMs ?? config?.wsCursorRateMs ?? 33;
  const maxPayload = opts.maxPayload ?? config?.bodyLimit ?? MAX_PAYLOAD;
  const path = opts.path ?? joinPath(config?.apiPrefix, API.WS);

  const store = opts.store ?? fastify.store;
  if (!store || typeof store.getSnapshot !== 'function') {
    throw new Error('wsPlugin requires a store with getSnapshot(boardId)');
  }

  const clock = typeof now === 'function' ? now : () => Date.now();
  // Reuse the hub the caller built (app.js owns it and closes it); only make
  // one when we were not given any.
  const hub = opts.hub ?? new Hub({ peerTtlMs, cursorRateMs, now: clock, newId });
  // A `register`ed plugin runs in an encapsulated scope, so a plain `decorate`
  // here is invisible to whoever registered us. app.js already assigns `hub`
  // onto the instance for exactly this reason; mirror it so the plugin is also
  // usable -- and assertable -- when registered on its own.
  if (typeof fastify.hasDecorator === 'function' && !fastify.hasDecorator('hub')) {
    fastify.decorate('hub', hub);
  }
  if (fastify.hub !== hub) fastify.hub = hub;

  await fastify.register(websocket, { options: { maxPayload } });

  /** @type {Map<string, Object>} peerId -> connection session */
  const sessions = new Map();

  fastify.get(path, { websocket: true }, (socket, request) => {
    const log = request?.log ?? fastify.log;

    // The raw `ws` socket is a live object whose readyState mutates underneath
    // us, so the adapter reads through instead of snapshotting the value.
    const client = {
      get readyState() {
        return socket.readyState;
      },
      send: (data) => socket.send(data),
      close: (code, reason) => {
        try {
          socket.close(code, reason);
        } catch {
          /* already gone */
        }
      },
    };

    // Added before `join`, so a socket that never identifies itself is still
    // something the sweeper can reap. It sits in a parking room that is
    // broadcast to nobody and never reported in a real room's roster.
    const peer = hub.add({ socket: client, boardId: '_pending', name: null });
    const session = {
      peer,
      joined: false,
      boardId: null,
      lastCursorAt: 0,
      pendingCursor: null,
      cursorTimer: null,
      joinTimer: null,
      chunks: [],
      chunkBytes: 0,
      chunkTimer: null,
    };
    sessions.set(peer.id, session);

    // A socket that connects and never speaks is a slow-loris vector and a
    // leaked peer. Grace period, then hang up.
    session.joinTimer = setTimeout(() => {
      if (session.joined) return;
      const doomed = session.peer;
      cleanup(session);
      hub.remove(doomed);
      try {
        doomed.socket.send(JSON.stringify({ type: WS_MSG.BYE, text: 'join timeout' }));
        doomed.socket.close(1008, 'join timeout');
      } catch {
        /* ignore */
      }
    }, JOIN_TIMEOUT_MS);
    session.joinTimer.unref?.();

    // @fastify/websocket v11 hands the handler a raw `ws` WebSocket, so one
    // `message` event IS one complete frame. A stream-backed build instead
    // delivers a frame as several `data` chunks terminated by an `end` marker.
    // `pipe`/`write` is what tells the two apart -- a capability check rather
    // than a version check, so both paths stay correct if that ever changes.
    const streamed = typeof socket.pipe === 'function' && typeof socket.write === 'function';

    socket.on('message', (data, isBinary) => {
      // A binary frame is never a valid envelope here; the size cap is already
      // enforced by ws, so drop it instead of feeding it to the parser.
      if (isBinary) {
        log.debug('ws: dropped a binary frame');
        return;
      }
      if (streamed) onChunk(session, data);
      else handleText(session, toText(data));
    });

    if (streamed) socket.on('end', () => flushFrame(session));

    socket.on('error', (err) => {
      log.warn({ err: err?.message, peerId: session.peer.id }, 'ws socket error');
    });

    socket.on('close', () => {
      cleanup(session);
      hub.remove(session.peer);
    });
  });

  function cleanup(session) {
    if (session.joinTimer) {
      clearTimeout(session.joinTimer);
      session.joinTimer = null;
    }
    if (session.cursorTimer) {
      clearTimeout(session.cursorTimer);
      session.cursorTimer = null;
    }
    if (session.chunkTimer) {
      clearTimeout(session.chunkTimer);
      session.chunkTimer = null;
    }
    session.chunks.length = 0;
    session.chunkBytes = 0;
    if (sessions.get(session.peer.id) === session) sessions.delete(session.peer.id);
  }

  /* -------------------------------------------------------- frame assembly */

  /** One `data` chunk from a stream-backed socket. */
  function onChunk(session, data) {
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(toText(data), 'utf8');
    if (session.chunkBytes + chunk.length > maxPayload) {
      // Over the cap: this frame is unparseable garbage. Start clean and wait
      // for the next one rather than growing a buffer without bound.
      session.chunks.length = 0;
      session.chunkBytes = 0;
      return;
    }
    session.chunks.push(chunk);
    session.chunkBytes += chunk.length;

    if (session.chunkTimer) clearTimeout(session.chunkTimer);
    session.chunkTimer = setTimeout(() => {
      session.chunkTimer = null;
      session.chunks.length = 0;
      session.chunkBytes = 0;
    }, FRAME_TIMEOUT_MS);
    session.chunkTimer.unref?.();

    // The stream adapter appends the ws `end` marker to the data event.
    if (chunk.length === 0 || chunk[chunk.length - 1] === 0) flushFrame(session);
  }

  function flushFrame(session) {
    if (session.chunkTimer) {
      clearTimeout(session.chunkTimer);
      session.chunkTimer = null;
    }
    if (session.chunks.length === 0) return;
    const buffer = session.chunks.length === 1 ? session.chunks[0] : Buffer.concat(session.chunks);
    session.chunks.length = 0;
    session.chunkBytes = 0;
    handleText(session, buffer.toString('utf8'));
  }

  /**
   * One complete message -> one dispatch. Never throws: a bad message logs and
   * is dropped, because crashing here would kill the process and with it every
   * other board this server is hosting.
   */
  function handleText(session, text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      fastify.log.debug('ws: dropped a frame that was not JSON');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      fastify.log.debug('ws: dropped a non-object message');
      return;
    }
    // Dispatched without awaiting: a slow store must not stall the socket's
    // event loop. Every handler is internally try/caught.
    void dispatch(session, message);
  }

  async function dispatch(session, message) {
    const log = fastify.log;
    try {
      switch (message.type) {
        case WS_MSG.JOIN:
          return await onJoin(session, message);
        case WS_MSG.OPS:
          return await onOps(session, message);
        case WS_MSG.CURSOR:
          return onCursor(session, message);
        case WS_MSG.ACTIVITY:
          return onActivity(session, message);
        case WS_MSG.PING:
          hub.touch(session.peer.id);
          return;
        default:
          log.debug({ type: message.type }, 'ws: ignoring unknown message type');
      }
    } catch (err) {
      log.error(
        { err: err?.message, type: message.type, peerId: session.peer.id },
        'ws: message handler threw',
      );
    }
  }

  function error(peer, text, extra = {}) {
    hub.send(peer, { type: 'error', text, ...extra });
  }

  /* -------------------------------------------------------------- handlers */

  async function onJoin(session, message) {
    const peer = session.peer;
    if (session.joined) return; // a re-join is a no-op, not a reset

    const boardId = message.boardId;
    if (!isNonEmptyString(boardId)) {
      error(peer, 'join requires a boardId');
      return;
    }

    const snapshot = await store.getSnapshot(boardId);
    if (!snapshot) {
      error(peer, 'board not found', { code: 'BOARD_NOT_FOUND', boardId });
      cleanup(session);
      hub.remove(peer);
      try {
        peer.socket.close(1008, 'board not found');
      } catch {
        /* ignore */
      }
      return;
    }

    // The SAME peer, same id, same colour: just moved out of the parking room
    // into the real one, and named. Re-adding would change the client's
    // identity colour and broadcast a phantom presence on the way.
    const seated = hub.seat(peer, { boardId, name: message.peer?.name ?? message.name });
    if (!seated) return; // the socket closed while we awaited the store

    if (session.joinTimer) {
      clearTimeout(session.joinTimer);
      session.joinTimer = null;
    }
    session.joined = true;
    session.boardId = boardId;

    hub.send(seated, {
      type: WS_MSG.READY,
      peerId: seated.id,
      board: snapshot.board,
      elements: snapshot.elements,
      rev: snapshot.rev,
      peers: hub.peersOf(boardId),
    });

    // The joiner already has the roster in `ready`; tell everyone else.
    hub.broadcast(boardId, hub.presence(boardId), seated.id);
  }

  async function onOps(session, message) {
    const { peer } = session;
    if (!session.joined || !session.boardId) {
      error(peer, 'join before sending ops');
      return;
    }
    // Liveness: a client actively editing is not idle, whatever its ping says.
    hub.touch(peer.id);

    let ops;
    try {
      ops = validateOps(message.ops);
    } catch (err) {
      // Rejected without touching the store: nothing is half-applied, and the
      // client keeps its optimistic state to re-send from.
      hub.send(peer, {
        type: WS_MSG.OP_ACK,
        result: { status: 'error', message: err?.message ?? 'invalid ops' },
      });
      return;
    }

    const boardId = session.boardId;
    const result = await store.applyOps(boardId, ops, peer.id);

    hub.send(peer, { type: WS_MSG.OP_ACK, result });

    if (result.status === 'applied' || result.status === 'duplicate') {
      // ECHO SUPPRESSED: everyone but the sender, who already drew it.
      if (result.appliedOps?.length) {
        hub.broadcast(
          boardId,
          {
            type: WS_MSG.OP_BROADCAST,
            boardId,
            peerId: peer.id,
            ops: result.appliedOps,
            rev: result.rev,
          },
          peer.id,
        );
      }
      return;
    }

    // conflict / missing: the sender lost its race. Tell the WHOLE room to
    // refetch, the sender included, so its optimistic state is replaced by the
    // truth instead of silently diverging.
    hub.broadcast(boardId, { type: WS_MSG.RESYNC, boardId, rev: result.rev ?? 0 }, null);
  }

  function onCursor(session, message) {
    const { peer } = session;
    if (!session.joined || !session.boardId) return;
    hub.touch(peer.id);

    const source = message.cursor ?? message;
    const cursor = { x: clampCoord(source?.x), y: clampCoord(source?.y) };
    // A NaN would poison the client renderer for everyone in the room.
    if (cursor.x === null || cursor.y === null) return;

    const envelope = {
      type: WS_MSG.CURSOR_BROADCAST,
      boardId: session.boardId,
      peerId: peer.id,
      cursor,
      name: peer.name,
      color: peer.color ?? colorForPeer(peer.id),
    };

    const at = clock();
    const elapsed = at - session.lastCursorAt;
    if (session.lastCursorAt === 0 || elapsed >= cursorRateMs) {
      session.lastCursorAt = at;
      session.pendingCursor = null;
      hub.broadcast(session.boardId, envelope, peer.id);
      return;
    }

    // Too soon. Hold the NEWEST position and schedule it -- the last move is
    // the one that must land, or the remote ghost stops short of the pointer.
    session.pendingCursor = envelope;
    if (!session.cursorTimer) {
      const wait = Math.max(1, cursorRateMs - elapsed);
      session.cursorTimer = setTimeout(() => {
        session.cursorTimer = null;
        const pending = session.pendingCursor;
        session.pendingCursor = null;
        if (!pending) return;
        session.lastCursorAt = clock();
        if (session.joined && session.boardId) {
          hub.broadcast(session.boardId, pending, peer.id);
        }
      }, wait);
      session.cursorTimer.unref?.();
    }
  }

  function onActivity(session, message) {
    const { peer } = session;
    if (!session.joined) return;
    // Broadcast only when the tool actually CHANGED. A presence fan-out on
    // every keystroke is pure waste and churns the whole roster.
    const touched = hub.touch(peer.id, { tool: message.text });
    if (touched?.toolChanged && session.boardId) {
      hub.broadcast(session.boardId, hub.presence(session.boardId));
    }
  }

  /* ------------------------------------------------------------- lifecycle */

  // The sweeper. An interval that outlives the server is the classic reason a
  // process refuses to shut down, so it is cleared in an onClose hook and
  // unref'd as a second line of defence.
  const sweeper = setInterval(() => {
    try {
      hub.prune();
    } catch (err) {
      fastify.log.error({ err: err?.message }, 'ws: prune failed');
    }
  }, Math.max(1, Math.floor(peerTtlMs / 2)));
  sweeper.unref?.();

  fastify.addHook('onClose', async () => {
    clearInterval(sweeper);
    for (const session of [...sessions.values()]) cleanup(session);
    sessions.clear();
    // The contract with the hub is `close()`, never "reach in and clear the
    // maps": a hub that is not ours (a stub, a future store-backed roster) must
    // survive a shutdown, and a hub that DOES have close() closes every socket
    // it still holds. `?.()` because a bare fake is allowed to have neither.
    try {
      hub.close?.();
    } catch (err) {
      fastify.log.error({ err: err?.message }, 'ws: hub close failed');
    }
  });

  return hub;
}

export default wsPlugin;
