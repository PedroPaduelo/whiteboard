/**
 * The validation rules the store depends on.
 *
 * `validateElement` is what makes the store's "re-validate the MERGED result"
 * step meaningful, so this suite is really testing the store's safety net: a
 * merge that produces an invalid element must throw, not be stored.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateElement,
  tryValidateElement,
  validateOps,
  tryValidateOps,
  LIMITS,
  ELEMENT_TYPES,
} from '@whiteboard/shared';

/** One valid instance of each of the ten element types. */
const SAMPLES = {
  rect: { id: 'r1', type: 'rect', x: 1, y: 2, w: 3, h: 4 },
  ellipse: { id: 'e1', type: 'ellipse', x: 1, y: 2, w: 3, h: 4 },
  diamond: { id: 'd1', type: 'diamond', x: 1, y: 2, w: 3, h: 4 },
  cylinder: { id: 'c1', type: 'cylinder', x: 1, y: 2, w: 3, h: 4 },
  sticky: { id: 's1', type: 'sticky', x: 1, y: 2, w: 3, h: 4, label: 'note' },
  text: { id: 't1', type: 'text', x: 1, y: 2, w: 3, h: 4, text: 'hello', fontSize: 24 },
  arrow: {
    id: 'a1', type: 'arrow', x: 0, y: 0, w: 0, h: 0,
    points: [{ x: 0, y: 0 }, { x: 10, y: 5 }],
  },
  line: {
    id: 'l1', type: 'line', x: 0, y: 0, w: 0, h: 0,
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }],
  },
  pen: {
    id: 'p1', type: 'pen', x: 0, y: 0, w: 0, h: 0,
    points: [{ x: 0, y: 0 }, { x: 4, y: 9 }, { x: 9, y: 1 }],
  },
  image: {
    id: 'i1', type: 'image', x: 0, y: 0, w: 64, h: 64,
    src: 'https://example.com/a.png', naturalWidth: 64, naturalHeight: 64,
  },
};

describe('validateElement', () => {
  test('SAMPLES covers every element type exactly once', () => {
    assert.deepEqual(Object.keys(SAMPLES).sort(), [...ELEMENT_TYPES].sort());
  });

  for (const [type, sample] of Object.entries(SAMPLES)) {
    test(`${type}: a valid element round-trips with its id and type`, () => {
      const out = validateElement(sample);
      assert.equal(out.id, sample.id);
      assert.equal(out.type, type);
    });
  }

  test('shapes round-trip their box and keep optional style fields', () => {
    const out = validateElement({
      id: 'styled', type: 'rect', x: 5, y: 6, w: 7, h: 8,
      rotation: 0.5, stroke: '#ff0000', fill: 'none',
      strokeWidth: 3, strokeStyle: 'dashed', opacity: 0.5,
      authorId: 'peer-1', createdAt: 10, updatedAt: 20,
    });
    assert.deepEqual(
      { x: out.x, y: out.y, w: out.w, h: out.h },
      { x: 5, y: 6, w: 7, h: 8 },
    );
    assert.equal(out.rotation, 0.5);
    assert.equal(out.stroke, '#ff0000');
    assert.equal(out.fill, 'none');
    assert.equal(out.strokeWidth, 3);
    assert.equal(out.strokeStyle, 'dashed');
    assert.equal(out.opacity, 0.5);
    assert.equal(out.authorId, 'peer-1');
  });

  test('a pen stroke has its box RE-DERIVED from its points', () => {
    const out = validateElement({
      id: 'pen', type: 'pen', x: -999, y: -999, w: 1, h: 1,
      points: [{ x: 10, y: 20 }, { x: 40, y: 60 }],
    });
    assert.deepEqual([out.x, out.y, out.w, out.h], [10, 20, 30, 40]);
  });

  test('a connector reboxes from its two points and may have h === 0', () => {
    const out = validateElement({
      id: 'flat', type: 'line', x: 0, y: 0, w: 0, h: 0,
      points: [{ x: 5, y: 9 }, { x: 25, y: 9 }],
    });
    assert.deepEqual([out.x, out.y, out.w, out.h], [5, 9, 20, 0]);
    assert.equal(out.h, 0, 'a horizontal line is legal');
  });

  test('a connector keeps startId/endId attachments', () => {
    const out = validateElement({
      id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1,
      points: [{ x: 0, y: 0 }, { x: 1, y: 1 }],
      startId: 'box1', endId: 'box2',
    });
    assert.equal(out.startId, 'box1');
    assert.equal(out.endId, 'box2');
  });

  test('a sticky defaults its fill when none was given', () => {
    const out = validateElement({ id: 'st', type: 'sticky', x: 0, y: 0, w: 1, h: 1, label: 'x' });
    assert.equal(out.fill, '#fde68a');
  });

  test('an accepted data:image src is preserved', () => {
    const src = 'data:image/png;base64,iVBORw0KGgo=';
    const out = validateElement({ id: 'img', type: 'image', x: 0, y: 0, w: 1, h: 1, src });
    assert.equal(out.src, src);
  });

  test('unknown fields are STRIPPED, not rejected', () => {
    const out = validateElement({
      id: 'u', type: 'rect', x: 0, y: 0, w: 1, h: 1, somethingNew: 'keep out',
    });
    assert.equal('somethingNew' in out, false);
  });
});

describe('validateElement rejection paths', () => {
  const rejects = (raw, label) => {
    test(label, () => {
      assert.throws(() => validateElement(raw), /:/, 'must throw');
    });
  };

  rejects(null, 'a missing element throws');
  rejects('nope', 'a non-object throws');
  rejects([], 'an array throws');
  rejects({ type: 'rect', x: 0, y: 0, w: 1, h: 1 }, 'a missing id throws');
  rejects({ id: '', type: 'rect', x: 0, y: 0, w: 1, h: 1 }, 'an empty id throws');
  rejects({ id: 'x'.repeat(LIMITS.MAX_ID + 1), type: 'rect', x: 0, y: 0, w: 1, h: 1 },
    'an oversized id throws');
  rejects({ id: 'a', type: 'blob', x: 0, y: 0, w: 1, h: 1 }, 'a bad type throws');
  rejects({ id: 'a', type: undefined, x: 0, y: 0, w: 1, h: 1 }, 'a missing type throws');

  rejects({ id: 'a', type: 'rect', x: NaN, y: 0, w: 1, h: 1 }, 'a NaN x throws');
  rejects({ id: 'a', type: 'rect', x: Infinity, y: 0, w: 1, h: 1 }, 'an infinite x throws');
  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: '10' }, 'a string w throws');
  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1 }, 'a missing h throws');

  rejects({ id: 'a', type: 'pen', x: 0, y: 0, w: 1, h: 1, points: [] },
    'an empty points array throws');
  rejects({ id: 'a', type: 'pen', x: 0, y: 0, w: 1, h: 1, points: 'nope' },
    'non-array points throws');
  rejects(
    { id: 'a', type: 'pen', x: 0, y: 0, w: 1, h: 1, points: new Array(LIMITS.MAX_POINTS + 1).fill({ x: 1, y: 1 }) },
    'an oversized points array throws',
  );
  rejects(
    { id: 'a', type: 'pen', x: 0, y: 0, w: 1, h: 1, points: [{ x: 1, y: Number.NaN }] },
    'a non-finite point coordinate throws',
  );

  rejects({ id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }] },
    'a connector with 3 points throws');
  rejects({ id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1, points: [{ x: 0, y: 0 }] },
    'a connector with 1 point throws');

  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 42 },
    'non-string text throws');
  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'x'.repeat(LIMITS.MAX_TEXT + 1) },
    'oversized text throws');
  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'x', fontSize: 2 },
    'a tiny fontSize throws');
  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'x', fontSize: 9999 },
    'a huge fontSize throws');
  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'x', align: 'justify' },
    'a bad align throws');

  rejects({ id: 'a', type: 'sticky', x: 0, y: 0, w: 1, h: 1, label: 42 },
    'a non-string sticky label throws');
  rejects({ id: 'a', type: 'sticky', x: 0, y: 0, w: 1, h: 1 },
    'a missing sticky label throws');

  rejects({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, src: '' },
    'an empty image src throws');
  rejects({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)' },
    'a javascript: image src throws');
  rejects({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'http://insecure.example.com/a.png' },
    'a plain http image src throws');
  rejects({ id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'data:text/html;base64,PHNjcmlwdD4=' },
    'a data:text/html src throws');

  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1, opacity: 2 },
    'an opacity above 1 throws');
  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1, strokeWidth: -1 },
    'a negative strokeWidth throws');
  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1, strokeStyle: 'wobbly' },
    'a bad strokeStyle throws');
  rejects({ id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1, stroke: 'not-a-colour!!' },
    'a malformed colour throws');
});

describe('tryValidateElement', () => {
  test('returns {valid:true, element} for a good element', () => {
    const res = tryValidateElement(SAMPLES.rect);
    assert.equal(res.valid, true);
    assert.equal(res.element.id, 'r1');
  });

  test('returns {valid:false} instead of throwing for a bad element', () => {
    const res = tryValidateElement({ type: 'rect', x: 0, y: 0, w: 1, h: 1 });
    assert.equal(res.valid, false);
    assert.equal(typeof res.error, 'string');
    assert.equal(typeof res.path, 'string');
    assert.ok(res.path.length > 0);
  });

  test('every rejection path is catchable, not fatal', () => {
    for (const bad of [null, 'nope', [], { type: 'blob' },
      { id: 'a', type: 'image', x: 0, y: 0, w: 1, h: 1, src: 'javascript:alert(1)' }]) {
      const res = tryValidateElement(bad);
      assert.equal(res.valid, false);
      assert.equal(res.element, undefined);
    }
  });
});

describe('validateOps', () => {
  const base = { opId: 'o1', boardId: 'b1' };

  test('accepts a well-formed batch of every kind', () => {
    const ops = validateOps([
      { ...base, opId: 'o1', kind: 'create', element: SAMPLES.rect },
      { ...base, opId: 'o2', kind: 'update', elementId: 'r1', patch: { x: 4, y: 5 } },
      { ...base, opId: 'o3', kind: 'delete', elementId: 'r1' },
      { ...base, opId: 'o4', kind: 'reorder', order: ['r1', 'r2'] },
      { ...base, opId: 'o5', kind: 'clear' },
    ]);
    assert.equal(ops.length, 5);
    assert.deepEqual(ops.map((o) => o.kind), ['create', 'update', 'delete', 'reorder', 'clear']);
  });

  test('carries baseRev and actorId through', () => {
    const [op] = validateOps([{ ...base, kind: 'clear', baseRev: 7, actorId: 'peer-9' }]);
    assert.equal(op.baseRev, 7);
    assert.equal(op.actorId, 'peer-9');
  });

  test('rejects a non-array', () => {
    assert.throws(() => validateOps('nope'), /ops/);
  });

  test('rejects an oversized batch and names the index of the first bad op', () => {
    const many = new Array(LIMITS.MAX_OPS_PER_BATCH + 1).fill({ ...base, kind: 'clear' });
    assert.throws(() => validateOps(many), /ops/);
    assert.throws(
      () => validateOps([{ ...base, kind: 'clear' }, { ...base, kind: 'nope' }]),
      /ops\[1\]/,
    );
  });

  test('rejects a missing opId and a bad kind', () => {
    assert.throws(() => validateOps([{ boardId: 'b1', kind: 'clear' }]), /opId/);
    assert.throws(() => validateOps([{ ...base, kind: 'destroy' }]), /kind/);
  });

  test('rejects a patch that changes id or type', () => {
    assert.throws(
      () => validateOps([{ ...base, kind: 'update', elementId: 'r1', patch: { id: 'other' } }]),
      /must not change id/,
    );
    assert.throws(
      () => validateOps([{ ...base, kind: 'update', elementId: 'r1', patch: { type: 'ellipse' } }]),
      /must not change type/,
    );
  });

  test('strips unknown patch keys rather than smuggling them in', () => {
    const [op] = validateOps([
      { ...base, kind: 'update', elementId: 'r1', patch: { x: 1, evil: 'no' } },
    ]);
    assert.equal(op.patch.x, 1);
    assert.equal('evil' in op.patch, false);
  });

  test('requires elementId for update and delete, order for reorder', () => {
    assert.throws(() => validateOps([{ ...base, kind: 'update' }]), /elementId/);
    assert.throws(() => validateOps([{ ...base, kind: 'delete' }]), /elementId/);
    assert.throws(() => validateOps([{ ...base, kind: 'reorder' }]), /order/);
  });

  test('a non-array patch throws', () => {
    assert.throws(
      () => validateOps([{ ...base, kind: 'update', elementId: 'r1', patch: [1] }]),
      /patch/,
    );
  });

  test('tryValidateOps reports invalid without throwing', () => {
    assert.equal(tryValidateOps([{ ...base, kind: 'clear' }]).valid, true);
    assert.equal(tryValidateOps([{ boardId: 'b', kind: 'clear' }]).valid, false);
  });
});
