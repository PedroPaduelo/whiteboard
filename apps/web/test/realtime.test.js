/**
 * The realtime protocol end to end, in node.
 *
 * Every piece here is the REAL code except the wire: the web `RealtimeClient`,
 * `StoreSync` and `attachRealtime` bridge drive a real board store, and the
 * "server" is a fake WebSocket in front of the API's real memory store
 * (`apps/api/src/store/memory.js`) with `validateOps` from @whiteboard/shared —
 * the same two calls `apps/api/src/ws/plugin.js` makes, with the same ack,
 * broadcast and resync rules. Two clients get two independent store instances
 * (the store module is imported twice under different URLs).
 *
 * What is pinned: the outbox drains; nothing is re-sent in a loop (frames are
 * counted); an error ack is dropped, not retried; concurrent edits by two
 * people converge on the server and on both screens; a reconnect or resync
 * restores the server's state while keeping unacknowledged local edits;
 * cursors carry the peer's name and colour; presence shows the tool;
 * each person's selection reaches the others (`peerSelections`).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore as createServerStore } from '../../api/src/store/memory.js';
import { validateOps, colorForPeer } from '@whiteboard/shared';

import {
  RealtimeClient,
  MAX_BATCH_BYTES,
  KEEPALIVE_BYTES,
  MAX_SELECTION_IDS,
  normalizeSelectionIds,
  utf8Length,
} from '../src/realtime/realtime.js';
import { resolveWsUrl } from '../src/api/client.js';
import { updateBoardMutation, boardPatchOf } from '../src/api/queries.js';
import { StoreSync, withRemote } from '../src/realtime/sync.js';
import { attachRealtime } from '../src/realtime/bridge.js';
import { useBoardStore as storeA } from '../src/store/boardStore.js';

// A second, independent store instance: a second browser tab.
const { useBoardStore: storeB } = await import('../src/store/boardStore.js?peer=b');
// And a third, for someone who joins later.
const { useBoardStore: storeC } = await import('../src/store/boardStore.js?peer=c');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ========================================================================
   Fake server: plugin.js semantics over the real memory store
   ======================================================================== */

class FakeServer {
  constructor({ latency = 2, maxPayload = 8 * 1024 * 1024 } = {}) {
    this.store = createServerStore();
    this.latency = latency;
    /** ws maxPayload: a bigger frame closes the socket with 1009 and no ack, like `ws` does. */
    this.maxPayload = maxPayload;
    /** Optional async hook run after a snapshot is read and before it is returned. */
    this.onSnapshot = null;
    this.sockets = new Set();
    /** Every frame a client sent: {sock, msg}. */
    this.frames = [];
    this.seq = 0;
    /** When set, `ops` frames are parked here instead of processed. */
    this.held = null;
    /** Optional per-test interception of an ops frame: return true to swallow it. */
    this.interceptOps = null;
    this.busy = 0;
  }

  socketClass() {
    const server = this;
    return class FakeSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      constructor(url) {
        this.url = url;
        this.readyState = 0;
        this.peer = null;
        server.sockets.add(this);
        setTimeout(() => {
          if (this.readyState !== 0) return;
          this.readyState = 1;
          this.onopen?.();
        }, server.latency);
      }
      send(raw) {
        if (this.readyState !== 1) throw new Error('socket not open');
        const size = Buffer.byteLength(raw);
        if (size > server.maxPayload) {
          server.frames.push({ sock: this, msg: { type: 'oversized' }, size });
          this.drop(1009, 'Max payload size exceeded');
          return;
        }
        const msg = JSON.parse(raw);
        server.frames.push({ sock: this, msg, size });
        server.busy += 1;
        setTimeout(() => {
          server.receive(this, msg).finally(() => (server.busy -= 1));
        }, server.latency);
      }
      /** Client-initiated close. */
      close() {
        if (this.readyState === 3) return;
        this.readyState = 3;
        server.leave(this);
        setTimeout(() => this.onclose?.({ code: 1000, reason: '' }), 0);
      }
      /** Server -> client frame, after the network latency. */
      deliver(msg) {
        if (this.readyState !== 1 || this.muted) return;
        const data = JSON.stringify(msg);
        setTimeout(() => {
          if (this.readyState === 1) this.onmessage?.({ data });
        }, server.latency);
      }
      /** The network dies under this socket (or the server closes it with `code`). */
      drop(code = 1006, reason = 'network') {
        if (this.readyState === 3) return;
        this.readyState = 3;
        server.leave(this);
        setTimeout(() => this.onclose?.({ code, reason }), 0);
      }
    };
  }

  room(boardId, except = null) {
    return [...this.sockets].filter((s) => s.peer && s.peer.boardId === boardId && s !== except && s.readyState === 1);
  }

  peersOf(boardId) {
    return this.room(boardId).map((s) => ({
      id: s.peer.id,
      name: s.peer.name,
      color: s.peer.color,
      tool: s.peer.tool,
      selection: s.peer.selection,
    }));
  }

  broadcast(boardId, msg, except = null) {
    for (const s of this.room(boardId, except)) s.deliver(msg);
  }

  leave(sock) {
    this.sockets.delete(sock);
    if (sock.peer) this.broadcast(sock.peer.boardId, { type: 'presence', boardId: sock.peer.boardId, peers: this.peersOf(sock.peer.boardId) });
  }

  async receive(sock, msg) {
    if (sock.readyState !== 1) return;
    switch (msg.type) {
      case 'join': {
        const snap = await this.store.getSnapshot(msg.boardId);
        if (!snap) {
          sock.deliver({ type: 'error', text: 'board not found', code: 'BOARD_NOT_FOUND', boardId: msg.boardId });
          setTimeout(() => sock.drop(), this.latency * 2);
          return;
        }
        const id = `peer-${++this.seq}`;
        sock.peer = { id, boardId: msg.boardId, name: msg.peer?.name ?? 'Anônimo', color: colorForPeer(id), tool: 'select', selection: [] };
        sock.deliver({ type: 'ready', peerId: id, board: snap.board, elements: snap.elements, rev: snap.rev, peers: this.peersOf(msg.boardId) });
        this.broadcast(msg.boardId, { type: 'presence', boardId: msg.boardId, peers: this.peersOf(msg.boardId) }, sock);
        return;
      }
      case 'ops': {
        if (!sock.peer) {
          sock.deliver({ type: 'error', text: 'join before sending ops' });
          return;
        }
        if (this.held) {
          this.held.push({ sock, msg });
          return;
        }
        if (this.interceptOps && (await this.interceptOps(sock, msg))) return;
        await this.processOps(sock, msg);
        return;
      }
      case 'cursor': {
        if (!sock.peer) return;
        this.broadcast(
          sock.peer.boardId,
          { type: 'peer-cursor', boardId: sock.peer.boardId, peerId: sock.peer.id, cursor: msg.cursor, name: sock.peer.name, color: sock.peer.color },
          sock,
        );
        return;
      }
      case 'selection': {
        // The relay this client expects: the peer's selection is recorded
        // (so the roster carries it to late joiners) and, when it changed,
        // fanned out to the others as `peer-selection`. Never persisted.
        if (!sock.peer || !Array.isArray(msg.ids)) return;
        const ids = [...new Set(msg.ids.filter((id) => typeof id === 'string' && id))];
        if (ids.join('\n') === sock.peer.selection.join('\n')) return;
        sock.peer.selection = ids;
        this.broadcast(
          sock.peer.boardId,
          { type: 'peer-selection', boardId: sock.peer.boardId, peerId: sock.peer.id, ids, name: sock.peer.name, color: sock.peer.color },
          sock,
        );
        return;
      }
      case 'activity': {
        if (!sock.peer || sock.peer.tool === msg.text) return;
        sock.peer.tool = msg.text;
        this.broadcast(sock.peer.boardId, { type: 'presence', boardId: sock.peer.boardId, peers: this.peersOf(sock.peer.boardId) });
        return;
      }
      default:
        return;
    }
  }

  /** plugin.js onOps: validate, apply (try/catch), ack WITHOUT elements, broadcast or resync the sender. */
  async processOps(sock, msg, { ack = true } = {}) {
    const boardId = sock.peer.boardId;
    let ops;
    try {
      ops = validateOps(msg.ops);
    } catch (err) {
      if (ack) sock.deliver({ type: 'ack', result: { status: 'error', message: err.message, code: 'VALIDATION_FAILED', applied: [] } });
      return null;
    }
    let result;
    try {
      result = await this.store.applyOps(boardId, ops, sock.peer.id);
    } catch (err) {
      if (ack) sock.deliver({ type: 'ack', result: { status: 'error', message: err.message, code: err.code ?? 'INTERNAL', applied: [] } });
      return null;
    }
    const { elements: _omit, ...ackResult } = result;
    if (ack) sock.deliver({ type: 'ack', result: ackResult });
    if (result.status === 'applied' || result.status === 'duplicate') {
      if (result.appliedOps?.length) {
        this.broadcast(boardId, { type: 'op', boardId, peerId: sock.peer.id, ops: result.appliedOps, rev: result.rev }, sock);
      }
    } else {
      sock.deliver({ type: 'resync', boardId, rev: result.rev ?? 0 });
    }
    return result;
  }

  async release() {
    const held = this.held ?? [];
    this.held = null;
    for (const { sock, msg } of held) {
      if (sock.readyState === 1) await this.processOps(sock, msg);
    }
  }

  /** REST: GET /boards/:id/snapshot. */
  async snapshot(boardId) {
    await sleep(this.latency);
    const snap = await this.store.getSnapshot(boardId);
    if (!snap) {
      const err = new Error('not found');
      err.status = 404;
      throw err;
    }
    if (this.onSnapshot) await this.onSnapshot(boardId, snap);
    return snap;
  }

  /** REST: POST /boards/:id/ops (broadcast to everyone, like routes/ops.js). */
  async postOps(boardId, rawOps) {
    await sleep(this.latency);
    const ops = validateOps(rawOps);
    const result = await this.store.applyOps(boardId, ops, 'http');
    if (result.status === 'applied') this.broadcast(boardId, { type: 'op', ops: result.appliedOps, rev: result.rev });
    return result;
  }

  opsFrames(client) {
    return this.frames.filter((f) => f.msg.type === 'ops' && (!client || f.sock === client.ws || f.sock.__client === client));
  }

  async elements(boardId) {
    return (await this.store.getSnapshot(boardId)).elements;
  }
}

/* ========================================================================
   Client harness: RealtimeClient + StoreSync + bridge over one store
   ======================================================================== */

function makeClient(server, store, { boardId, name, stash = null, postOps = null }) {
  const errors = [];
  const client = new RealtimeClient({
    WebSocket: server.socketClass(),
    url: 'ws://test.local/api/ws',
    postOps: postOps ?? ((b, ops) => server.postOps(b, ops)),
    stash,
    ackTimeoutMs: 3000,
    heartbeatMs: 60_000,
    backoffBaseMs: 5,
    backoffMaxMs: 20,
  });
  // Tag every frame with the client that sent it, across reconnects.
  const origOpen = client._open.bind(client);
  client._open = () => {
    origOpen();
    if (client.ws) client.ws.__client = client;
  };
  const sync = new StoreSync(client, store);
  const detach = attachRealtime({
    client,
    sync,
    store,
    fetchSnapshot: (id) => server.snapshot(id),
    onError: (message, info) => errors.push({ message, ...info }),
    pruneCursors: false,
  });
  client.connect(boardId, { name });
  const S = () => store.getState();
  return {
    client,
    sync,
    store,
    errors,
    S,
    close() {
      detach();
      client.disconnect();
    },
    /** Ops frames this client sent (any socket). */
    frames: () => server.frames.filter((f) => f.msg.type === 'ops' && f.sock.__client === client),
    idle: () => !client.inflight && client.outbox.length === 0 && sync.pendingOps().length === 0,
  };
}

/** Clients created by the current test; closed after it even when it fails. */
const live = [];
function track(c) {
  live.push(c);
  return c;
}
test.afterEach(() => {
  while (live.length) live.pop().close();
});

async function until(pred, { timeout = 3000, step = 5, what = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - t0 > timeout) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

/** Wait until every client is connected, drained and the server is quiet. */
async function settle(server, clients, extra = 30) {
  await until(
    () => server.busy === 0 && clients.every((c) => c.client.status === 'connected' && c.idle()),
    { what: 'everyone idle' },
  );
  await sleep(extra); // trailing broadcasts / resync fetches
  await until(() => server.busy === 0 && clients.every((c) => c.idle()), { what: 'quiet again' });
}

const rect = (id, x = 0, y = 0, extra = {}) => ({ id, type: 'rect', x, y, w: 100, h: 60, stroke: '#1e1e1e', fill: 'none', ...extra });

/** Local user edit: commit + mutation, exactly like the canvas does. */
function edit(c, label, fn) {
  c.S().commit(label);
  fn(c.S());
}

/** The comparable essence of a board: id, x, y, fill, in order. */
const essence = (els) => els.map((e) => `${e.id}:${e.x},${e.y},${e.fill ?? ''}`);

async function freshBoard(server, id, elements = []) {
  await server.store.createBoard({ id, title: 'Quadro de teste' });
  if (elements.length) {
    await server.store.applyOps(id, elements.map((el, i) => ({ opId: `seed-${id}-${i}`, kind: 'create', element: el })), 'seed');
  }
}

function resetStores() {
  storeA.getState().reset();
  storeB.getState().reset();
  storeC.getState().reset();
}

test.beforeEach(() => resetStores());

/* ========================================================================
   Tests
   ======================================================================== */

test('an edit is sent once, acked, and the outbox drains (no resend loop)', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected', { what: 'connected' });
  assert.equal(a.S().connection, 'connected', 'status is pushed into the store');

  edit(a, 'add', (s) => s.addElement(rect('r1', 10, 10)));
  await settle(server, [a], 120);

  assert.equal(a.frames().length, 1, 'exactly one ops frame for one edit');
  assert.equal(a.client.outbox.length, 0);
  assert.equal(a.client.inflight, null);
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['r1']);
  assert.ok(a.S().rev >= 1, 'the ack rev reached the store');
  assert.ok(!a.frames()[0].msg.ops.some((op) => 'baseRev' in op), 'WS ops carry no baseRev');
  a.close();
});

test('a live drag: one batch in flight, no opId ever sent twice, final position lands', async () => {
  const server = new FakeServer({ latency: 15 }); // RTT 30ms > the 50ms? no: > frame interval
  await freshBoard(server, 'b1', [rect('r1')]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  a.S().commit('move:1');
  let maxInflight = 0;
  for (let i = 1; i <= 60; i++) {
    a.S().updateElements([{ id: 'r1', patch: { x: i * 3, y: i } }]);
    maxInflight = Math.max(maxInflight, a.client.inflight ? 1 : 0);
    await sleep(4);
  }
  await settle(server, [a], 120);

  const frames = a.frames();
  const opIds = frames.flatMap((f) => f.msg.ops.map((op) => op.opId));
  assert.equal(new Set(opIds).size, opIds.length, 'no op was ever re-sent');
  assert.ok(frames.length <= 12, `a 240ms drag is a handful of batches, got ${frames.length}`);
  const r1 = (await server.elements('b1'))[0];
  assert.equal(r1.x, 180);
  assert.equal(r1.y, 60);
  assert.equal(a.errors.length, 0, JSON.stringify(a.errors));
  a.close();
});

test('an error ack is dropped, reported, rolled back by a resync — and never retried', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('keep')]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  // An element the server's validator rejects (bad strokeStyle).
  edit(a, 'add', (s) => s.addElement(rect('bad', 0, 0, { strokeStyle: 'wavy' })));
  await until(() => a.errors.length > 0, { what: 'the error report' });
  await settle(server, [a], 80);

  assert.equal(a.frames().length, 1, 'the invalid batch was sent once, not in a loop');
  assert.equal(a.errors[0].kind, 'ops');
  assert.deepEqual(a.S().elements.map((e) => e.id), ['keep'], 'the resync removed the rejected element locally');

  // A store-level failure (duplicate element id) is an error ack too.
  a.client.sendOps([a.client.makeOp('create', { element: rect('keep') })]);
  await settle(server, [a], 80);
  assert.equal(a.frames().length, 2);

  // And the queue still works afterwards.
  edit(a, 'add2', (s) => s.addElement(rect('good', 5, 5)));
  await settle(server, [a], 80);
  assert.equal(a.frames().length, 3);
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['keep', 'good']);
  a.close();
});

test('two people editing different elements at the same time: both persist, both screens agree', async () => {
  const server = new FakeServer({ latency: 6 });
  await freshBoard(server, 'b1', [rect('ra', 0, 0), rect('rb', 300, 0)]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  a.S().commit('move:a');
  b.S().commit('move:b');
  for (let i = 1; i <= 40; i++) {
    a.S().updateElements([{ id: 'ra', patch: { x: i * 2 } }]);
    b.S().updateElements([{ id: 'rb', patch: { y: i * 3 } }]);
    await sleep(3);
  }
  // …and both create something in the same instant.
  edit(a, 'add', (s) => s.addElement(rect('newA', 0, 500)));
  edit(b, 'add', (s) => s.addElement(rect('newB', 300, 500)));
  await settle(server, [a, b], 120);

  const truth = await server.elements('b1');
  const byId = new Map(truth.map((e) => [e.id, e]));
  assert.equal(byId.get('ra').x, 80);
  assert.equal(byId.get('rb').y, 120);
  assert.ok(byId.has('newA') && byId.has('newB'));
  assert.deepEqual(essence(a.S().elements), essence(truth), "A's screen matches the server");
  assert.deepEqual(essence(b.S().elements), essence(truth), "B's screen matches the server");
  a.close();
  b.close();
});

test('the SAME field edited by both at once converges everywhere (server order wins)', async () => {
  const server = new FakeServer({ latency: 10 });
  await freshBoard(server, 'b1', [rect('r', 0, 0)]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  for (let i = 0; i < 15; i++) {
    edit(a, `a${i}`, (s) => s.updateElement('r', { x: 1000 + i, fill: '#ffc9c9' }));
    edit(b, `b${i}`, (s) => s.updateElement('r', { x: 2000 + i }));
    await sleep(7);
  }
  await settle(server, [a, b], 150);

  const truth = await server.elements('b1');
  assert.deepEqual(essence(a.S().elements), essence(truth));
  assert.deepEqual(essence(b.S().elements), essence(truth));
  assert.equal(truth[0].fill, '#ffc9c9', "A's field that B never touched is kept");
  a.close();
  b.close();
});

test('offline edits survive a dropped socket; the reconnect restores the board and keeps them', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('r1', 0, 0)]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  // A's network dies, and A reconnects slowly.
  a.client.options.backoffBaseMs = 80;
  a.client.options.backoffMaxMs = 80;
  a.client.ws.drop();
  await until(() => a.S().connection === 'offline', { what: 'offline status' });

  // A keeps drawing offline…
  edit(a, 'add', (s) => s.addElement(rect('offline', 0, 200)));
  edit(a, 'move:x', (s) => s.updateElement('r1', { x: 42 }));
  // …while B works on the live board.
  edit(b, 'add', (s) => s.addElement(rect('fromB', 400, 0)));
  edit(b, 'style', (s) => s.updateElement('r1', { fill: '#a5d8ff' }));
  await sleep(20);
  assert.deepEqual(a.S().elements.map((e) => e.id), ['r1', 'offline'], 'A sees its offline work');

  await until(() => a.client.status === 'connected', { what: 'reconnect' });
  // Right after `ready`: B's work is in, and A's pending edits are still visible.
  const ids = a.S().elements.map((e) => e.id);
  assert.ok(ids.includes('fromB') && ids.includes('offline'), `after ready: ${ids}`);
  assert.equal(a.S().elements.find((e) => e.id === 'r1').x, 42);

  await settle(server, [a, b], 120);
  const truth = await server.elements('b1');
  assert.deepEqual(truth.map((e) => e.id).sort(), ['fromB', 'offline', 'r1']);
  const r1 = truth.find((e) => e.id === 'r1');
  assert.equal(r1.x, 42, "A's offline move landed");
  assert.equal(r1.fill, '#a5d8ff', "B's colour survived it");
  assert.deepEqual(essence(a.S().elements), essence(truth));
  assert.deepEqual(essence(b.S().elements), essence(truth));
  assert.equal(a.S().canUndo, true, 'the reconnect did not wipe the undo history');
  a.close();
  b.close();
});

test('a server resync fetches the snapshot and keeps edits that are still in flight', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('r1')]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  // Someone else changes the board over HTTP while A is not listening for it.
  await server.store.applyOps('b1', [{ opId: 'x1', kind: 'create', element: rect('missed', 0, 300) }], 'other');

  // A's next batch is held by the server (no ack yet)…
  server.held = [];
  edit(a, 'add', (s) => s.addElement(rect('pending', 500, 0)));
  await until(() => a.client.inflight !== null, { what: 'batch in flight' });

  // …when the server tells A to resync.
  const sock = [...server.sockets].find((s) => s.__client === a.client);
  sock.deliver({ type: 'resync', boardId: 'b1', rev: 99 });
  await until(() => a.S().elements.some((e) => e.id === 'missed'), { what: 'the missed element' });
  assert.ok(a.S().elements.some((e) => e.id === 'pending'), 'the unacked edit is still on screen');

  await server.release();
  await settle(server, [a], 80);
  const truth = await server.elements('b1');
  assert.deepEqual(truth.map((e) => e.id).sort(), ['missed', 'pending', 'r1']);
  assert.deepEqual(essence(a.S().elements), essence(truth));
  a.close();
});

test('a batch applied but never acked is re-sent after the reconnect, deduped, and converges', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('r1')]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  // The server applies A's batch but A's downlink is dead: no ack, no
  // broadcasts. B then writes the same field. Then A's socket drops.
  let sockA = null;
  server.interceptOps = async (sock, msg) => {
    if (sockA || sock.__client !== a.client) return false;
    sockA = sock;
    sock.muted = true;
    await server.processOps(sock, msg);
    return true;
  };
  edit(a, 'move', (s) => s.updateElement('r1', { x: 5 }));
  await until(() => sockA !== null, { what: 'the intercepted batch' });
  edit(b, 'move', (s) => s.updateElement('r1', { x: 777 }));
  await until(async () => (await server.elements('b1'))[0].x === 777, { what: "B's write on the server" });
  sockA.drop();

  await until(() => a.client.status === 'connected', { what: 'reconnect' });
  await settle(server, [a, b], 120);

  const opFrames = a.frames().flatMap((f) => f.msg.ops.map((o) => o.opId));
  assert.equal(opFrames.length, 2, 'the unacked batch was re-sent exactly once');
  assert.equal(opFrames[0], opFrames[1], 'with the same opId (the server dedupes it)');
  const truth = await server.elements('b1');
  assert.equal(truth[0].x, 777, "B's later write stands on the server");
  assert.equal(b.S().elements[0].x, 777);
  assert.equal(a.S().elements[0].x, 777, 'and on A, after the replay resync');
});

test('cursors carry the peer name and colour; presence shows the nickname and the tool', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  a.client.sendCursor({ x: 12.5, y: -40 });
  await until(() => b.S().remoteCursors.size === 1, { what: 'the cursor' });
  const [peerId, cur] = [...b.S().remoteCursors][0];
  assert.equal(peerId, a.client.peerId);
  assert.equal(cur.x, 12.5);
  assert.equal(cur.y, -40);
  assert.equal(cur.name, 'Ana');
  assert.equal(cur.color, colorForPeer(a.client.peerId));
  assert.equal(a.S().remoteCursors.size, 0, 'our own cursor is never stored');

  // Throttled: a burst of moves is a few frames, and the LAST position lands.
  for (let i = 0; i < 30; i++) a.client.sendCursor({ x: i, y: i });
  await sleep(80);
  const cursorFrames = server.frames.filter((f) => f.msg.type === 'cursor' && f.sock.__client === a.client);
  assert.ok(cursorFrames.length <= 4, `throttled to ~33ms, got ${cursorFrames.length}`);
  await until(() => b.S().remoteCursors.get(a.client.peerId)?.x === 29, { what: 'the trailing cursor' });

  // The roster shows the nickname, and the tool follows setTool.
  const roster = () => b.S().peers.find((p) => p.id === a.client.peerId);
  await until(() => roster()?.name === 'Ana', { what: 'roster name' });
  a.S().setTool('rect');
  await until(() => roster()?.tool === 'rect', { what: 'activity -> presence tool' });

  // A peer that leaves takes its cursor with it.
  a.close();
  await until(() => b.S().remoteCursors.size === 0, { what: 'cursor dropped with the peer' });
  b.close();
});

test("collaborators' selections: sent throttled, drawn in the peer's colour, seen by late joiners, gone with the peer", async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('r1'), rect('r2', 200), rect('r3', 400)]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await settle(server, [a, b]);
  const selectionFrames = () => server.frames.filter((f) => f.msg.type === 'selection' && f.sock.__client === a.client);
  assert.equal(selectionFrames().length, 0, 'nothing selected, nothing announced');

  // A selects a shape: B holds it under A's peer id, in A's colour.
  a.S().select(['r1']);
  const seen = () => b.S().peerSelections.get(a.client.peerId);
  await until(() => seen()?.ids.join() === 'r1', { what: "A's selection on B" });
  assert.equal(seen().color, colorForPeer(a.client.peerId));
  assert.equal(seen().name, 'Ana');
  assert.equal(a.S().peerSelections.size, 0, 'our own selection is never stored as a peer one');

  // A marquee drag: a burst of changes is a few frames, and the LAST one lands.
  const before = selectionFrames().length;
  for (let i = 0; i < 20; i++) a.S().select(i % 2 ? ['r1', 'r2'] : ['r1']);
  a.S().select(['r1', 'r2', 'r3']);
  await until(() => seen()?.ids.join() === 'r1,r2,r3', { what: 'the trailing selection' });
  assert.ok(selectionFrames().length - before <= 3, `throttled, got ${selectionFrames().length - before}`);

  // The same selection again is not sent again.
  const settled = selectionFrames().length;
  a.S().select(['r1', 'r2', 'r3']);
  await sleep(80);
  assert.equal(selectionFrames().length, settled);

  // Editing a text counts as working on it.
  a.S().clearSelection();
  a.S().setEditing('r2');
  await until(() => seen()?.ids.join() === 'r2', { what: 'the edited element' });
  a.S().setEditing(null);
  a.S().select(['r3']);
  await until(() => seen()?.ids.join() === 'r3', { what: 'back to a selection' });

  // Someone joining later sees it at once (the roster in `ready` carries it).
  const c = track(makeClient(server, storeC, { boardId: 'b1', name: 'Carla' }));
  await until(() => c.client.status === 'connected' && c.S().peerSelections.get(a.client.peerId)?.ids.join() === 'r3', {
    what: "A's selection on the late joiner",
  });

  // A reconnects (a new peer to the server): the selection is announced again,
  // and the old peer id's outline goes with the old roster entry.
  const oldId = a.client.peerId;
  a.client.reconnect();
  await until(() => a.client.status === 'connected' && a.client.peerId !== oldId, { what: 'the reconnect' });
  await until(() => seen()?.ids.join() === 'r3' && !b.S().peerSelections.has(oldId), { what: 're-announced after the re-join' });

  // Nothing selected any more: the outline goes away.
  a.S().clearSelection();
  await until(() => !b.S().peerSelections.has(a.client.peerId), { what: 'the cleared selection' });

  // A peer that leaves takes its selection with it.
  a.S().select(['r1']);
  await until(() => seen()?.ids.join() === 'r1', { what: 'selected again' });
  a.close();
  await until(() => b.S().peerSelections.size === 0 && c.S().peerSelections.size === 0, { what: 'selection dropped with the peer' });
  b.close();
  c.close();
});

test('normalizeSelectionIds: unique non-empty string ids, capped; anything else is []', () => {
  assert.deepEqual(normalizeSelectionIds(new Set(['a', 'b'])), ['a', 'b']);
  assert.deepEqual(normalizeSelectionIds(['a', 'a', '', 3, null, 'x'.repeat(41), 'b']), ['a', 'b']);
  assert.deepEqual(normalizeSelectionIds('abc'), [], 'a string is not a list of ids');
  assert.deepEqual(normalizeSelectionIds(null), []);
  assert.deepEqual(normalizeSelectionIds({ ids: ['a'] }), []);
  const many = Array.from({ length: MAX_SELECTION_IDS + 10 }, (_, i) => `e${i}`);
  assert.equal(normalizeSelectionIds(many).length, MAX_SELECTION_IDS);
});

test('a {type:"board"} message updates the store board (rename by someone else)', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');
  assert.equal(a.S().board.title, 'Quadro de teste');
  const sock = [...server.sockets].find((s) => s.__client === a.client);
  sock.deliver({ type: 'board', board: { id: 'b1', title: 'Novo nome' } });
  await until(() => a.S().board.title === 'Novo nome', { what: 'the rename' });
  sock.deliver({ type: 'board', board: { id: 'other', title: 'Nope' } });
  await sleep(20);
  assert.equal(a.S().board.title, 'Novo nome', 'metadata of another board is ignored');
  a.close();
});

test('switching boards: queued ops go to the OLD board over HTTP, never to the new one', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  await freshBoard(server, 'b2');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  server.held = []; // the socket swallows the batch: it stays unacked
  edit(a, 'add', (s) => s.addElement(rect('for-b1')));
  await until(() => a.client.inflight !== null);

  a.client.connect('b2');
  assert.equal(a.client.outbox.length, 0, 'the outbox is cleared on a board switch');
  assert.equal(a.client.inflight, null, 'and so is the in-flight batch');
  server.held = null; // (the held frame belonged to the old socket; drop it)
  await until(() => a.client.status === 'connected');
  await sleep(40);

  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['for-b1'], 'salvaged to b1 over HTTP');
  assert.deepEqual(await server.elements('b2'), [], 'nothing leaked into b2');
  assert.equal(a.S().boardId, 'b2');
  assert.deepEqual(a.S().elements, [], 'the new board is shown');
  a.close();
});

test('a board that does not exist stops retrying and says disconnected', async () => {
  const server = new FakeServer();
  const a = track(makeClient(server, storeA, { boardId: 'ghost', name: 'Ana' }));
  await until(() => a.client.status === 'disconnected', { what: 'disconnected' });
  const joins = server.frames.filter((f) => f.msg.type === 'join').length;
  await sleep(80);
  assert.equal(server.frames.filter((f) => f.msg.type === 'join').length, joins, 'no retry storm');
  assert.equal(a.S().connection, 'disconnected');
  assert.ok(a.errors.some((e) => e.code === 'BOARD_NOT_FOUND'));
  a.close();
});

test('undo while a collaborator works ships only my changes', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  edit(a, 'add', (s) => s.addElement(rect('mine')));
  await settle(server, [a, b], 60);
  edit(b, 'add', (s) => s.addElement(rect('theirs', 300)));
  await settle(server, [a, b], 60);

  a.S().undo();
  await settle(server, [a, b], 80);
  const truth = await server.elements('b1');
  assert.deepEqual(truth.map((e) => e.id), ['theirs'], "B's element survived A's undo");
  assert.deepEqual(essence(b.S().elements), essence(truth));

  a.S().redo();
  await settle(server, [a, b], 80);
  const after = await server.elements('b1');
  assert.deepEqual(after.map((e) => e.id), ['mine', 'theirs'], 'redo restores mine in its old z-position');
  assert.deepEqual(essence(a.S().elements), essence(after));
  assert.deepEqual(essence(b.S().elements), essence(after));
  a.close();
  b.close();
});

test('unbinding a connector end (null patch) reaches the server and the peer', async () => {
  const server = new FakeServer();
  const arrow = {
    id: 'ar',
    type: 'arrow',
    x: 100,
    y: 30,
    w: 200,
    h: 0,
    points: [{ x: 100, y: 30 }, { x: 300, y: 30 }],
    stroke: '#1e1e1e',
    startId: 'r1',
    endId: 'r2',
  };
  await freshBoard(server, 'b1', [rect('r1', 0, 0), rect('r2', 300, 0), arrow]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  edit(a, 'unbind', (s) => s.updateElement('ar', { startId: null, points: [{ x: 50, y: 200 }, s.elements[2].points[1]] }));
  await settle(server, [a, b], 80);

  const sent = a.frames().at(-1).msg.ops[0];
  assert.equal(sent.patch.startId, null, 'the wire carries startId: null');
  const onServer = (await server.elements('b1')).find((e) => e.id === 'ar');
  assert.ok(!('startId' in onServer), 'the server removed the binding');
  assert.equal(onServer.endId, 'r2');
  assert.ok(!('startId' in b.S().elements.find((e) => e.id === 'ar')), 'and so did the peer');
  a.close();
  b.close();
});

test('the store sees withRemote hydration as remote (sanity for the shared guard)', () => {
  // Both store instances share sync.js's withRemote counter; a hydration on
  // one must not be shipped by the other's StoreSync.
  const shipped = [];
  const sync = new StoreSync({ makeOp: (kind, f) => ({ opId: String(shipped.length), kind, ...f }), sendOps: (ops) => shipped.push(...ops) }, storeB);
  sync.start();
  withRemote(() => storeB.getState().applyRemoteOps([{ kind: 'create', element: rect('x') }]));
  sync.stop();
  assert.equal(shipped.length, 0);
});

/* ------------------------------------------------------------ api helpers */

test('WS_URL resolution is always absolute ws(s):// in a browser', () => {
  assert.equal(resolveWsUrl('/api', { protocol: 'http:', host: 'localhost:5173' }), 'ws://localhost:5173/api/ws');
  assert.equal(resolveWsUrl('/api/', { protocol: 'https:', host: 'board.example' }), 'wss://board.example/api/ws');
  assert.equal(resolveWsUrl('http://localhost:3001/api', null), 'ws://localhost:3001/api/ws');
  assert.equal(resolveWsUrl('https://x.example/api///', null), 'wss://x.example/api/ws');
  assert.equal(resolveWsUrl('/api', { protocol: 'https:', host: 'h' }, 'wss://rt.example/sock'), 'wss://rt.example/sock');
  assert.equal(resolveWsUrl('/api', { protocol: 'https:', host: 'h:8443' }, '/live'), 'wss://h:8443/live');
});

test('useUpdateBoard(id).mutate({title}) PATCHes /boards/<id> with {title} and updates store.board', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, method: init.method, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: 'b1', title: 'Novo', theme: 'light', rev: 3 }), { status: 200 });
  };
  try {
    storeA.getState().setSnapshot({ board: { id: 'b1', title: 'Velho', theme: 'light' }, elements: [], rev: 3 });
    const cache = new Map();
    const qc = {
      setQueryData: (key, fn) => cache.set(JSON.stringify(key), fn(cache.get(JSON.stringify(key)))),
      invalidateQueries: () => {},
    };
    const m = updateBoardMutation('b1', qc);
    const board = await m.mutationFn({ title: '  Novo  ' });
    m.onSuccess(board, { title: 'Novo' });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.match(calls[0].url, /\/boards\/b1$/);
    assert.deepEqual(calls[0].body, { title: 'Novo' }, 'trimmed title, nothing else');
    assert.equal(storeA.getState().board.title, 'Novo', 'the header updates from the response');

    // The legacy envelope still lands on the right URL.
    await updateBoardMutation(undefined, qc).mutationFn({ id: 'b1', patch: { title: 'X' } });
    assert.match(calls[1].url, /\/boards\/b1$/);
    assert.deepEqual(calls[1].body, { title: 'X' });

    assert.throws(() => m.mutationFn({ title: '   ' }), /vazio/);
    assert.deepEqual(boardPatchOf({ title: 'a', ownerId: 'x', theme: 'dark' }), { title: 'a', theme: 'dark' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

/* ========================================================================
   Batches by bytes, bindings across batches, stale resyncs, tab close,
   offline, missing boards
   ======================================================================== */

/** A valid image element whose data URL is `chars` long. */
const bigImage = (id, chars, x = 0) => ({
  id,
  type: 'image',
  x,
  y: 0,
  w: 160,
  h: 120,
  src: `data:image/png;base64,${'A'.repeat(chars - 'data:image/png;base64,'.length)}`,
});

/** A stash in memory, shaped like stash.js. */
function memoryStash() {
  const boards = new Map();
  return {
    boards,
    save(boardId, ops) {
      const prior = boards.get(boardId) ?? [];
      const seen = new Set(prior.map((op) => op.opId));
      boards.set(boardId, [...prior, ...ops.filter((op) => !seen.has(op.opId))]);
      return true;
    },
    take(boardId) {
      const ops = boards.get(boardId) ?? [];
      boards.delete(boardId);
      return ops;
    },
    drop(boardId) {
      boards.delete(boardId);
    },
  };
}

test('a drop of several big images goes out in frames under the byte budget, and everything lands', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  // Six ~1.8M-char images in ONE commit: ~10.8 MB, over the 8 MiB frame cap.
  edit(a, 'drop-images', (s) => s.addElements([1, 2, 3, 4, 5, 6].map((i) => bigImage(`img${i}`, 1_800_000, i * 200))));
  await settle(server, [a], 60);
  edit(a, 'add', (s) => s.addElement(rect('after', 0, 400)));
  await settle(server, [a], 60);

  const frames = server.frames.filter((f) => f.msg.type === 'ops' || f.msg.type === 'oversized');
  assert.ok(frames.every((f) => f.msg.type === 'ops'), 'no frame was over the server cap');
  assert.ok(frames.length >= 3, `split into several frames (got ${frames.length})`);
  for (const f of frames) assert.ok(f.size <= MAX_BATCH_BYTES + 2_000_000, `frame of ${f.size} bytes is within budget`);
  const ids = (await server.elements('b1')).map((e) => e.id);
  assert.deepEqual(ids, ['img1', 'img2', 'img3', 'img4', 'img5', 'img6', 'after'], 'every image and the later edit persisted');
  a.close();
});

test('a batch the server keeps closing (1009) is split; a lone op that can never fit is dropped, not retried forever', async () => {
  // A server configured tighter than the client's budget: 1.7 MB frames.
  const server = new FakeServer({ maxPayload: 1_700_000 });
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  // Two 1M images: one 2 MB frame, closed with 1009 -> split -> both land.
  edit(a, 'drop', (s) => s.addElements([bigImage('i1', 1_000_000), bigImage('i2', 1_000_000, 300)]));
  await settle(server, [a], 60);
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['i1', 'i2']);

  // One op bigger than the server takes at all: dropped after the 1009, reported,
  // rolled back locally; later edits are not stuck behind it.
  const opens = () => server.frames.filter((f) => f.msg.type === 'join').length;
  edit(a, 'drop', (s) => s.addElement(bigImage('huge', 1_900_000)));
  edit(a, 'add', (s) => s.addElement(rect('later', 0, 400)));
  await until(() => (a.S().elements.some((e) => e.id === 'later') && !a.S().elements.some((e) => e.id === 'huge')), {
    what: 'the oversized image rolled back',
  });
  await settle(server, [a], 80);
  const joinsBefore = opens();
  await sleep(150);
  assert.equal(opens(), joinsBefore, 'no reconnect loop');
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['i1', 'i2', 'later']);
  assert.ok(a.errors.some((e) => e.code === 'PAYLOAD_TOO_LARGE'), 'the drop is reported');
  assert.deepEqual(essence(a.S().elements), essence(await server.elements('b1')));
  a.close();
});

test('a change over 200 ops keeps connector bindings: targets are created before the arrows bound to them', async () => {
  const server = new FakeServer();
  const rects = Array.from({ length: 250 }, (_, i) => rect(`r${i}`, (i % 25) * 120, Math.floor(i / 25) * 80));
  const arrow = {
    id: 'ar',
    type: 'arrow',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    points: [{ x: 0, y: 0 }, { x: 100, y: 100 }],
    stroke: '#1e1e1e',
    endId: 'r249',
  };
  await freshBoard(server, 'b1', [arrow, ...rects]); // the arrow sits BELOW its target
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  // Ctrl+A, Ctrl+D: copies in z-order, the arrow copy bound to the copy of r249.
  edit(a, 'duplicate', (s) =>
    s.addElements(s.elements.map((el) => ({ ...el, id: `c-${el.id}`, ...(el.endId ? { endId: `c-${el.endId}` } : {}) }))),
  );
  await settle(server, [a, b], 80);

  const truth = await server.elements('b1');
  assert.equal(truth.length, 502);
  assert.equal(truth.find((e) => e.id === 'c-ar').endId, 'c-r249', 'the server kept the binding');
  assert.equal(b.S().elements.find((e) => e.id === 'c-ar').endId, 'c-r249', 'and so did the live peer');
  assert.deepEqual(truth.map((e) => e.id), a.S().elements.map((e) => e.id), 'same z-order everywhere');
  assert.deepEqual(b.S().elements.map((e) => e.id), a.S().elements.map((e) => e.id));
  a.close();
  b.close();
});

test('replacing a nearly full board (an import) deletes first, so MAX_ELS is never passed halfway', async () => {
  const server = new FakeServer({ latency: 1 });
  const old = Array.from({ length: 2501 }, (_, i) => rect(`old${i}`, (i % 50) * 110, Math.floor(i / 50) * 70));
  await freshBoard(server, 'b1', old);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected' && a.S().elements.length === 2501);

  const incoming = Array.from({ length: 2500 }, (_, i) => ({ ...rect(`new${i}`, (i % 50) * 110, Math.floor(i / 50) * 70), type: 'ellipse' }));
  edit(a, 'import', (s) => s.replaceAll(incoming)); // 2501 + 2500 > 5000 if creates went first
  await settle(server, [a], 80);

  const truth = await server.elements('b1');
  assert.equal(truth.length, 2500, 'the whole file landed');
  assert.ok(truth.every((e) => e.type === 'ellipse'));
  assert.equal(a.errors.filter((e) => e.kind === 'ops').length, 0, 'no batch was refused');
  assert.equal(a.S().elements.length, 2500);
  a.close();
});

test('a resync snapshot older than broadcasts already applied is brought up to date, not rolled back', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1', [rect('r1'), rect('victim', 0, 200)]);
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  const b = track(makeClient(server, storeB, { boardId: 'b1', name: 'Bruno' }));
  await until(() => a.client.status === 'connected' && b.client.status === 'connected');

  // While each of A's snapshot GETs is "on the wire", B keeps editing (a
  // create each time, and a delete the first time) and A applies the
  // broadcasts — so EVERY snapshot is older than what A shows. It used to
  // refetch 3 times and then apply the 4th stale one, losing B's last edit.
  let fetches = 0;
  server.onSnapshot = async () => {
    fetches += 1;
    if (fetches > 5) return;
    const id = `fromB${fetches}`;
    edit(b, 'add', (s) => s.addElement(rect(id, 300, fetches * 70)));
    await until(() => a.S().elements.some((e) => e.id === id), { what: `A sees ${id}` });
    if (fetches > 1) return;
    edit(b, 'delete', (s) => s.removeElements(['victim']));
    await until(() => !a.S().elements.some((e) => e.id === 'victim'), { what: 'A sees the delete' });
  };
  // Count snapshot GETs in flight, so the test waits for the whole resync.
  const realSnapshot = server.snapshot.bind(server);
  let active = 0;
  server.snapshot = async (id) => {
    active += 1;
    try {
      return await realSnapshot(id);
    } finally {
      active -= 1;
    }
  };
  const sock = [...server.sockets].find((s) => s.__client === a.client);
  sock.deliver({ type: 'resync', boardId: 'b1', rev: a.client.rev });
  await until(() => fetches >= 1 && active === 0 && server.busy === 0, { what: 'the resync', timeout: 5000 });
  await sleep(100);
  await until(() => active === 0, { what: 'no refetch in flight', timeout: 5000 });
  await settle(server, [a, b], 120);
  server.onSnapshot = null;

  const truth = await server.elements('b1');
  assert.deepEqual(truth.map((e) => e.id), ['r1', ...Array.from({ length: fetches }, (_, i) => `fromB${i + 1}`)]);
  assert.deepEqual(essence(a.S().elements), essence(truth), "A kept B's creates and did not resurrect the deleted element");
  assert.equal(fetches, 1, 'no refetch was needed: the batches in between were known');
  a.close();
  b.close();
});

test('closing the tab: one keepalive request with what fits, everything stashed and replayed on the next visit', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const stash = memoryStash();
  const posts = [];
  const postOps = async (boardId, ops, opts) => {
    posts.push({ boardId, ops, opts, bytes: utf8Length(JSON.stringify({ ops, actorId: 'x'.repeat(10) })) });
    return server.postOps(boardId, ops);
  };
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana', stash, postOps }));
  await until(() => a.client.status === 'connected');

  server.held = []; // the socket never acks: everything stays pending
  edit(a, 'paste', (s) => s.addElements(Array.from({ length: 300 }, (_, i) => rect(`p${i}`, i * 3, 0))));
  a.sync.flush();
  a.client.disconnect({ unloading: true }); // pagehide
  server.held = null;

  assert.equal(posts.length, 1, 'exactly one request while the page goes away (no chain, no burst)');
  assert.equal(posts[0].opts?.keepalive, true);
  assert.ok(posts[0].bytes <= KEEPALIVE_BYTES + 100, `the keepalive body fits the browser quota (${posts[0].bytes} bytes)`);
  assert.ok(posts[0].ops.length < 300, 'it cannot carry all 300 rects');
  assert.equal(stash.boards.get('b1').length, 300, 'but all 300 are stashed');
  await sleep(40);

  // Next visit, same browser (a fresh store): the stash is queued first and delivered.
  storeB.getState().reset();
  const next = track(makeClient(server, storeB, { boardId: 'b1', name: 'Ana', stash, postOps }));
  await until(() => next.client.status === 'connected');
  await settle(server, [next], 80);
  const truth = await server.elements('b1');
  assert.equal(truth.length, 300, 'every pasted rect reached the server exactly once');
  assert.deepEqual(truth.map((e) => e.id), Array.from({ length: 300 }, (_, i) => `p${i}`), 'in order');
  assert.equal(stash.boards.has('b1'), false, 'the stash is consumed');
  assert.deepEqual(essence(next.S().elements), essence(truth));
  next.close();
});

test('leaving a board: the HTTP salvage is split by bytes, sent in order, and what fails is stashed', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  await freshBoard(server, 'b2');
  const stash = memoryStash();
  const posts = [];
  let failFrom = Infinity;
  const postOps = async (boardId, ops) => {
    posts.push(ops.length);
    if (posts.length >= failFrom) throw Object.assign(new Error('network down'), { status: 0 });
    return server.postOps(boardId, ops);
  };
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana', stash, postOps }));
  await until(() => a.client.status === 'connected');

  server.held = [];
  edit(a, 'drop', (s) => s.addElements([1, 2, 3].map((i) => bigImage(`img${i}`, 1_800_000, i * 200))));
  edit(a, 'add', (s) => s.addElement(rect('tail', 0, 400)));
  a.sync.flush();
  failFrom = 2; // the second request fails
  a.client.connect('b2');
  server.held = null;
  await until(() => a.client.status === 'connected');
  await sleep(40);

  assert.deepEqual(posts, [2, 2], 'two images per request (byte budget), the second request failed');
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['img1', 'img2']);
  assert.deepEqual(stash.boards.get('b1').map((op) => op.element?.id), ['img3', 'tail'], 'the rest waits for the next visit');
  assert.ok(a.errors.some((e) => e.kind === 'salvage'), 'reported, but not as a rejected edit');
  assert.ok(!a.errors.some((e) => e.kind === 'ops'));
  a.close();
});

test('the browser going offline says offline at once; back online it reconnects and the edits land', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');

  a.client.markOffline(); // the window's 'offline' event
  assert.equal(a.S().connection, 'offline', 'no waiting for an ack timeout');
  assert.equal(a.client.ws, null, 'the socket is dropped');
  edit(a, 'add', (s) => s.addElement(rect('offline-edit')));
  a.sync.flush();
  assert.equal(a.client.outbox.length, 1, 'the edit waits in the queue');

  a.client.reconnect(); // the window's 'online' event
  await settle(server, [a], 60);
  assert.deepEqual((await server.elements('b1')).map((e) => e.id), ['offline-edit']);
  a.close();
});

test('a board deleted while open is final: the missing ack stops the client and says BOARD_NOT_FOUND', async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');
  const joins = () => server.frames.filter((f) => f.msg.type === 'join').length;
  const joined = joins();

  await server.store.deleteBoard('b1');
  edit(a, 'add', (s) => s.addElement(rect('into-the-void')));
  await until(() => a.client.status === 'disconnected', { what: 'disconnected' });
  await sleep(60);
  assert.equal(joins(), joined, 'no reconnect: the board is gone');
  assert.equal(a.client.fatal, true);
  assert.equal(a.client.outbox.length + (a.client.inflight ? 1 : 0), 0, 'nothing left to send');
  assert.equal(a.S().connection, 'disconnected');
  assert.ok(a.S().error, 'the store says so');
  assert.equal(a.S().status, 'missing');
  assert.ok(a.errors.some((e) => e.code === 'BOARD_NOT_FOUND'));
  a.close();
});

test("the server evicting a deleted board's room (BOARD_NOT_FOUND error) is final too, even with no edit", async () => {
  const server = new FakeServer();
  await freshBoard(server, 'b1');
  const a = track(makeClient(server, storeA, { boardId: 'b1', name: 'Ana' }));
  await until(() => a.client.status === 'connected');
  const joins = () => server.frames.filter((f) => f.msg.type === 'join').length;
  const joined = joins();

  const sock = [...server.sockets].find((s) => s.__client === a.client);
  sock.deliver({ type: 'error', text: 'board deleted', code: 'BOARD_NOT_FOUND', boardId: 'b1' });
  await until(() => a.client.status === 'disconnected', { what: 'disconnected' });
  await sleep(60);
  assert.equal(joins(), joined, 'no reconnect');
  assert.equal(a.S().status, 'missing');
  assert.ok(a.errors.some((e) => e.code === 'BOARD_NOT_FOUND'));
  a.close();
});
