/**
 * The Store contract, proved against BOTH drivers.
 *
 * Every case runs twice: once on the in-memory reference implementation and
 * once on sqlite (a real file in the OS temp dir, removed in `after`). If a rule
 * only holds for one driver, the suite fails — which is the whole point of
 * parameterising it.
 *
 * The cases below map onto the 7 numbered rules of
 * docs/API_CONTRACT.md "applyOps semantics", one comment per rule.
 */

import { test, describe, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LIMITS, BIND_GAP, validateOps } from '@whiteboard/shared';

import { createStore as createMemoryStore } from '../src/store/memory.js';
import { createStore as createSqliteStore } from '../src/store/sqlite.js';

/* ---------------------------------------------------------------- helpers */

let seq = 0;
const opId = (name) => `${name ?? 'op'}-${++seq}`;

const rect = (id, over = {}) => ({ id, type: 'rect', x: 0, y: 0, w: 10, h: 10, ...over });
const pen = (id, points, over = {}) => ({ id, type: 'pen', x: 0, y: 0, w: 0, h: 0, points, ...over });
const arrow = (id, a, b, over = {}) => ({
  id, type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [a, b], ...over,
});

/** Build an op without going through validateOps, so the store is what's tested. */
const create = (boardId, element, extra = {}) => ({
  opId: opId('create'), boardId, kind: 'create', element, ...extra,
});
const update = (boardId, elementId, patch, extra = {}) => ({
  opId: opId('update'), boardId, kind: 'update', elementId, patch, ...extra,
});
const del = (boardId, elementId, extra = {}) => ({
  opId: opId('del'), boardId, kind: 'delete', elementId, ...extra,
});
const reorder = (boardId, list, extra = {}) => ({
  opId: opId('reorder'), boardId, kind: 'reorder', order: list, ...extra,
});
const clear = (boardId, extra = {}) => ({
  opId: opId('clear'), boardId, kind: 'clear', ...extra,
});

/** Stable string form of a snapshot, for byte-identical before/after compares. */
const fingerprint = (snap) => JSON.stringify({
  board: { ...snap.board, updatedAt: 0 },
  elements: snap.elements,
  rev: snap.rev,
});

/* ---------------------------------------------------------------- drivers */

const tmpRoot = mkdtempSync(join(tmpdir(), 'wb-store-'));
let fileSeq = 0;

const DRIVERS = [
  {
    name: 'memory',
    make: () => createMemoryStore(),
  },
  {
    name: 'sqlite',
    make: () => {
      const p = join(tmpRoot, `db-${++fileSeq}`, 'whiteboard.db');
      // The parent directory does NOT exist yet: createStore must make it.
      return createSqliteStore({ path: p });
    },
  },
];

for (const driver of DRIVERS) {
  describe(`store [${driver.name}]`, () => {
    let store;
    let boardId;

    before(async () => {
      store = driver.make();
      const board = await store.createBoard({ title: 'Test board', theme: 'light' });
      boardId = board.id;
    });

    after(async () => {
      await store.close();
    });

    /* --- board lifecycle --------------------------------------------- */

    test('createBoard then getSnapshot returns it at rev 0', async () => {
      const snap = await store.getSnapshot(boardId);
      assert.ok(snap, 'snapshot exists');
      assert.equal(snap.rev, 0);
      assert.equal(snap.board.id, boardId);
      assert.equal(snap.board.title, 'Test board');
      assert.equal(snap.board.theme, 'light');
      assert.deepEqual(snap.elements, []);
    });

    test('getSnapshot of an unknown board is null', async () => {
      assert.equal(await store.getSnapshot('nope-does-not-exist'), null);
    });

    test('listBoards reports elementCount and a total', async () => {
      const b = await store.createBoard({ title: 'Counted board' });
      await store.applyOps(b.id, [create(b.id, rect('c1'))]);
      const { boards, total } = await store.listBoards({ limit: 50, offset: 0 });
      assert.equal(total, boards.length);
      const found = boards.find((x) => x.id === b.id);
      assert.equal(found.elementCount, 1);
      await store.deleteBoard(b.id);
    });

    test('listBoards search filters on title and totals the filtered set', async () => {
      const a = await store.createBoard({ title: 'Alpha Planning' });
      const b = await store.createBoard({ title: 'Beta Retro' });
      const { boards, total } = await store.listBoards({ search: 'alpha' });
      assert.equal(total, 1);
      assert.equal(boards[0].id, a.id);
      assert.ok(boards.every((x) => x.id !== b.id));
      await store.deleteBoard(a.id);
      await store.deleteBoard(b.id);
    });

    test('listBoards search treats LIKE wildcards LITERALLY, on both drivers', async () => {
      // escapeLike() in the sqlite driver is load-bearing: without it these
      // searches would match the wrong rows and the two drivers would diverge.
      const pct = await store.createBoard({ title: 'Budget 100% spent' });
      const us = await store.createBoard({ title: 'Under_score and more' });
      const bs = await store.createBoard({ title: 'Back\\slash' });
      const other = await store.createBoard({ title: 'Something else' });

      // "%" is a literal percent sign here, not "match anything".
      const byPct = await store.listBoards({ search: '100%' });
      assert.deepEqual(byPct.boards.map((b) => b.id), [pct.id], '"100%" matches literally');
      assert.equal(byPct.total, 1, 'and total is the FILTERED count');

      // A bare "%" must match ONLY titles that actually contain a percent sign.
      const barePct = await store.listBoards({ search: '%' });
      assert.deepEqual(barePct.boards.map((b) => b.id), [pct.id],
        'a bare % is a literal, not a wildcard matching everything');
      assert.equal(barePct.total, 1);
      assert.ok(!barePct.boards.some((b) => b.id === other.id), 'no false positives');

      // "_" matches one character in SQL LIKE; here it is a literal underscore.
      const byUs = await store.listBoards({ search: 'Under_score' });
      assert.deepEqual(byUs.boards.map((b) => b.id), [us.id], '"_" is a literal underscore');
      assert.equal(byUs.total, 1);

      // A backslash is the LIKE escape character itself.
      const byBs = await store.listBoards({ search: 'Back\\slash' });
      assert.deepEqual(byBs.boards.map((b) => b.id), [bs.id], 'a backslash is a literal');

      for (const id of [pct.id, us.id, bs.id, other.id]) await store.deleteBoard(id);
    });

    test('updateBoard patches title/theme, nulls an unknown board', async () => {
      const b = await store.createBoard({ title: 'Before' });
      const updated = await store.updateBoard(b.id, { title: 'After', theme: 'dark' });
      assert.equal(updated.title, 'After');
      assert.equal(updated.theme, 'dark');
      assert.equal(await store.updateBoard('missing', { title: 'x' }), null);
      await store.deleteBoard(b.id);
    });

    test('deleteBoard reports whether it existed, and cascades', async () => {
      const b = await store.createBoard({ title: 'Doomed' });
      assert.equal(await store.deleteBoard(b.id), true);
      assert.equal(await store.deleteBoard(b.id), false);
      assert.equal(await store.getBoard(b.id), null);
      assert.deepEqual(await store.listElements(b.id), []);
      // A fresh board with the same id must not inherit the old seen_ops.
      const b2 = await store.createBoard({ title: 'Reborn', id: b.id });
      assert.equal(await store.hasOp(b2.id, 'anything'), false);
      await store.deleteBoard(b.id);
    });

    /* --- rule 1: atomic ------------------------------------------------ */

    test('rule 1: a throwing op rolls the WHOLE batch back', async () => {
      const b = await store.createBoard({ title: 'Atomicity' });
      const before = await store.getSnapshot(b.id);

      const batch = [
        create(b.id, rect('keep-me')),   // valid...
        create(b.id, rect('clash', { x: 5 })),
        create(b.id, rect('clash', { x: 9 })), // ...but a duplicate id throws
      ];
      await assert.rejects(() => store.applyOps(b.id, batch), /already exists/i);

      const after = await store.getSnapshot(b.id);
      assert.equal(fingerprint(after), fingerprint(before), 'board is byte-identical');
      assert.equal(after.elements.length, 0, 'the valid op was rolled back too');
      assert.equal(after.rev, before.rev, 'rev did not move');
      await store.deleteBoard(b.id);
    });

    /* --- rule 2: dedupe ------------------------------------------------ */

    test('rule 2: retrying the same opIds is a duplicate and does NOT bump rev', async () => {
      const b = await store.createBoard({ title: 'Dedupe' });
      const ops = [create(b.id, rect('d1')), create(b.id, rect('d2'))];

      const first = await store.applyOps(b.id, ops);
      assert.equal(first.status, 'applied');
      assert.equal(first.rev, 1);
      assert.equal(first.appliedOps.length, 2);

      const retry = await store.applyOps(b.id, ops);
      assert.equal(retry.status, 'duplicate');
      assert.equal(retry.rev, 1, 'rev must not move on a retry');
      assert.deepEqual(retry.appliedOps, []);

      const snap = await store.getSnapshot(b.id);
      assert.equal(snap.rev, 1);
      assert.equal(snap.elements.length, 2, 'nothing was applied twice');
      await store.deleteBoard(b.id);
    });

    test('rule 2: a PARTIAL retry applies, and only the new op takes effect', async () => {
      const b = await store.createBoard({ title: 'Partial retry' });
      const first = create(b.id, rect('p1'));
      const second = create(b.id, rect('p2'));

      await store.applyOps(b.id, [first]);
      assert.equal(await store.hasOp(b.id, first.opId), true);

      // Re-send both: the seen one is a no-op, the unseen one lands.
      const res = await store.applyOps(b.id, [first, second]);
      assert.equal(res.status, 'applied', 'a partial retry is not a duplicate');
      assert.equal(res.rev, 2, 'exactly one rev for the one new op');

      const snap = await store.getSnapshot(b.id);
      assert.deepEqual(snap.elements.map((e) => e.id), ['p1', 'p2']);
      assert.equal(snap.elements.filter((e) => e.id === 'p1').length, 1, 'p1 not doubled');
      await store.deleteBoard(b.id);
    });

    /* --- rule 3: conflict ---------------------------------------------- */

    test('rule 3: a stale baseRev conflicts and the board is byte-identical', async () => {
      const b = await store.createBoard({ title: 'Conflict' });
      await store.applyOps(b.id, [create(b.id, rect('c1'))]);
      const before = await store.getSnapshot(b.id);
      assert.equal(before.rev, 1);

      const res = await store.applyOps(b.id, [
        create(b.id, rect('ghost')), // never lands
        update(b.id, 'c1', { x: 500 }, { baseRev: 0 }), // stale
      ]);

      assert.equal(res.status, 'conflict');
      assert.equal(res.rev, 1, 'the current rev is reported back');
      assert.deepEqual(res.appliedOps, []);
      assert.equal(res.message, 'board moved; resync');

      const after = await store.getSnapshot(b.id);
      assert.equal(fingerprint(after), fingerprint(before), 'byte-identical after a conflict');
      assert.equal(after.rev, 1, 'a rejected batch must NOT bump rev');
      await store.deleteBoard(b.id);
    });

    test('rule 3: a conflict does not poison the retry with the SAME opIds', async () => {
      const b = await store.createBoard({ title: 'Conflict retry' });
      await store.applyOps(b.id, [create(b.id, rect('r1'))]);
      const stale = create(b.id, rect('r2'), { baseRev: 0 });
      assert.equal((await store.applyOps(b.id, [stale])).status, 'conflict');
      // Correct baseRev, same opId: must now be applied, not deduped.
      const retry = await store.applyOps(b.id, [{ ...stale, baseRev: 1 }]);
      assert.equal(retry.status, 'applied');
      assert.equal(retry.rev, 2);
      await store.deleteBoard(b.id);
    });

    test('rule 3: a matching baseRev applies', async () => {
      const b = await store.createBoard({ title: 'Fresh baseRev' });
      const res = await store.applyOps(b.id, [create(b.id, rect('f1'), { baseRev: 0 })]);
      assert.equal(res.status, 'applied');
      assert.equal(res.rev, 1);
      await store.deleteBoard(b.id);
    });

    /* --- rule 4: missing board ---------------------------------------- */

    test('rule 4: applyOps on an unknown board is missing, rev 0', async () => {
      const res = await store.applyOps('ghost-board', [create('ghost-board', rect('m1'))]);
      assert.equal(res.status, 'missing');
      assert.equal(res.rev, 0);
      assert.deepEqual(res.appliedOps, []);
    });

    /* --- rule 5: per-kind ---------------------------------------------- */

    test('create appends to the END of the list (top of z-order)', async () => {
      const b = await store.createBoard({ title: 'Z-order' });
      await store.applyOps(b.id, [create(b.id, rect('bottom'))]);
      await store.applyOps(b.id, [create(b.id, rect('middle'))]);
      await store.applyOps(b.id, [create(b.id, rect('top'))]);
      const els = await store.listElements(b.id);
      assert.deepEqual(els.map((e) => e.id), ['bottom', 'middle', 'top']);
      assert.equal(els[els.length - 1].id, 'top', 'the newest element paints last');
      await store.deleteBoard(b.id);
    });

    test('create with a duplicate id throws and leaves the board unchanged', async () => {
      const b = await store.createBoard({ title: 'Dup' });
      await store.applyOps(b.id, [create(b.id, rect('dup'))]);
      const before = await store.getSnapshot(b.id);
      await assert.rejects(
        () => store.applyOps(b.id, [create(b.id, rect('dup'))]),
        /already exists/i,
      );
      assert.equal(fingerprint(await store.getSnapshot(b.id)), fingerprint(before));
      await store.deleteBoard(b.id);
    });

    test('create re-derives a pen box from its points, ignoring client x/y/w/h', async () => {
      const b = await store.createBoard({ title: 'Pen box' });
      await store.applyOps(b.id, [
        create(b.id, pen('stroke', [{ x: 10, y: 20 }, { x: 40, y: 60 }], {
          x: -999, y: -999, w: 1, h: 1,
        })),
      ]);
      const [el] = await store.listElements(b.id);
      assert.equal(el.x, 10);
      assert.equal(el.y, 20);
      assert.equal(el.w, 30);
      assert.equal(el.h, 40);
      await store.deleteBoard(b.id);
    });

    test('update patches ONLY the named fields and leaves the rest', async () => {
      const b = await store.createBoard({ title: 'Patch' });
      await store.applyOps(b.id, [
        create(b.id, rect('p', { x: 5, y: 6, w: 7, h: 8, stroke: '#ff0000', opacity: 0.5 })),
      ]);
      await store.applyOps(b.id, [update(b.id, 'p', { x: 100, opacity: 0.9 })]);
      const [el] = await store.listElements(b.id);
      assert.equal(el.x, 100, 'patched field changed');
      assert.equal(el.opacity, 0.9, 'patched field changed');
      assert.equal(el.y, 6, 'untouched field kept');
      assert.equal(el.w, 7, 'untouched field kept');
      assert.equal(el.h, 8, 'untouched field kept');
      assert.equal(el.stroke, '#ff0000', 'untouched field kept');
      assert.equal(el.id, 'p', 'identity preserved');
      assert.equal(el.type, 'rect', 'kind preserved');
      await store.deleteBoard(b.id);
    });

    test('update with points recomputes x/y/w/h from the NEW points', async () => {
      const b = await store.createBoard({ title: 'Repen' });
      await store.applyOps(b.id, [
        create(b.id, pen('s', [{ x: 0, y: 0 }, { x: 10, y: 10 }])),
      ]);
      assert.deepEqual(
        (await store.listElements(b.id))[0].points.map((p) => [p.x, p.y]),
        [[0, 0], [10, 10]],
      );

      await store.applyOps(b.id, [
        update(b.id, 's', { points: [{ x: 100, y: 200 }, { x: 140, y: 260 }] }),
      ]);
      const [el] = await store.listElements(b.id);
      assert.equal(el.x, 100, 'x re-derived from the new points');
      assert.equal(el.y, 200);
      assert.equal(el.w, 40);
      assert.equal(el.h, 60);
      assert.deepEqual(el.points, [{ x: 100, y: 200 }, { x: 140, y: 260 }]);
      await store.deleteBoard(b.id);
    });

    test('update re-validates the MERGED element and rejects a bad result', async () => {
      const b = await store.createBoard({ title: 'Bad merge' });
      await store.applyOps(b.id, [
        create(b.id, { id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'hi', fontSize: 20 }),
      ]);
      const before = await store.getSnapshot(b.id);
      // text must stay a string: a non-string would corrupt every render.
      await assert.rejects(() => store.applyOps(b.id, [update(b.id, 't', { text: 42 })]));
      assert.equal(fingerprint(await store.getSnapshot(b.id)), fingerprint(before));
      await store.deleteBoard(b.id);
    });

    test('update of a NON-EXISTENT element is skipped, the batch still applies', async () => {
      const b = await store.createBoard({ title: 'Racing delete' });
      const res = await store.applyOps(b.id, [
        update(b.id, 'never-existed', { x: 999 }), // skipped silently
        create(b.id, rect('survivor')),            // still applied
      ]);
      assert.equal(res.status, 'applied', 'a racing delete is not an error');
      assert.equal(res.rev, 1, 'the batch bumped the rev exactly once');
      const els = await store.listElements(b.id);
      assert.deepEqual(els.map((e) => e.id), ['survivor']);
      await store.deleteBoard(b.id);
    });

    test('delete removes by id; deleting a missing id is a no-op that still bumps rev', async () => {
      const b = await store.createBoard({ title: 'Delete' });
      await store.applyOps(b.id, [create(b.id, rect('x')), create(b.id, rect('y'))]);
      const res = await store.applyOps(b.id, [del(b.id, 'x')]);
      assert.equal(res.status, 'applied');
      assert.deepEqual((await store.listElements(b.id)).map((e) => e.id), ['y']);

      const noop = await store.applyOps(b.id, [del(b.id, 'not-here')]);
      assert.equal(noop.status, 'applied', 'missing delete does not throw');
      assert.equal(noop.rev, 3, 'and it is still a mutation');
      assert.deepEqual((await store.listElements(b.id)).map((e) => e.id), ['y']);
      await store.deleteBoard(b.id);
    });

    test('reorder sets the exact order; unlisted ids keep relative order at the end', async () => {
      const b = await store.createBoard({ title: 'Reorder' });
      await store.applyOps(b.id, [
        create(b.id, rect('a')), create(b.id, rect('b')),
        create(b.id, rect('c')), create(b.id, rect('d')),
      ]);
      // 'd' is NOT mentioned, and 'ghost' does not exist: both must be handled.
      const res = await store.applyOps(b.id, [reorder(b.id, ['c', 'ghost', 'a'])]);
      assert.equal(res.status, 'applied');
      assert.deepEqual(
        (await store.listElements(b.id)).map((e) => e.id),
        ['c', 'a', 'b', 'd'],
        'named ids in order, unknown ignored, unlisted keep relative order at the end',
      );
      await store.deleteBoard(b.id);
    });

    test('reorder with an empty order leaves the list unchanged', async () => {
      const b = await store.createBoard({ title: 'Reorder empty' });
      await store.applyOps(b.id, [create(b.id, rect('a')), create(b.id, rect('b'))]);
      await store.applyOps(b.id, [reorder(b.id, [])]);
      assert.deepEqual((await store.listElements(b.id)).map((e) => e.id), ['a', 'b']);
      await store.deleteBoard(b.id);
    });

    test('clear empties the board and bumps the rev', async () => {
      const b = await store.createBoard({ title: 'Clear' });
      await store.applyOps(b.id, [create(b.id, rect('a')), create(b.id, rect('b'))]);
      const before = await store.getSnapshot(b.id);
      const res = await store.applyOps(b.id, [clear(b.id)]);
      assert.equal(res.status, 'applied');
      assert.equal(res.rev, before.rev + 1);
      assert.deepEqual(res.elements, []);
      assert.deepEqual(await store.listElements(b.id), []);
      await store.deleteBoard(b.id);
    });

    test('clear on an ALREADY-EMPTY board still bumps the rev', async () => {
      const b = await store.createBoard({ title: 'Clear empty' });
      assert.equal((await store.getSnapshot(b.id)).rev, 0);
      const first = await store.applyOps(b.id, [clear(b.id)]);
      assert.equal(first.status, 'applied');
      assert.equal(first.rev, 1, 'a mutation on an empty board is still a mutation');
      const second = await store.applyOps(b.id, [clear(b.id)]);
      assert.equal(second.rev, 2);
      assert.deepEqual(await store.listElements(b.id), []);
      await store.deleteBoard(b.id);
    });

    /* --- rule 6: rev --------------------------------------------------- */

    test('rule 6: a batch of 5 ops bumps the rev by exactly 1', async () => {
      const b = await store.createBoard({ title: 'One bump' });
      const res = await store.applyOps(b.id, [
        create(b.id, rect('n1')), create(b.id, rect('n2')), create(b.id, rect('n3')),
        update(b.id, 'n1', { x: 3 }), reorder(b.id, ['n3']), del(b.id, 'n2'),
      ]);
      assert.equal(res.status, 'applied');
      assert.equal(res.rev, 1, 'per batch, not per op');
      assert.equal((await store.getSnapshot(b.id)).rev, 1);
      await store.deleteBoard(b.id);
    });

    /* --- rule 7: opId recording ---------------------------------------- */

    test('rule 7: every applied opId is recorded and readable via hasOp', async () => {
      const b = await store.createBoard({ title: 'Seen ops' });
      const ops = [create(b.id, rect('s1')), update(b.id, 's1', { x: 2 })];
      await store.applyOps(b.id, ops);
      for (const op of ops) {
        assert.equal(await store.hasOp(b.id, op.opId), true, `${op.opId} recorded`);
      }
      assert.equal(await store.hasOp(b.id, 'never-sent'), false);
      await store.deleteBoard(b.id);
    });

    /* --- limits -------------------------------------------------------- */

    test('exceeding LIMITS.MAX_ELS throws and leaves the board unchanged', async () => {
      const b = await store.createBoard({ title: 'Too many' });
      // Fill to exactly the cap in batches, so the test stays fast.
      const CHUNK = 500;
      for (let i = 0; i < LIMITS.MAX_ELS; i += CHUNK) {
        const batch = [];
        for (let j = i; j < Math.min(i + CHUNK, LIMITS.MAX_ELS); j++) {
          batch.push(create(b.id, rect(`e${j}`)));
        }
        const res = await store.applyOps(b.id, batch);
        assert.equal(res.status, 'applied');
      }
      const before = await store.getSnapshot(b.id);
      assert.equal(before.elements.length, LIMITS.MAX_ELS);

      await assert.rejects(
        () => store.applyOps(b.id, [create(b.id, rect('one-too-many'))]),
        /exceed/i,
      );
      const after = await store.getSnapshot(b.id);
      assert.equal(fingerprint(after), fingerprint(before), 'board unchanged at the cap');
      assert.equal(after.elements.length, LIMITS.MAX_ELS);
      await store.deleteBoard(b.id);
    });

    /* --- connectors ---------------------------------------------------- */

    test('a connector follows the box it is attached to when the box moves', async () => {
      const b = await store.createBoard({ title: 'Connectors' });
      const box = { id: 'box', type: 'rect', x: 0, y: 0, w: 100, h: 100 };
      const a = arrow('link', { x: -60, y: 50 }, { x: 0, y: 50 }, { endId: 'box' });
      await store.applyOps(b.id, [create(b.id, box), create(b.id, a)]);

      // Park the free end somewhere the box never was, so "did the attached end
      // move?" is unambiguous.
      const linkBefore = (await store.listElements(b.id)).find((e) => e.id === 'link');
      const endBefore = linkBefore.points[1];
      assert.equal(endBefore.x, -BIND_GAP, 'the arrow rests just outside the box left edge (x=0)');
      assert.equal(endBefore.y, 50, 'and on its vertical centre');

      await store.applyOps(b.id, [update(b.id, 'box', { x: 300, y: 200 })]);

      const linkAfter = (await store.listElements(b.id)).find((e) => e.id === 'link');
      assert.notDeepEqual(
        linkAfter.points[1], endBefore,
        'the attached endpoint moved with the box',
      );
      // The box now spans x 300..400, y 200..300. The arrow approaches from the
      // left, so it must land ON the left edge, somewhere in the vertical span.
      const endAfter = linkAfter.points[1];
      assert.ok(endAfter.x < 300 && endAfter.x >= 300 - BIND_GAP, `lands just outside the new left edge, got ${endAfter.x}`);
      assert.ok(
        endAfter.y >= 200 && endAfter.y <= 300,
        `lands within the box's vertical span, got ${endAfter.y}`,
      );
      // The free (unattached) end did not move.
      assert.deepEqual(linkAfter.points[0], { x: -60, y: 50 });
      // And the connector's own box is re-derived, not left stale.
      const xs = linkAfter.points.map((p) => p.x);
      const ys = linkAfter.points.map((p) => p.y);
      assert.equal(linkAfter.x, Math.min(...xs));
      assert.equal(linkAfter.y, Math.min(...ys));
      assert.equal(linkAfter.w, Math.max(...xs) - Math.min(...xs));
      assert.equal(linkAfter.h, Math.max(...ys) - Math.min(...ys));
      await store.deleteBoard(b.id);
    });

    test('deleting an attached box does not resurrect the connector', async () => {
      const b = await store.createBoard({ title: 'Orphan' });
      await store.applyOps(b.id, [
        create(b.id, rect('box', { w: 50, h: 50 })),
        create(b.id, arrow('link', { x: 0, y: 0 }, { x: 10, y: 10 }, { startId: 'box' })),
      ]);
      const res = await store.applyOps(b.id, [del(b.id, 'box')]);
      assert.equal(res.status, 'applied');
      const els = await store.listElements(b.id);
      assert.deepEqual(els.map((e) => e.id), ['link']);
      assert.ok(els[0].points.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)),
        'the surviving connector still has usable points');
      // The dangling attachment is DROPPED, not left pointing at a dead id:
      // a permanent startId to a non-existent element is a permanent render
      // bug, and resolveConnectors alone would not clear it.
      assert.equal('startId' in els[0], false, 'the orphan startId was detached');
      assert.ok(els[0].points.every((p) => !Number.isNaN(p.x) && !Number.isNaN(p.y)));
      await store.deleteBoard(b.id);
    });

    /* --- isolation ----------------------------------------------------- */

    test('detaching keeps a LIVE attachment and drops only the dead one', async () => {
      const b = await store.createBoard({ title: 'One dead end' });
      await store.applyOps(b.id, [
        create(b.id, rect('keep', { x: 500, y: 0, w: 20, h: 20 })),
        create(b.id, rect('drop', { x: 0, y: 0, w: 100, h: 100 })),
        create(b.id, arrow('two', { x: -60, y: 50 }, { x: 0, y: 50 }, {
          startId: 'drop', endId: 'keep',
        })),
      ]);
      let link = (await store.listElements(b.id)).find((e) => e.id === 'two');
      assert.equal(link.startId, 'drop', 'starts attached at both ends');
      assert.equal(link.endId, 'keep');

      await store.applyOps(b.id, [del(b.id, 'drop')]);

      link = (await store.listElements(b.id)).find((e) => e.id === 'two');
      assert.equal('startId' in link, false, 'the end pointing at the deleted box is detached');
      assert.equal(link.endId, 'keep', 'the end pointing at the live box is KEPT');
      // The surviving attachment is still resolved: it rests on that box's edge.
      // (It aims at the now-free start, a slightly slanted ray, so it sits
      // BIND_GAP outside the left edge along that ray.)
      const x = link.points[1].x;
      assert.ok(x < 500 && x >= 500 - BIND_GAP, `and the live end still tracks its box, got x=${x}`);
      await store.deleteBoard(b.id);
    });

    /* --- results: applied opIds, original indices ------------------------ */

    test('applied/duplicate results list the batch opIds in `applied`', async () => {
      const b = await store.createBoard({ title: 'Acks' });
      const ops = [create(b.id, rect('k1')), create(b.id, rect('k2'))];
      const first = await store.applyOps(b.id, ops);
      assert.equal(first.status, 'applied');
      assert.deepEqual(first.applied, ops.map((o) => o.opId));
      assert.deepEqual(first.appliedOps.map((o) => o.opId), ops.map((o) => o.opId));

      const retry = await store.applyOps(b.id, ops);
      assert.equal(retry.status, 'duplicate');
      assert.deepEqual(retry.applied, ops.map((o) => o.opId), 'a retry acks the same opIds');
      assert.deepEqual(retry.appliedOps, []);

      // A partial retry: the seen op is acked too, but only the new one applies.
      const fresh = create(b.id, rect('k3'));
      const partial = await store.applyOps(b.id, [ops[0], fresh]);
      assert.equal(partial.status, 'applied');
      assert.deepEqual(partial.applied, [ops[0].opId, fresh.opId]);
      assert.deepEqual(partial.appliedOps.map((o) => o.opId), [fresh.opId]);
      await store.deleteBoard(b.id);
    });

    test('conflict and missing results carry an empty `applied`', async () => {
      const b = await store.createBoard({ title: 'No acks' });
      await store.applyOps(b.id, [create(b.id, rect('m1'))]);
      const conflict = await store.applyOps(b.id, [create(b.id, rect('m2'), { baseRev: 0 })]);
      assert.equal(conflict.status, 'conflict');
      assert.deepEqual(conflict.applied, []);
      const missing = await store.applyOps('no-such-board', [create('x', rect('m3'))]);
      assert.equal(missing.status, 'missing');
      assert.deepEqual(missing.applied, []);
      await store.deleteBoard(b.id);
    });

    test('appliedOps are the ops as sent (actorId filled), with no internal fields', async () => {
      const b = await store.createBoard({ title: 'Clean ops' });
      const res = await store.applyOps(b.id, [create(b.id, rect('c9'))], 'peer-7');
      const [op] = res.appliedOps;
      assert.equal(op.actorId, 'peer-7');
      assert.equal(op.kind, 'create');
      assert.equal('index' in op, false);
      await store.deleteBoard(b.id);
    });

    test('an error names the op index AS SENT, even after dedupe dropped some', async () => {
      const b = await store.createBoard({ title: 'Indices' });
      const seen = create(b.id, rect('dup'));
      await store.applyOps(b.id, [seen]);
      // ops[0] is already seen and skipped; the duplicate id is ops[2].
      await assert.rejects(
        () => store.applyOps(b.id, [seen, create(b.id, rect('ok')), create(b.id, rect('dup'))]),
        (err) => err.code === 'DUPLICATE_ELEMENT' && /ops\[2\]/.test(err.message),
      );
      await store.deleteBoard(b.id);
    });

    /* --- the Excalidraw-style model through the store ------------------- */

    test('new fields persist through create AND update, on this driver', async () => {
      const b = await store.createBoard({ title: 'Styles' });
      const styled = {
        seed: 12345, roughness: 2, fillStyle: 'cross-hatch', roundness: 'round',
        fontFamily: 'code', fontSize: 28, align: 'right', label: 'Olá, mundo',
      };
      await store.applyOps(b.id, [
        create(b.id, rect('shape', styled)),
        create(b.id, rect('plain')),
        create(b.id, arrow('conn', { x: 0, y: 0 }, { x: 5, y: 5 }, { startArrowhead: 'dot', endArrowhead: 'triangle' })),
      ]);
      let els = await store.listElements(b.id);
      const shape = els.find((e) => e.id === 'shape');
      for (const [k, v] of Object.entries(styled)) assert.deepEqual(shape[k], v, `create kept ${k}`);
      const conn = els.find((e) => e.id === 'conn');
      assert.deepEqual([conn.startArrowhead, conn.endArrowhead], ['dot', 'triangle']);

      // The same fields arrive as an UPDATE (through validateOps, as the routes do).
      const ops = validateOps([
        update(b.id, 'plain', styled),
        update(b.id, 'conn', { startArrowhead: 'bar', endArrowhead: 'none', roughness: 0 }),
      ]);
      const res = await store.applyOps(b.id, ops);
      assert.equal(res.status, 'applied');
      els = await store.listElements(b.id);
      const plain = els.find((e) => e.id === 'plain');
      for (const [k, v] of Object.entries(styled)) assert.deepEqual(plain[k], v, `update kept ${k}`);
      const conn2 = els.find((e) => e.id === 'conn');
      assert.deepEqual([conn2.startArrowhead, conn2.endArrowhead, conn2.roughness], ['bar', 'none', 0]);

      // label: null removes a shape label.
      await store.applyOps(b.id, validateOps([update(b.id, 'plain', { label: null })]));
      els = await store.listElements(b.id);
      assert.equal('label' in els.find((e) => e.id === 'plain'), false);
      await store.deleteBoard(b.id);
    });

    test('startId: null UNBINDS on the server; the dragged-off end stays where it was put', async () => {
      const b = await store.createBoard({ title: 'Unbind' });
      await store.applyOps(b.id, [
        create(b.id, rect('box', { x: 0, y: 0, w: 100, h: 100 })),
        create(b.id, arrow('link', { x: 50, y: 50 }, { x: 400, y: 50 }, { startId: 'box' })),
      ]);
      let link = (await store.listElements(b.id)).find((e) => e.id === 'link');
      assert.deepEqual(link.points[0], { x: 100 + BIND_GAP, y: 50 }, 'bound: snapped onto the box');

      // The user drags the start off the box: the client sends the new point
      // AND startId: null in one patch. The server must not snap it back.
      const ops = validateOps([update(b.id, 'link', { startId: null, points: [{ x: -300, y: 400 }, { x: 400, y: 50 }] })]);
      await store.applyOps(b.id, ops);
      link = (await store.listElements(b.id)).find((e) => e.id === 'link');
      assert.equal('startId' in link, false, 'the binding is gone');
      assert.deepEqual(link.points[0], { x: -300, y: 400 }, 'and the end is where the user left it');

      // Moving the box no longer drags the unbound end along.
      await store.applyOps(b.id, [update(b.id, 'box', { x: 500 })]);
      link = (await store.listElements(b.id)).find((e) => e.id === 'link');
      assert.deepEqual(link.points[0], { x: -300, y: 400 });

      // groupId: null leaves a group, the same way.
      await store.applyOps(b.id, [update(b.id, 'box', { groupId: 'g1' })]);
      await store.applyOps(b.id, validateOps([update(b.id, 'box', { groupId: null })]));
      assert.equal('groupId' in (await store.listElements(b.id)).find((e) => e.id === 'box'), false);
      await store.deleteBoard(b.id);
    });

    test('a multi-point connector: moving a bound shape moves ONLY the end points', async () => {
      const b = await store.createBoard({ title: 'Elbow' });
      const pts = [{ x: 50, y: 50 }, { x: 50, y: 300 }, { x: 350, y: 300 }, { x: 350, y: 50 }];
      await store.applyOps(b.id, [
        create(b.id, rect('from', { x: 0, y: 0, w: 100, h: 100 })),
        create(b.id, { id: 'to', type: 'ellipse', x: 300, y: 0, w: 100, h: 100 }),
        create(b.id, { id: 'elbow', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: pts, startId: 'from', endId: 'to' }),
      ]);
      let elbow = (await store.listElements(b.id)).find((e) => e.id === 'elbow');
      assert.equal(elbow.points.length, 4);
      assert.deepEqual(elbow.points[0], { x: 50, y: 100 + BIND_GAP });
      assert.deepEqual(elbow.points.slice(1, 3), pts.slice(1, 3));

      await store.applyOps(b.id, [update(b.id, 'from', { x: -40, y: 20 })]);
      elbow = (await store.listElements(b.id)).find((e) => e.id === 'elbow');
      assert.deepEqual(elbow.points.slice(1, 3), pts.slice(1, 3), 'interior points never move');
      // The box now spans y 20..120; the start aims at (50,300), a slanted ray,
      // so it sits just below the bottom edge, at most BIND_GAP below it.
      const y = elbow.points[0].y;
      assert.ok(y > 120 && y <= 120 + BIND_GAP, `the start rides the moved box bottom edge, got y=${y}`);
      // And a no-op batch leaves the stored connector byte-identical (idempotent).
      const before = JSON.stringify(await store.listElements(b.id));
      await store.applyOps(b.id, [update(b.id, 'to', {})]);
      assert.equal(JSON.stringify(await store.listElements(b.id)), before);
      await store.deleteBoard(b.id);
    });

    test('listElements returns a copy: mutating it cannot corrupt the board', async () => {
      const b = await store.createBoard({ title: 'Immutability' });
      await store.applyOps(b.id, [create(b.id, rect('i1'))]);
      const els = await store.listElements(b.id);
      els[0].x = 12345;
      els.push(rect('smuggled'));
      const fresh = await store.listElements(b.id);
      assert.equal(fresh.length, 1);
      assert.equal(fresh[0].x, 0);
      await store.deleteBoard(b.id);
    });

    test('clearBoard empties, bumps rev, and is a no-op on a missing board', async () => {
      const b = await store.createBoard({ title: 'clearBoard' });
      await store.applyOps(b.id, [create(b.id, rect('c1'))]);
      const rev = await store.clearBoard(b.id);
      assert.equal(rev, 2);
      assert.deepEqual(await store.listElements(b.id), []);
      assert.equal(await store.clearBoard('no-such-board'), 0);
      await store.deleteBoard(b.id);
    });

    /* --- close --------------------------------------------------------- */

    test('close() resolves, and later calls reject instead of crashing', async () => {
      const closed = driver.make();
      const b = await closed.createBoard({ title: 'Doomed store' });
      await closed.close();
      await closed.close(); // idempotent

      await assert.rejects(() => closed.getBoard(b.id), /closed/i);
      await assert.rejects(() => closed.getSnapshot(b.id), /closed/i);
      await assert.rejects(() => closed.listElements(b.id), /closed/i);
      await assert.rejects(() => closed.listBoards(), /closed/i);
      await assert.rejects(() => closed.applyOps(b.id, []), /closed/i);
      await assert.rejects(() => closed.hasOp(b.id, 'x'), /closed/i);
      await assert.rejects(() => closed.createBoard({ title: 'x' }), /closed/i);
      await assert.rejects(() => closed.deleteBoard(b.id), /closed/i);
      await assert.rejects(() => closed.clearBoard(b.id), /closed/i);
      // Still alive: the process was not taken down by the rejections.
      assert.ok(true);
    });
  });
}

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});
