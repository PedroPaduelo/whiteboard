/**
 * Sync-bridge behaviour, with a fake client instead of a socket.
 *
 * These pin the three rules that make collaboration feel right, and each one
 * is a bug that is invisible in a screenshot: a double-drawn drag, a
 * collaborator's create re-sent as yours, or 60 messages a second during a
 * drag that should be one.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { useBoardStore } from '../store/boardStore.js';
import { StoreSync, withRemote, diffElements, collapseOps } from './sync.js';

const s = () => useBoardStore.getState();
const wait = () => new Promise((r) => setTimeout(r, 80));

/** A client that records what it was asked to send. */
function fakeClient() {
  const sent = [];
  return {
    sent,
    makeOp: (kind, fields = {}) => ({ opId: `op${sent.length}_${kind}`, kind, ...fields }),
    sendOps: (ops) => sent.push(...ops),
  };
}

const rect = (id, extra = {}) => ({ id, type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#1f2937', fill: 'none', ...extra });

/** Start a bridge on a fresh store, returning the fake client. */
function harness() {
  s().reset();
  const client = fakeClient();
  const sync = new StoreSync(client);
  sync.start();
  return { client, sync };
}

test.beforeEach(() => s().reset());

// ----------------------------------------------------------- no re-entry

test('a LOCAL add ships exactly one create', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('a'));
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind), ['create']);
  sync.stop();
});

test('a REMOTE update is NOT re-broadcast (the double-draw bug)', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('a'));
  await wait();
  client.sent.length = 0;

  withRemote(() => s().applyRemoteOp({ kind: 'update', elementId: 'a', patch: { x: 99 } }));
  await wait();

  assert.equal(client.sent.length, 0, 'our own echo must not come back as an op');
  assert.equal(s().elements[0].x, 99, 'the remote change IS applied locally');
  sync.stop();
});

test('a REMOTE create is not echoed back', async () => {
  const { client, sync } = harness();
  withRemote(() => s().applyRemoteOp({ kind: 'create', element: rect('r') }));
  await wait();
  assert.equal(client.sent.length, 0);
  assert.deepEqual(s().elements.map((e) => e.id), ['r']);
  sync.stop();
});

test('a remote create is not re-shipped by the NEXT local edit', async () => {
  // The subtle one: if the diff baseline is not advanced on a remote change,
  // the following local edit diffs against a board that never had the remote
  // element and emits a `create` for a peer's element as if it were ours.
  const { client, sync } = harness();
  withRemote(() => s().applyRemoteOp({ kind: 'create', element: rect('r') }));
  await wait();
  client.sent.length = 0;

  s().addElement(rect('mine'));
  await wait();

  assert.deepEqual(
    client.sent.map((o) => o.kind),
    ['create'],
  );
  assert.equal(client.sent[0].element.id, 'mine', 'and it is OUR element, not theirs');
  sync.stop();
});

test('local edits still ship after a remote change', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('a'));
  await wait();
  withRemote(() => s().applyRemoteOp({ kind: 'update', elementId: 'a', patch: { x: 5 } }));
  await wait();
  client.sent.length = 0;

  s().commit('u');
  s().updateElement('a', { x: 7 });
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind), ['update']);
  sync.stop();
});

// -------------------------------------------------------------- batching

test('a 20-frame drag collapses to ONE op', async () => {
  // The reason the debounce exists: 60 messages a second per peer is what
  // makes a collaborative canvas feel laggy.
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('a'));
  await wait();
  client.sent.length = 0;

  for (let i = 1; i <= 20; i++) s().updateElements([{ id: 'a', patch: { x: i } }]);
  await wait();

  assert.equal(client.sent.length, 1, 'one message, not twenty');
  assert.equal(client.sent[0].kind, 'update');
  assert.equal(client.sent[0].patch.x, 20, 'carrying the FINAL position');
  sync.stop();
});

test('a multi-element drag collapses to one op PER element', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElements([rect('a'), rect('b')]);
  await wait();
  client.sent.length = 0;

  for (let i = 0; i < 20; i++) s().updateElements([{ id: 'a', patch: { x: i } }, { id: 'b', patch: { x: i } }]);
  await wait();

  assert.equal(client.sent.length, 2);
  assert.deepEqual(client.sent.map((o) => o.elementId).sort(), ['a', 'b']);
  sync.stop();
});

test('collapseOps merges patches for one element and keeps the first opId', () => {
  const merged = collapseOps([
    { opId: 'o1', kind: 'update', elementId: 'a', patch: { x: 1 } },
    { opId: 'o2', kind: 'update', elementId: 'a', patch: { y: 2 } },
    { opId: 'o3', kind: 'update', elementId: 'a', patch: { x: 9 } },
  ]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0].patch, { x: 9, y: 2 }, 'fields unioned, last value wins');
  assert.equal(merged[0].opId, 'o1', 'the first opId survives so server dedupe still works');
});

test('collapseOps does NOT collapse create+delete of the same element', () => {
  // Collapsing these would mean the server never learns the element existed,
  // and the two ops would land in a batch where the delete precedes the
  // create — resurrecting a deleted element on the other peers.
  const ops = [
    { opId: 'o1', kind: 'create', element: rect('x') },
    { opId: 'o2', kind: 'delete', elementId: 'x' },
  ];
  assert.equal(collapseOps(ops).length, 2);
});

test('collapseOps leaves a mixed batch in order', () => {
  const merged = collapseOps([
    { opId: 'a', kind: 'create', element: rect('x') },
    { opId: 'b', kind: 'update', elementId: 'x', patch: { x: 1 } },
    { opId: 'c', kind: 'update', elementId: 'x', patch: { x: 2 } },
    { opId: 'd', kind: 'reorder', order: ['x'] },
  ]);
  assert.deepEqual(merged.map((o) => o.kind), ['create', 'update', 'reorder']);
  assert.equal(merged[1].patch.x, 2);
});

// ------------------------------------------------------------------ diff

const makeOp = (() => {
  let n = 0;
  return (kind, fields = {}) => ({ opId: `o${++n}`, kind, ...fields });
})();

test('diffElements: create, update, delete, reorder, no-op', () => {
  const a = rect('a');
  const b = rect('b');
  assert.deepEqual(diffElements([], [a], makeOp).ops.map((o) => o.kind), ['create']);
  assert.deepEqual(diffElements([a], [], makeOp).ops.map((o) => o.kind), ['delete']);
  assert.deepEqual(diffElements([a], [rect('a', { x: 5 })], makeOp).ops[0].patch, { x: 5 });
  assert.deepEqual(diffElements([a], [a], makeOp).ops, [], 'an unchanged board ships nothing');
  assert.deepEqual(diffElements([a, b], [b, a], makeOp).ops.map((o) => o.kind), ['reorder']);
});

test('diffElements: a reorder alongside an edit ships only the update', () => {
  // The creates/deletes already carry the new order; a second reorder op
  // would be redundant traffic.
  const a = rect('a');
  const b = rect('b');
  const { ops } = diffElements([a, b], [rect('b', { x: 9 }), a], makeOp);
  assert.deepEqual(ops.map((o) => o.kind), ['update']);
});

test('diffElements: a patch never carries id or type', () => {
  const a = rect('a');
  const moved = { ...a, x: 5 };
  const { ops } = diffElements([a], [moved], makeOp);
  assert.equal(ops[0].patch.id, undefined);
  assert.equal(ops[0].patch.type, undefined);
});

test('diffElements: a points change sends points, not a stale box', () => {
  const p = (pts) => ({ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: pts, stroke: '#1f2937' });
  const { ops } = diffElements([p([{ x: 0, y: 0 }])], [p([{ x: 0, y: 0 }, { x: 50, y: 30 }])], makeOp);
  assert.equal(ops[0].patch.points.length, 2);
  assert.equal(ops[0].patch.x, undefined, 'the box is re-derived server-side, not sent stale');
});

test('diffElements: forceFull encodes undo as clear + create', () => {
  const a = rect('a');
  const { ops, full } = diffElements([a, rect('b')], [a], makeOp, true);
  assert.equal(full, true);
  assert.equal(ops[0].kind, 'clear');
  assert.deepEqual(ops.slice(1).map((o) => o.kind), ['create']);
});

test('an undo is actually encoded as clear + create end to end', async () => {
  // Undo/redo must go through `replaceAll` for the epoch to bump. If it
  // wrote `elements` directly, the bridge would emit a `reorder` instead.
  const { client, sync } = harness();
  s().commit('add');
  s().addElements([rect('a'), rect('b')]);
  await wait();
  client.sent.length = 0;

  // Undo once, back to empty. `clear` is still the right first op even with
  // nothing to recreate — the other peers must be emptied either way.
  s().undo();
  await wait();

  assert.equal(client.sent[0].kind, 'clear', 'undo starts with a clear, not a reorder');

  // Redo must come back as clear + create for both elements.
  client.sent.length = 0;
  s().redo();
  await wait();
  assert.equal(client.sent[0].kind, 'clear');
  assert.equal(client.sent.filter((o) => o.kind === 'create').length, 2, 'both elements are re-created');
  sync.stop();
});

test('stop() flushes whatever is still queued', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('a'));
  sync.stop(); // no wait — the debounce timer has not fired yet
  assert.deepEqual(client.sent.map((o) => o.kind), ['create'], 'nothing is lost on teardown');
});

test('start() twice keeps one subscription', async () => {
  const { client, sync } = harness();
  sync.start();
  s().commit('add');
  s().addElement(rect('a'));
  await wait();
  assert.equal(client.sent.length, 1, 'a double start must not double every op');
  sync.stop();
});

test('collapseOps drops everything before the LAST clear as dead', () => {
  // Two undos inside one debounce window produce this shape. Everything
  // before the final `clear` is overwritten by it, so shipping it is pure
  // waste — and worse, it makes the batch lie about the board's final state.
  const collapsed = collapseOps([
    { opId: '1', kind: 'create', element: rect('a') },
    { opId: '2', kind: 'delete', elementId: 'b' },
    { opId: '3', kind: 'clear' },
    { opId: '4', kind: 'create', element: rect('a') },
    { opId: '5', kind: 'update', elementId: 'a', patch: { fill: '#fde68a' } },
    { opId: '6', kind: 'clear' },
    { opId: '7', kind: 'create', element: rect('a') },
  ]);
  assert.deepEqual(collapsed.map((o) => o.kind), ['clear', 'create']);
  assert.equal(collapsed[1].element.fill, 'none', 'the create carries the FINAL state');
});

test('collapseOps keeps everything when there is no clear', () => {
  const ops = [
    { opId: '1', kind: 'create', element: rect('a') },
    { opId: '2', kind: 'update', elementId: 'a', patch: { x: 1 } },
  ];
  assert.equal(collapseOps(ops).length, 2);
});
