/**
 * Presence and fan-out for the collaboration layer.
 *
 * DELIBERATELY FREE OF FASTIFY. Nothing in this file imports a framework, a
 * route, or a store. That is the whole design: the interesting logic of a
 * collaborative board — who is in the room, who is silent, who must NOT get
 * the echo of their own op — is testable in microseconds with a fake socket
 * and an injected clock, instead of needing a listening server and real
 * timers. `plugin.js` is the thin Fastify shell around this.
 *
 * A "room" is a board id. A "peer" is one WebSocket connection.
 */

import { randomUUID } from 'node:crypto';
import { WS_MSG, TOOLS } from '@whiteboard/shared';
import { colorForPeer } from '@whiteboard/shared';

/** `ws` readyState: 1 === OPEN. Anything else means the send must be dropped. */
const WS_OPEN = 1;

/** Fallback display name when a client joins without one. */
const DEFAULT_NAME = 'Anonymous';

/** Longest display name we keep; a roster is not a place for a 4KB bio. */
const MAX_NAME = 40;

/** The mode a peer is in until they pick a tool. */
const DEFAULT_TOOL = TOOLS[0];

function defaultId() {
  return randomUUID();
}

function cleanName(raw) {
  if (typeof raw !== 'string') return DEFAULT_NAME;
  const s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return DEFAULT_NAME;
  return s.length > MAX_NAME ? s.slice(0, MAX_NAME) : s;
}

/** The public shape of a peer: exactly what is safe to put on the wire. */
function toWire(peer) {
  return {
    id: peer.id,
    name: peer.name,
    color: peer.color,
    lastSeen: peer.lastSeen,
    tool: peer.tool,
  };
}

export class Hub {
  /**
   * @param {Object} [options]
   * @param {number} [options.peerTtlMs]  silence after which a peer is dropped
   * @param {number} [options.cursorRateMs] min gap between two cursor fans
   * @param {() => number} [options.now] injectable clock, so tests need no sleeps
   * @param {() => string} [options.newId] injectable id factory
   */
  constructor({ peerTtlMs = 30000, cursorRateMs = 33, now = () => Date.now(), newId = defaultId } = {}) {
    this.peerTtlMs = peerTtlMs;
    this.cursorRateMs = cursorRateMs;
    this.now = now;
    this.newId = newId;

    /** @type {Map<string, Object>} peerId -> peer */
    this.peers = new Map();
    /** @type {Map<string, Set<string>>} boardId -> peer ids */
    this.rooms = new Map();
  }

  /**
   * Seat a peer in a board room.
   * @param {{socket: Object, boardId: string, name?: string}} input
   * @returns {Object} the peer (with its `socket`, which is never sent to anyone)
   */
  add({ socket, boardId, name } = {}) {
    if (!socket) throw new TypeError('hub.add requires a socket');
    const room = typeof boardId === 'string' && boardId ? boardId : '_unassigned';
    const id = this.newId();
    const peer = {
      id,
      name: cleanName(name),
      // Deterministic from the id, so the client derives the exact same colour
      // from what we hand it and a reconnect keeps its identity colour.
      color: colorForPeer(id),
      boardId: room,
      lastSeen: this.now(),
      tool: DEFAULT_TOOL,
      socket,
    };
    this.peers.set(id, peer);
    let ids = this.rooms.get(room);
    if (!ids) {
      ids = new Set();
      this.rooms.set(room, ids);
    }
    ids.add(id);
    return peer;
  }

  /**
   * Move an already-added peer into its real room and name it.
   *
   * A connection is added the moment it opens, before it says which board it
   * wants, so that a socket which never joins is still something the sweeper
   * can reap. `seat` moves that same peer — same id, same colour — into the
   * real room, instead of removing and re-adding, which would change the
   * client's identity colour for a reconnect and broadcast a phantom presence
   * for the parking room.
   *
   * @param {Object} peer
   * @param {{boardId: string, name?: string}} into
   * @returns {Object|null} the peer, or null if it is already gone
   */
  seat(peer, { boardId, name } = {}) {
    if (!peer) return null;
    const current = this.peers.get(peer.id);
    if (!current) return null;
    const room = typeof boardId === 'string' && boardId ? boardId : '_unassigned';
    if (current.boardId !== room) {
      const from = this.rooms.get(current.boardId);
      if (from) {
        from.delete(current.id);
        if (from.size === 0) this.rooms.delete(current.boardId);
      }
      let ids = this.rooms.get(room);
      if (!ids) {
        ids = new Set();
        this.rooms.set(room, ids);
      }
      ids.add(current.id);
      current.boardId = room;
    }
    if (name !== undefined) current.name = cleanName(name);
    return current;
  }

  /**
   * Detach a peer. Idempotent: removing an unknown or already-removed peer is a
   * silent no-op, because a socket can fire `close` after a prune already took
   * it and neither path may be allowed to throw or double-broadcast.
   *
   * @param {Object} peer
   * @returns {boolean} true if this call is the one that removed it
   */
  remove(peer) {
    const detached = this._detach(peer);
    if (!detached) return false;
    this.broadcast(detached.boardId, this.presence(detached.boardId));
    return true;
  }

  /** Bookkeeping only — no wire traffic. Shared by `remove` and `prune`. */
  _detach(peer) {
    if (!peer) return null;
    const id = typeof peer === 'string' ? peer : peer.id;
    const current = this.peers.get(id);
    if (!current) return null;
    this.peers.delete(id);
    const ids = this.rooms.get(current.boardId);
    if (ids) {
      ids.delete(id);
      // A room with nobody left is not a room. Keeping them would grow an
      // unbounded map on a long-lived server, one dead Set per board ever opened.
      if (ids.size === 0) this.rooms.delete(current.boardId);
    }
    return current;
  }

  /** @param {string} peerId @returns {Object|undefined} */
  get(peerId) {
    return this.peers.get(peerId);
  }

  /**
   * The roster as it goes on the wire: a fresh array of socket-free objects, so
   * a caller cannot reach in and mutate hub state (or leak a socket into a
   * JSON payload by spreading the peer).
   *
   * @param {string} boardId
   * @returns {Object[]}
   */
  peersOf(boardId) {
    const ids = this.rooms.get(boardId);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const peer = this.peers.get(id);
      if (peer) out.push(toWire(peer));
    }
    return out;
  }

  /** The `presence` envelope for a room, with the roster already filled in. */
  presence(boardId) {
    return {
      type: WS_MSG.PRESENCE,
      boardId,
      peers: this.peersOf(boardId),
    };
  }

  /**
   * Fan an envelope out to a room.
   *
   * `exceptPeerId` is how op echo-suppression happens: the sender already has
   * the optimistic state, and an echo is precisely what makes a naive client
   * draw the same element twice.
   *
   * @param {string} boardId
   * @param {Object} envelope
   * @param {string|null} [exceptPeerId]
   * @returns {number} how many sockets actually took the message
   */
  broadcast(boardId, envelope, exceptPeerId = null) {
    const ids = this.rooms.get(boardId);
    if (!ids || !envelope) return 0;
    let sent = 0;
    for (const id of [...ids]) {
      if (exceptPeerId && id === exceptPeerId) continue;
      const peer = this.peers.get(id);
      if (!peer) continue;
      if (this.send(peer, envelope)) sent += 1;
    }
    return sent;
  }

  /**
   * Refresh a peer's liveness, and optionally its tool.
   * @param {string} peerId
   * @param {{tool?: string}} [patch]
   * @returns {{peer: Object, toolChanged: boolean}|null} null if the peer is gone
   */
  touch(peerId, { tool } = {}) {
    const peer = this.peers.get(peerId);
    if (!peer) return null;
    peer.lastSeen = this.now();
    let toolChanged = false;
    if (typeof tool === 'string' && tool && TOOLS.includes(tool) && tool !== peer.tool) {
      peer.tool = tool;
      toolChanged = true;
    }
    return { peer, toolChanged };
  }

  /**
   * Drop every peer that has been silent past `peerTtlMs`.
   *
   * A real client ping keeps itself alive; a client that vanished without a
   * close frame (laptop lid, dead network) does not, and without this its
   * ghost cursor and its name would sit in the roster forever.
   *
   * @returns {boolean} true if at least one peer was dropped
   */
  prune() {
    const cutoff = this.now() - this.peerTtlMs;
    const gone = [];
    for (const peer of this.peers.values()) {
      if (peer.lastSeen < cutoff) gone.push(peer);
    }
    if (gone.length === 0) return false;
    // One presence per affected room, sent after the bookkeeping, so the
    // roster on the wire is already the final one.
    const dirty = new Set();
    for (const peer of gone) {
      const detached = this._detach(peer);
      if (detached) dirty.add(detached.boardId);
    }
    for (const boardId of dirty) {
      this.broadcast(boardId, this.presence(boardId));
    }
    return true;
  }

  /**
   * JSON-encode and hand an envelope to one peer.
   * A socket that is not open (closing, closed, errored) gets a silent no-op:
   * a throw here would tear down a whole fan-out for one dead connection.
   * @returns {boolean} whether the message was handed to the socket
   */
  send(peer, envelope) {
    if (!peer || !peer.socket) return false;
    const socket = peer.socket;
    if (socket.readyState !== WS_OPEN) return false;
    try {
      socket.send(JSON.stringify(envelope));
      return true;
    } catch {
      return false;
    }
  }

  /** @returns {{rooms: number, peers: number}} */
  stats() {
    return { rooms: this.rooms.size, peers: this.peers.size };
  }

  /**
   * Drop everything and close every socket. `app.js` calls this from its
   * onClose hook, so a shutting-down server does not leave peers holding open
   * sockets that keep the process alive.
   *
   * @returns {number} how many peers were closed
   */
  close() {
    const peers = [...this.peers.values()];
    this.peers.clear();
    this.rooms.clear();
    let closed = 0;
    for (const peer of peers) {
      const socket = peer.socket;
      if (!socket) continue;
      try {
        if (typeof socket.close === 'function') socket.close(1001, 'server shutting down');
        closed += 1;
      } catch {
        /* already gone */
      }
    }
    return closed;
  }
}

export default Hub;
