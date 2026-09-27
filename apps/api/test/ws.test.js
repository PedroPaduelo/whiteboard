/**
 * The WebSocket collaboration layer.
 *
 * Most of this file drives the HUB directly with a fake socket and an injected
 * clock. That is not a shortcut — it is the whole reason the hub imports no
 * framework: the tricky parts (echo suppression, TTL eviction, the trailing
 * cursor) are asserted in microseconds with no ports, no timers and no flakes.
 *
 * One end-to-end test then goes over a real `ws` client against a real
 * listening Fastify, to prove the wiring is right and not just the logic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import WebSocket from 'ws';

import { WS_MSG, colorForPeer } from '@whiteboard/shared';
import { Hub } from '../src/ws/hub.js';
import wsPlugin from '../src/ws/plugin.js';
import { createMemoryStore } from '../src/store/index.js';

/* ------------------------------------------------------------------ helpers */

/** A socket that records what it was handed. `readyState: 1` === OPEN. */
function fakeSocket() {
  return {
    readyState: 1,
    sent: [],
    closed: [],
    send(data) {
      this.sent.push(data);
    },
    close(code, reason) {
      this.closed.push({ code, reason });
    },
    /** Everything this socket was sent, parsed. */
    json() {
      return this.sent.map((s) => JSON.parse(s));
    },
    /** The parsed envelopes of one type, in order. */
    ofType(type) {
      return this.json().filter((m) => m.type === type);
    },
  };
}

/** A hub whose clock and ids are fully under the test's control. */
function testHub(overrides = {}) {
  const clock = { t: 1_000_000 };
  let n = 0;
  const hub = new Hub({
    now: () => clock.t,
    newId: () => `p${++n}`,
    peerTtlMs: 30_000,
    ...overrides,
  });
  return { hub, clock, advance: (ms) => (clock.t += ms) };
}

/**
 * A client connected to a real server. Every message is collected; `waitFor`
 * polls the log so a test never sleeps longer than it must.
 */
function client(url) {
  const ws = new WebSocket(url);
  const log = [];
  ws.on('message', (raw) => log.push(JSON.parse(raw.toString('utf8'))));
  const errors = [];
  ws.on('error', (err) => errors.push(err));
  const open = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return {
    ws,
    log,
    errors,
    open,
    send: (msg) => ws.send(JSON.stringify(msg)),
    close: () => ws.close(),
    json: () => log,
    ofType: (type) => log.filter((m) => m.type === type),
    /** Resolve with the first envelope of `type` at or after `from`. */
    async waitFor(type, { from = 0, timeout = 2000 } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const hit = log.slice(from).find((m) => m.type === type);
        if (hit) return hit;
        if (Date.now() > deadline) {
          throw new Error(
            `timed out waiting for "${type}"; saw ${JSON.stringify(log.map((m) => m.type))}`,
          );
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    },
  };
}

/* ---------------------------------------------------------------- HUB tests */

test('hub: add seats a peer with a deterministic colour and room', () => {
  const { hub } = testHub();
  const socket = fakeSocket();
  const peer = hub.add({ socket, boardId: 'b1', name: 'Ada' });

  assert.equal(peer.name, 'Ada');
  assert.equal(peer.boardId, 'b1');
  assert.equal(peer.socket, socket);
  assert.equal(peer.color, colorForPeer(peer.id), 'colour must be derivable from the id');
  assert.deepEqual(hub.stats(), { rooms: 1, peers: 1 });
  assert.equal(hub.get(peer.id), peer);
});

test('hub: remove is idempotent and broadcasts presence only once', () => {
  const { hub } = testHub();
  const a = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });
  const b = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'B' });

  assert.equal(hub.remove(a), true, 'the first remove does the work');
  // b was told the roster shrank.
  const seen = b.socket.ofType(WS_MSG.PRESENCE);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].peers.map((p) => p.name), ['B']);

  // A second remove is a no-op: a socket that fires `close` after the sweeper
  // already reaped it must not throw, nor re-broadcast.
  assert.equal(hub.remove(a), false);
  assert.equal(hub.remove(a), false);
  assert.equal(hub.remove(null), false);
  assert.equal(b.socket.ofType(WS_MSG.PRESENCE).length, 1);
  assert.deepEqual(hub.stats(), { rooms: 1, peers: 1 });
});

test('hub: peersOf never leaks the socket', () => {
  const { hub } = testHub();
  hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });

  const roster = hub.peersOf('b1');
  assert.equal(roster.length, 1);
  assert.equal('socket' in roster[0], false, 'a socket must never reach the wire');

  // And it is a copy: mutating the roster cannot reach back into hub state.
  roster[0].name = 'tampered';
  assert.equal(hub.peersOf('b1')[0].name, 'A');
  assert.deepEqual(hub.peersOf('no-such-board'), []);
});

test('hub: broadcast skips exceptPeerId', () => {
  const { hub } = testHub();
  const a = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });
  const b = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'B' });
  const c = hub.add({ socket: fakeSocket(), boardId: 'b2', name: 'C' });

  const sent = hub.broadcast('b1', { type: WS_MSG.PING, text: 'x' }, a.id);

  assert.equal(sent, 1);
  assert.equal(b.socket.sent.length, 1);
  assert.equal(a.socket.sent.length, 0, 'the excluded peer gets nothing');
  assert.equal(c.socket.sent.length, 0, 'a peer in another room gets nothing');
  assert.deepEqual(hub.broadcast('nope', { type: WS_MSG.PING }), 0);
});

test('hub: a closed socket is a silent no-op, never a throw', () => {
  const { hub } = testHub();
  const dead = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'dead' });
  const live = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'live' });

  dead.socket.readyState = 3; // CLOSED
  assert.equal(hub.send(dead, { type: WS_MSG.PING }), false);
  assert.equal(dead.socket.sent.length, 0);

  // A fan-out containing one dead socket must still reach the live one: a
  // single dead connection cannot be allowed to break a whole broadcast.
  assert.equal(hub.broadcast('b1', { type: WS_MSG.PRESENCE }), 1);
  assert.equal(live.socket.ofType(WS_MSG.PRESENCE).length, 1);

  // A socket whose send throws is equally survivable.
  const angry = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'angry' });
  angry.socket.send = () => {
    throw new Error('EPIPE');
  };
  assert.equal(hub.send(angry, { type: WS_MSG.PING }), false);
  assert.equal(hub.broadcast('b1', { type: WS_MSG.PING }), 1);
});

test('hub: prune drops a peer silent past the TTL, and only after time passes', () => {
  const { hub, advance } = testHub({ peerTtlMs: 1000 });
  // Two peers, and only ONE of them goes quiet: pruning must evict the silent
  // one and leave the live one alone.
  hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });
  const stale = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'stale' });

  assert.equal(hub.prune(), false, 'nothing is stale at t=0');

  advance(1001);
  hub.touch(hub.peersOf('b1').find((p) => p.name === 'A').id);
  assert.equal(hub.prune(), true, 'past the TTL, the silent peer is reaped');
  assert.equal(hub.get(stale.id), undefined);
  assert.deepEqual(
    hub.peersOf('b1').map((p) => p.name),
    ['A'],
    'a peer that still has traffic left is untouched',
  );
  assert.deepEqual(hub.stats(), { rooms: 1, peers: 1 });

  // And the eviction is not reversible: a second prune changes nothing.
  assert.equal(hub.prune(), false);
});

test('hub: pruning broadcasts the corrected presence', () => {
  const { hub, advance } = testHub({ peerTtlMs: 1000 });
  const watcher = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'watcher' });
  hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'ghost' });

  advance(1001);
  // The watcher keeps pinging; the ghost does not.
  hub.touch(watcher.id);
  assert.equal(hub.prune(), true);

  const presence = watcher.socket.ofType(WS_MSG.PRESENCE);
  assert.equal(presence.length, 1);
  assert.deepEqual(
    presence[0].peers.map((p) => p.name),
    ['watcher'],
    'the roster on the wire must already be the post-prune one',
  );
});

test('hub: touch keeps a peer alive, and reports a real tool change', () => {
  const { hub, advance } = testHub({ peerTtlMs: 1000 });
  const peer = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });

  advance(900);
  assert.equal(hub.touch(peer.id).toolChanged, false);
  advance(900);
  assert.equal(hub.prune(), false, 'the touch reset the clock');

  // An unchanged tool is not a change; a new one is.
  assert.equal(hub.touch(peer.id, { tool: peer.tool }).toolChanged, false);
  assert.equal(hub.touch(peer.id, { tool: 'pen' }).toolChanged, true);
  assert.equal(peer.tool, 'pen');
  // Junk is ignored rather than rendered.
  assert.equal(hub.touch(peer.id, { tool: 'not-a-tool' }).toolChanged, false);
  assert.equal(peer.tool, 'pen');
  assert.equal(hub.touch('ghost-id'), null, 'touching a gone peer is a no-op');
});

test('hub: a room with no peers left is forgotten', () => {
  const { hub } = testHub();
  const peer = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });
  assert.equal(hub.rooms.size, 1);

  hub.remove(peer);
  // A long-lived server must not accumulate one dead Set per board ever opened.
  assert.equal(hub.rooms.size, 0);
  assert.equal(hub.rooms.has('b1'), false);
  assert.deepEqual(hub.peersOf('b1'), []);
  assert.deepEqual(hub.stats(), { rooms: 0, peers: 0 });
});

test('hub: close is idempotent and survives being called twice', () => {
  const { hub } = testHub();
  const peer = hub.add({ socket: fakeSocket(), boardId: 'b1', name: 'A' });
  hub.add({ socket: fakeSocket(), boardId: 'b2', name: 'B' });

  assert.equal(hub.close(), 2, 'both sockets get a close frame');
  assert.equal(peer.socket.closed.length, 1);
  assert.deepEqual(hub.stats(), { rooms: 0, peers: 0 });

  // app.js closes the hub from its own onClose, and our plugin closes it from
  // another. Whichever order wins, neither may throw and neither may leave a
  // half-torn-down hub behind.
  assert.equal(hub.close(), 0, 'a second close is a no-op');
  assert.equal(hub.close(), 0);
  assert.equal(peer.socket.closed.length, 1, 'no duplicate close frames');
  assert.deepEqual(hub.peersOf('b1'), []);
});

test('hub: seat moves a peer between rooms keeping its id and colour', () => {
  const { hub } = testHub();
  const peer = hub.add({ socket: fakeSocket(), boardId: '_pending', name: null });

  const seated = hub.seat(peer, { boardId: 'b1', name: 'Ada' });

  assert.equal(seated.id, peer.id, 'the identity must survive the move');
  assert.equal(seated.color, peer.color);
  assert.equal(seated.name, 'Ada');
  assert.equal(seated.boardId, 'b1');
  assert.equal(hub.rooms.has('_pending'), false, 'the parking room does not linger');
  assert.deepEqual(hub.peersOf('b1').map((p) => p.id), [peer.id]);
  assert.equal(hub.seat({ id: 'gone' }, { boardId: 'b1' }), null);
});

/* ------------------------------------------------------- protocol, end to end */

/**
 * A real listening server, wired exactly the way `app.js` wires it: the store
 * and the hub are built by the caller and handed to the plugin, and the route
 * lands on the root scope under the API prefix.
 */
async function serve(t, { now } = {}) {
  const store = createMemoryStore();
  const board = await store.createBoard({ title: 'Test board' });
  const hub = new Hub({ peerTtlMs: 30_000, cursorRateMs: 33, now });
  const app = Fastify({ logger: false });

  app.decorate('store', store);
  app.decorate('hub', hub);
  await app.register(wsPlugin, { config: { apiPrefix: '/api' }, store, hub, now });
  await app.listen({ port: 0, host: '127.0.0.1' });
  t.after(async () => {
    await app.close();
    await store.close();
  });
  return { app, store, hub, board, url: `ws://127.0.0.1:${app.server.address().port}/api/ws` };
}

test('protocol: join returns ready with the snapshot and the roster', async (t) => {
  const { url, board } = await serve(t);
  const a = client(url);
  t.after(() => a.close());
  await a.open;

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  const ready = await a.waitFor(WS_MSG.READY);

  assert.equal(ready.peerId, ready.peers[0].id, 'the roster contains the joiner');
  assert.equal(ready.board.id, board.id);
  assert.equal(ready.board.title, 'Test board');
  assert.deepEqual(ready.elements, []);
  assert.equal(ready.rev, 0);
  assert.equal(ready.peers[0].name, 'Ada');
  assert.equal(ready.peers[0].color, colorForPeer(ready.peerId));
  assert.deepEqual(a.errors, []);
});

test('protocol: a second join bumps the roster for the first', async (t) => {
  const { url, board } = await serve(t);
  const a = client(url);
  const b = client(url);
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.open, b.open]);

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  const readyA = await a.waitFor(WS_MSG.READY);
  assert.equal(readyA.peers.length, 1);

  b.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Bob' } });
  const readyB = await b.waitFor(WS_MSG.READY);

  assert.equal(readyB.peers.length, 2, 'the joiner sees the whole room');
  const names = readyB.peers.map((p) => p.name).sort();
  assert.deepEqual(names, ['Ada', 'Bob']);

  // The two colours must be distinguishable, or nobody can tell the cursors apart.
  assert.notEqual(readyB.peers[0].color, readyB.peers[1].color);

  // A learns about B through presence, never through an echo of B's ready.
  const presence = await a.waitFor(WS_MSG.PRESENCE);
  assert.equal(a.ofType(WS_MSG.READY).length, 1);
  assert.deepEqual(presence.peers.map((p) => p.name).sort(), ['Ada', 'Bob']);
});

test('protocol: ops are acked to the sender and broadcast to the other, never echoed', async (t) => {
  const { url, board, store } = await serve(t);
  const a = client(url);
  const b = client(url);
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.open, b.open]);

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  await a.waitFor(WS_MSG.READY);
  b.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Bob' } });
  await b.waitFor(WS_MSG.READY);

  a.send({
    type: WS_MSG.OPS,
    boardId: board.id,
    ops: [
      {
        opId: 'op-1',
        boardId: board.id,
        kind: 'create',
        element: { id: 'e1', type: 'rect', x: 10, y: 20, w: 30, h: 40 },
      },
    ],
  });

  const ack = await a.waitFor(WS_MSG.OP_ACK);
  assert.equal(ack.result.status, 'applied');
  assert.equal(ack.result.rev, 1);

  // The heart of it: the sender is acked, and NOT sent its own op back.
  await b.waitFor(WS_MSG.OP_BROADCAST);
  assert.equal(
    a.ofType(WS_MSG.OP_BROADCAST).length,
    0,
    'an echo is what makes a naive client draw the element twice',
  );
  assert.equal(b.ofType(WS_MSG.OP_BROADCAST).length, 1);
  assert.equal(b.ofType(WS_MSG.OP_BROADCAST)[0].ops[0].opId, 'op-1');

  // And the op really landed.
  const snapshot = await store.getSnapshot(board.id);
  assert.equal(snapshot.elements.length, 1);
  assert.equal(snapshot.elements[0].id, 'e1');
});

test('protocol: a malformed op batch is acked with an error and changes nothing', async (t) => {
  const { url, board, store } = await serve(t);
  const a = client(url);
  t.after(() => a.close());
  await a.open;
  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  await a.waitFor(WS_MSG.READY);

  // `kind` is nonsense: validateOps must reject the WHOLE batch, atomically.
  a.send({
    type: WS_MSG.OPS,
    boardId: board.id,
    ops: [
      { opId: 'bad-1', boardId: board.id, kind: 'teleport', element: { id: 'x', type: 'rect', x: 0, y: 0, w: 1, h: 1 } },
    ],
  });

  const ack = await a.waitFor(WS_MSG.OP_ACK);
  assert.equal(ack.result.status, 'error');
  assert.match(ack.result.message, /kind/);
  assert.equal(a.ofType(WS_MSG.OP_BROADCAST).length, 0, 'nothing is fanned out');

  const snapshot = await store.getSnapshot(board.id);
  assert.deepEqual(snapshot.elements, [], 'the board is untouched');
  assert.equal(snapshot.rev, 0, 'and the rev did not move');
});

test('protocol: joining an unknown board is rejected and the socket closes', async (t) => {
  const { url } = await serve(t);
  const a = client(url);
  t.after(() => a.close());
  await a.open;

  a.send({ type: WS_MSG.JOIN, boardId: 'does-not-exist', peer: { name: 'Ada' } });
  const err = await a.waitFor('error');

  assert.match(err.text, /not found/i);
  assert.equal(err.code, 'BOARD_NOT_FOUND');

  await new Promise((resolve) => {
    a.ws.once('close', resolve);
    setTimeout(resolve, 500);
  });
  assert.equal(a.ws.readyState, WebSocket.CLOSED);
});

test('protocol: ops before join are refused, and junk never kills the connection', async (t) => {
  const { url, board } = await serve(t);
  const a = client(url);
  t.after(() => a.close());
  await a.open;

  a.send({ type: WS_MSG.OPS, boardId: board.id, ops: [] });
  await a.waitFor('error');

  // Garbage, an unknown type, and a cursor full of NaN must all be survivable:
  // a bad message logs, it does not take the process (or the peer) down.
  a.ws.send('not json at all');
  a.send({ type: 'who-knows' });
  a.send({ type: WS_MSG.CURSOR, cursor: { x: NaN, y: 0 } });

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  const ready = await a.waitFor(WS_MSG.READY);
  assert.equal(ready.board.id, board.id, 'the connection is still healthy');
  assert.deepEqual(a.errors, []);
});

test('protocol: shutdown is safe with a hub that is not ours', async (t) => {
  // The contract is "the hub has close()", not "reach into hub.peers". A stub
  // with nothing but peersOf/broadcast/touch/remove must not turn `app.close()`
  // into a TypeError that cancels the whole test file.
  const store = createMemoryStore();
  const board = await store.createBoard({ title: 'Stub board' });
  const stub = {
    peersOf: () => [],
    broadcast: () => 0,
    touch: () => null,
    remove: () => false,
    prune: () => false,
    stats: () => ({ rooms: 0, peers: 0 }),
  };
  const app = Fastify({ logger: false });
  app.decorate('store', store);
  await app.register(wsPlugin, { config: { apiPrefix: '/api' }, store, hub: stub });
  await app.listen({ port: 0, host: '127.0.0.1' });

  const c = client(`ws://127.0.0.1:${app.server.address().port}/api/ws`);
  await c.open;
  c.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  await new Promise((r) => setTimeout(r, 30));

  await app.close(); // must not throw
  await store.close();
  c.close();
});

test('protocol: closing a socket removes the peer and tells the room', async (t) => {
  const { url, board, hub } = await serve(t);
  const a = client(url);
  const b = client(url);
  t.after(() => {
    a.close();
    b.close();
  });
  await Promise.all([a.open, b.open]);

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  await a.waitFor(WS_MSG.READY);
  b.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Bob' } });
  const readyB = await b.waitFor(WS_MSG.READY);
  assert.equal(readyB.peers.length, 2);

  a.close();
  // Poll the hub rather than sleeping: the close is async, the assertion is not.
  const deadline = Date.now() + 2000;
  while (hub.peersOf(board.id).length === 2) {
    if (Date.now() > deadline) throw new Error('the peer was never removed');
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.deepEqual(hub.peersOf(board.id).map((p) => p.name), ['Bob']);
});

test('protocol: the sweeper reaps a peer that stops pinging', async (t) => {
  let t0 = 1_000_000;
  const { url, board, hub } = await serve(t, { now: () => t0 });
  const a = client(url);
  t.after(() => a.close());
  await a.open;

  a.send({ type: WS_MSG.JOIN, boardId: board.id, peer: { name: 'Ada' } });
  await a.waitFor(WS_MSG.READY);
  assert.equal(hub.peersOf(board.id).length, 1);

  // A ping inside the window keeps the peer; past it, the sweeper takes it.
  t0 += 20_000;
  a.send({ type: WS_MSG.PING });
  assert.equal(hub.prune(), false);
  t0 += 40_000;
  assert.equal(hub.prune(), true);
  assert.deepEqual(hub.peersOf(board.id), []);
});
