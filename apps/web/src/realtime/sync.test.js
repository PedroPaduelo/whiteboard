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
import { StoreSync, withRemote, diffElements, collapseOps, clearedValue } from './sync.js';

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

test('diffElements: a reorder alongside an edit ships the update AND the reorder', () => {
  // The old encoding dropped the reorder whenever anything else changed, so
  // an undo that restored both a colour and a z-order lost the z-order.
  const a = rect('a');
  const b = rect('b');
  const { ops } = diffElements([a, b], [rect('b', { x: 9 }), a], makeOp);
  assert.deepEqual(ops.map((o) => o.kind), ['update', 'reorder']);
  assert.deepEqual(ops[1].order, ['b', 'a']);
});

test('diffElements: creates that land on top need no reorder', () => {
  const a = rect('a');
  const { ops } = diffElements([a], [a, rect('b'), rect('c')], makeOp);
  assert.deepEqual(ops.map((o) => o.kind), ['create', 'create']);
});

test('diffElements: a create BELOW existing elements adds a reorder (undo of a delete)', () => {
  // The server appends a create on top; restoring an element in place needs
  // the order too, or the undone element comes back above everything.
  const a = rect('a');
  const c = rect('c');
  const { ops } = diffElements([a, c], [a, rect('b'), c], makeOp);
  assert.deepEqual(ops.map((o) => o.kind), ['create', 'reorder']);
  assert.deepEqual(ops[1].order, ['a', 'b', 'c']);
});

test('diffElements: a delete alone needs no reorder', () => {
  // New objects for a and c with identical content (a resync hands us fresh
  // JSON): no update ships, only the delete.
  const { ops } = diffElements([rect('a'), rect('b'), rect('c')], [rect('a'), rect('c')], makeOp);
  assert.deepEqual(ops.map((o) => o.kind), ['delete']);
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

test('diffElements: a removed nullable key is sent as null (unbinding a connector end)', () => {
  const arrow = (extra) => ({ id: 'ar', type: 'arrow', x: 0, y: 0, w: 10, h: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], ...extra });
  const { ops } = diffElements([arrow({ startId: 'a', endId: 'b' })], [arrow({ endId: 'b' })], makeOp);
  assert.equal(ops.length, 1);
  assert.deepEqual(ops[0].patch, { startId: null });
});

test('diffElements: groupId removal is null too', () => {
  const { ops } = diffElements([rect('a', { groupId: 'g1' })], [rect('a')], makeOp);
  assert.deepEqual(ops[0].patch, { groupId: null });
});

test('diffElements: keys the server cannot null get their default (undo of lock / first rotation)', () => {
  const { ops } = diffElements([rect('a', { locked: true, rotation: 0.5 })], [rect('a')], makeOp);
  assert.deepEqual(ops[0].patch, { locked: false, rotation: 0 });
  assert.equal(clearedValue('endArrowhead', { type: 'arrow' }), 'arrow');
  assert.equal(clearedValue('endArrowhead', { type: 'line' }), 'none');
  assert.equal(clearedValue('createdAt', { type: 'rect' }), undefined, 'unexpressible keys are left alone');
});

test('diffElements: the patch never carries undefined or a stale key', () => {
  const { ops } = diffElements([rect('a', { label: 'x' })], [rect('a', { label: undefined })], makeOp);
  assert.deepEqual(ops[0].patch, { label: null });
  assert.ok(!JSON.stringify(ops).includes('undefined'));
});

test('an undo ships a MINIMAL diff, never clear + create', async () => {
  const { client, sync } = harness();
  s().commit('add');
  s().addElements([rect('a'), rect('b')]);
  await wait();
  client.sent.length = 0;

  s().undo();
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind).sort(), ['delete', 'delete'], 'exactly the two deletes');
  assert.ok(!client.sent.some((o) => o.kind === 'clear'), 'no clear, ever');

  client.sent.length = 0;
  s().redo();
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind), ['create', 'create']);
  sync.stop();
});

test("undo does NOT touch a collaborator's element created after the commit", async () => {
  // The bug this replaces: undo was clear + re-create of the old snapshot,
  // which deleted everything a peer had added since.
  const { client, sync } = harness();
  s().commit('add');
  s().addElement(rect('mine'));
  await wait();
  withRemote(() => s().applyRemoteOps([{ kind: 'create', element: rect('theirs') }]));
  withRemote(() => s().applyRemoteOps([{ kind: 'update', elementId: 'mine', patch: { fill: '#ffc9c9' } }]));
  client.sent.length = 0;

  s().undo();
  await wait();
  assert.deepEqual(client.sent.map((o) => [o.kind, o.elementId]), [['delete', 'mine']]);
  assert.deepEqual(s().elements.map((e) => e.id), ['theirs'], 'their element survives locally too');

  client.sent.length = 0;
  s().redo();
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind), ['create', 'reorder'], 'mine comes back BELOW theirs, where it was');
  assert.deepEqual(s().elements.map((e) => e.id), ['mine', 'theirs']);
  assert.equal(s().elements[0].fill, '#ffc9c9', 'with the remote colour change it had received');
  sync.stop();
});

test('undo of a move reverts only the moved field, keeping a remote recolour', async () => {
  const { client, sync } = harness();
  s().addElement(rect('a'));
  await wait();
  s().commit('move:1');
  s().updateElement('a', { x: 50 });
  await wait();
  withRemote(() => s().applyRemoteOps([{ kind: 'update', elementId: 'a', patch: { stroke: '#e03131' } }]));
  client.sent.length = 0;

  s().undo();
  await wait();
  assert.equal(client.sent.length, 1);
  assert.deepEqual(client.sent[0].patch, { x: 0 });
  assert.equal(s().elements[0].stroke, '#e03131');
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

test('collapseOps does NOT merge an update across a delete + re-create of the element', () => {
  // undo (delete) then redo (create) inside one debounce window: merging the
  // later update into the earlier one would apply it to the dead element.
  const out = collapseOps([
    { opId: '1', kind: 'update', elementId: 'a', patch: { x: 1 } },
    { opId: '2', kind: 'delete', elementId: 'a' },
    { opId: '3', kind: 'create', element: rect('a') },
    { opId: '4', kind: 'update', elementId: 'a', patch: { x: 2 } },
  ]);
  assert.deepEqual(out.map((o) => o.opId), ['1', '2', '3', '4']);
  assert.equal(out[3].patch.x, 2);
});

test('collapseOps never merges into or drops FROZEN (already sent) ops', () => {
  const frozen = new Set(['1']);
  const out = collapseOps(
    [
      { opId: '1', kind: 'update', elementId: 'a', patch: { x: 1 } },
      { opId: '2', kind: 'update', elementId: 'a', patch: { x: 2 } },
      { opId: '3', kind: 'update', elementId: 'a', patch: { y: 3 } },
    ],
    { frozen },
  );
  assert.deepEqual(out.map((o) => o.opId), ['1', '2'], '2 and 3 merge, 1 stays as sent');
  assert.deepEqual(out[0].patch, { x: 1 });
  assert.deepEqual(out[1].patch, { x: 2, y: 3 });
});

test('a board switch is never shipped as ops', async () => {
  const { client, sync } = harness();
  s().setBoardId('A');
  await wait();
  s().addElement(rect('a'));
  await wait();
  client.sent.length = 0;

  // The App hydrates board B without withRemote (a mistake the bridge must survive).
  s().setSnapshot({ board: { id: 'B' }, elements: [rect('b1')], rev: 3 });
  s().reset();
  await wait();
  assert.equal(client.sent.length, 0, 'no delete of A elements, no create of B elements');
  sync.stop();
});

test('the first edit after a bare board-id change IS shipped', async () => {
  const { client, sync } = harness();
  s().setBoardId('B'); // no element change at all (an empty board)
  s().addElement(rect('first'));
  await wait();
  assert.deepEqual(client.sent.map((o) => o.kind), ['create']);
  sync.stop();
});

test('pendingOps() exposes the debounce window without flushing it', async () => {
  const { client, sync } = harness();
  s().addElement(rect('a'));
  assert.deepEqual(sync.pendingOps().map((o) => o.kind), ['create']);
  assert.equal(client.sent.length, 0);
  await wait();
  assert.equal(sync.pendingOps().length, 0);
  assert.equal(client.sent.length, 1);
  sync.stop();
});
