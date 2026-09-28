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
  FILL_STYLES,
  ROUNDNESS,
  FONT_FAMILY_KEYS,
  TEXT_ALIGNS,
  ARROWHEADS,
  SEED_MAX,
  NULLABLE_PATCH_KEYS,
  TOOLS,
  DRAWING_TOOLS,
  WS_MSG,
  OP_RESULT,
  elementTypeForTool,
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

  rejects({ id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1, points: [{ x: 0, y: 0 }] },
    'a connector with 1 point throws');
  rejects({ id: 'a', type: 'line', x: 0, y: 0, w: 1, h: 1, points: [{ x: 0, y: 0 }] },
    'a line with 1 point throws');
  rejects({ id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1, points: [] },
    'a connector with no points throws');
  rejects(
    { id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1, points: new Array(LIMITS.MAX_POINTS + 1).fill({ x: 1, y: 1 }) },
    'a connector over MAX_POINTS throws',
  );
  rejects({ id: 'a', type: 'arrow', x: 0, y: 0, w: 1, h: 1,
    points: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 'far' }] },
    'a bad interior connector point throws');

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

  // --- the hand-drawn fields reject bad values (they are never coerced) ---
  const r = { id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1 };
  rejects({ ...r, seed: -1 }, 'a negative seed throws');
  rejects({ ...r, seed: 1.5 }, 'a fractional seed throws');
  rejects({ ...r, seed: SEED_MAX + 1 }, 'a seed past 2^31-1 throws');
  rejects({ ...r, seed: '42' }, 'a string seed throws');
  rejects({ ...r, roughness: 2.5 }, 'roughness above 2 throws');
  rejects({ ...r, roughness: -0.1 }, 'negative roughness throws');
  rejects({ ...r, roughness: NaN }, 'NaN roughness throws');
  rejects({ ...r, fillStyle: 'dots' }, 'an unknown fillStyle throws');
  rejects({ ...r, roundness: 'very' }, 'an unknown roundness throws');
  rejects({ ...r, roundness: 12 }, 'a numeric roundness throws');
  rejects({ ...r, fontFamily: 'comic' }, 'an unknown fontFamily on a shape throws');
  rejects({ ...r, fontSize: 3 }, 'a tiny fontSize on a shape throws');
  rejects({ ...r, fontSize: 600 }, 'a huge fontSize on a shape throws');
  rejects({ ...r, align: 'justify' }, 'a bad align on a shape throws');
  rejects({ ...r, label: 42 }, 'a non-string shape label throws');
  rejects({ ...r, label: 'x'.repeat(LIMITS.MAX_LABEL + 1) }, 'an oversized shape label throws');
  rejects({ id: 'a', type: 'sticky', x: 0, y: 0, w: 1, h: 1, label: 'x', fontFamily: 'serif' },
    'an unknown fontFamily on a sticky throws');
  rejects({ id: 'a', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'x', fontFamily: 'serif' },
    'an unknown fontFamily on a text throws');
  rejects({ ...SAMPLES.arrow, startArrowhead: 'star' }, 'an unknown startArrowhead throws');
  rejects({ ...SAMPLES.line, endArrowhead: 'x' }, 'an unknown endArrowhead throws');
});

describe('validateElement: the Excalidraw-style fields', () => {
  test('seed, roughness, fillStyle and roundness are kept on EVERY type', () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const out = validateElement({
        ...sample, seed: 123456, roughness: 2, fillStyle: 'cross-hatch', roundness: 'round',
      });
      assert.equal(out.seed, 123456, type);
      assert.equal(out.roughness, 2, type);
      assert.equal(out.fillStyle, 'cross-hatch', type);
      assert.equal(out.roundness, 'round', type);
    }
  });

  test('the full range of each enum and bound is accepted', () => {
    for (const fillStyle of FILL_STYLES) assert.equal(validateElement({ ...SAMPLES.rect, fillStyle }).fillStyle, fillStyle);
    for (const roundness of ROUNDNESS) assert.equal(validateElement({ ...SAMPLES.rect, roundness }).roundness, roundness);
    for (const fontFamily of FONT_FAMILY_KEYS) assert.equal(validateElement({ ...SAMPLES.text, fontFamily }).fontFamily, fontFamily);
    for (const align of TEXT_ALIGNS) assert.equal(validateElement({ ...SAMPLES.ellipse, align }).align, align);
    for (const head of ARROWHEADS) {
      const out = validateElement({ ...SAMPLES.arrow, startArrowhead: head, endArrowhead: head });
      assert.equal(out.startArrowhead, head);
      assert.equal(out.endArrowhead, head);
    }
    for (const seed of [0, 1, SEED_MAX]) assert.equal(validateElement({ ...SAMPLES.rect, seed }).seed, seed);
    for (const roughness of [0, 0.5, 1, 2]) assert.equal(validateElement({ ...SAMPLES.rect, roughness }).roughness, roughness);
  });

  test('shapes carry a label with its own font styling', () => {
    for (const type of ['rect', 'ellipse', 'diamond', 'cylinder']) {
      const out = validateElement({
        ...SAMPLES[type], label: 'Olá', fontFamily: 'code', fontSize: 28, align: 'right',
      });
      assert.equal(out.label, 'Olá', type);
      assert.equal(out.fontFamily, 'code', type);
      assert.equal(out.fontSize, 28, type);
      assert.equal(out.align, 'right', type);
    }
  });

  test('a shape gets NO fontSize default, a text still defaults to 24', () => {
    assert.equal('fontSize' in validateElement(SAMPLES.rect), false);
    assert.equal('fontSize' in validateElement(SAMPLES.sticky), false);
    const { fontSize, ...noSize } = SAMPLES.text;
    assert.equal(validateElement(noSize).fontSize, 24);
  });

  test('a sticky keeps fontFamily, fontSize and align', () => {
    const out = validateElement({ ...SAMPLES.sticky, fontFamily: 'normal', fontSize: 16, align: 'center' });
    assert.deepEqual([out.fontFamily, out.fontSize, out.align], ['normal', 16, 'center']);
  });

  test('arrows and lines carry arrowheads', () => {
    const a = validateElement({ ...SAMPLES.arrow, startArrowhead: 'dot', endArrowhead: 'triangle' });
    assert.deepEqual([a.startArrowhead, a.endArrowhead], ['dot', 'triangle']);
    const l = validateElement({ ...SAMPLES.line, startArrowhead: 'bar', endArrowhead: 'none' });
    assert.deepEqual([l.startArrowhead, l.endArrowhead], ['bar', 'none']);
  });

  test('a multi-point connector keeps every point in order and reboxes from all of them', () => {
    const points = [{ x: 0, y: 0 }, { x: 50, y: -20 }, { x: 80, y: 40 }, { x: 10, y: 90 }, { x: -30, y: 5 }];
    const out = validateElement({ ...SAMPLES.arrow, points, startId: 's', endId: 'e' });
    assert.deepEqual(out.points, points);
    assert.deepEqual([out.x, out.y, out.w, out.h], [-30, -20, 110, 110]);
    assert.equal(out.startId, 's');
    assert.equal(out.endId, 'e');
    // The points are copies: the caller's array can never alias the stored one.
    assert.notEqual(out.points, points);
    assert.notEqual(out.points[0], points[0]);
  });

  test('a connector with exactly MAX_POINTS points is accepted', () => {
    const points = Array.from({ length: LIMITS.MAX_POINTS }, (_, i) => ({ x: i, y: i % 7 }));
    assert.equal(validateElement({ ...SAMPLES.line, points }).points.length, LIMITS.MAX_POINTS);
  });

  test('fields on a type that does not use them are STRIPPED, not rejected', () => {
    const pen = validateElement({
      ...SAMPLES.pen, label: 'x', fontFamily: 'comic', fontSize: 1, align: 'weird',
      startArrowhead: 'star', text: 'nope',
    });
    for (const k of ['label', 'fontFamily', 'fontSize', 'align', 'startArrowhead', 'text']) {
      assert.equal(k in pen, false, `pen must not keep ${k}`);
    }
    const rect = validateElement({ ...SAMPLES.rect, startArrowhead: 'arrow', endArrowhead: 'arrow', points: [] });
    assert.equal('startArrowhead' in rect, false);
    assert.equal('points' in rect, false);
    const image = validateElement({ ...SAMPLES.image, label: 'caption', fontFamily: 'hand' });
    assert.equal('label' in image, false);
    assert.equal('fontFamily' in image, false);
  });

  test('a legacy element (none of the new fields) is still valid and gains nothing', () => {
    for (const [type, sample] of Object.entries(SAMPLES)) {
      const out = validateElement(sample);
      for (const k of ['seed', 'roughness', 'fillStyle', 'roundness', 'fontFamily', 'startArrowhead', 'endArrowhead']) {
        assert.equal(k in out, false, `${type} must not gain ${k}`);
      }
      if (type !== 'sticky') assert.equal('label' in out, false, `${type} must not gain a label`);
    }
  });

  test('null optional fields are treated as absent', () => {
    const out = validateElement({
      ...SAMPLES.arrow, seed: null, roughness: null, fillStyle: null, roundness: null,
      startArrowhead: null, endArrowhead: null, startId: null, endId: null, groupId: null,
    });
    for (const k of ['seed', 'roughness', 'fillStyle', 'roundness', 'startArrowhead', 'endArrowhead', 'startId', 'endId', 'groupId']) {
      assert.equal(k in out, false, `${k}: null means absent`);
    }
    assert.equal('label' in validateElement({ ...SAMPLES.rect, label: null }), false);
  });
});

describe('shared enums and protocol constants', () => {
  test('the style enums are exported, frozen, and match the contract', () => {
    assert.deepEqual([...FILL_STYLES], ['hachure', 'cross-hatch', 'solid', 'zigzag']);
    assert.deepEqual([...ROUNDNESS], ['sharp', 'round']);
    assert.deepEqual([...FONT_FAMILY_KEYS], ['hand', 'normal', 'code']);
    assert.deepEqual([...TEXT_ALIGNS], ['left', 'center', 'right']);
    assert.deepEqual([...ARROWHEADS], ['none', 'arrow', 'triangle', 'bar', 'dot']);
    assert.equal(SEED_MAX, 2 ** 31 - 1);
    for (const list of [FILL_STYLES, ROUNDNESS, FONT_FAMILY_KEYS, TEXT_ALIGNS, ARROWHEADS]) {
      assert.ok(Object.isFrozen(list));
    }
  });

  test('TOOLS gains image and keeps every existing tool', () => {
    for (const t of ['select', 'hand', 'pen', 'rect', 'ellipse', 'diamond', 'cylinder', 'sticky', 'text', 'arrow', 'line', 'eraser']) {
      assert.ok(TOOLS.includes(t), t);
    }
    assert.ok(TOOLS.includes('image'));
    assert.ok(DRAWING_TOOLS.includes('image'));
    assert.equal(elementTypeForTool('image'), 'image');
    assert.equal(elementTypeForTool('eraser'), null);
    for (const t of DRAWING_TOOLS) assert.ok(ELEMENT_TYPES.includes(t), `${t} is an element type`);
  });

  test('WS_MSG.BOARD and the new OP_RESULT statuses exist', () => {
    assert.equal(WS_MSG.BOARD, 'board');
    assert.equal(WS_MSG.ERROR, 'error');
    assert.equal(OP_RESULT.APPLIED, 'applied');
    assert.equal(OP_RESULT.DUPLICATE, 'duplicate');
    assert.equal(OP_RESULT.CONFLICT, 'conflict');
    assert.equal(OP_RESULT.MISSING, 'missing');
    assert.equal(OP_RESULT.ERROR, 'error');
    // Envelope types must stay unique, or a handler would catch the wrong one.
    assert.equal(new Set(Object.values(WS_MSG)).size, Object.values(WS_MSG).length);
  });
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

  test('every Excalidraw-style field is patchable', () => {
    const patch = {
      seed: 99, roughness: 0, fillStyle: 'zigzag', roundness: 'sharp', fontFamily: 'code',
      fontSize: 36, align: 'center', label: 'Oi', startArrowhead: 'triangle', endArrowhead: 'dot',
    };
    const [op] = validateOps([{ ...base, kind: 'update', elementId: 'r1', patch }]);
    assert.deepEqual(op.patch, patch);
  });

  test('startId, endId, groupId and label accept null (null = remove the field)', () => {
    assert.deepEqual([...NULLABLE_PATCH_KEYS].sort(), ['endId', 'groupId', 'label', 'startId']);
    const [op] = validateOps([{
      ...base, kind: 'update', elementId: 'a1',
      patch: { startId: null, endId: null, groupId: null, label: null },
    }]);
    assert.deepEqual(op.patch, { startId: null, endId: null, groupId: null, label: null });
  });

  test('a bound id in a patch is still validated', () => {
    const [op] = validateOps([{ ...base, kind: 'update', elementId: 'a1', patch: { startId: 'box', endId: 'box2' } }]);
    assert.deepEqual(op.patch, { startId: 'box', endId: 'box2' });
    assert.throws(() => validateOps([{ ...base, kind: 'update', elementId: 'a1', patch: { startId: '' } }]), /startId/);
    assert.throws(() => validateOps([{ ...base, kind: 'update', elementId: 'a1', patch: { endId: 7 } }]), /endId/);
    assert.throws(
      () => validateOps([{ ...base, kind: 'update', elementId: 'a1', patch: { groupId: 'g'.repeat(LIMITS.MAX_ID + 1) } }]),
      /groupId/,
    );
  });

  test('bad values in the new patch fields are rejected, naming the field', () => {
    const bad = {
      seed: -3, roughness: 7, fillStyle: 'dots', roundness: 'soft', fontFamily: 'serif',
      startArrowhead: 'star', endArrowhead: 'ARROW', align: 'justify',
    };
    for (const [k, v] of Object.entries(bad)) {
      assert.throws(
        () => validateOps([{ ...base, kind: 'update', elementId: 'r1', patch: { [k]: v } }]),
        new RegExp(`patch\\.${k}`),
        `${k}: ${JSON.stringify(v)} must be rejected`,
      );
    }
    // Only the four nullable keys take null; for the rest null is a bad value.
    for (const k of ['seed', 'roughness', 'fillStyle', 'roundness', 'fontFamily', 'startArrowhead', 'endArrowhead']) {
      assert.throws(
        () => validateOps([{ ...base, kind: 'update', elementId: 'r1', patch: { [k]: null } }]),
        new RegExp(k),
        `${k}: null is not a value`,
      );
    }
  });

  test('CREATE and UPDATE keep the same fields (the store merge round-trip)', () => {
    // The store applies an update as validateElement({...stored, ...patch}).
    // Every field a create keeps must also survive an update, per type.
    const cases = [
      ['rect', { seed: 5, roughness: 0, fillStyle: 'solid', roundness: 'round', fontFamily: 'normal', fontSize: 16, align: 'left', label: 'L' }],
      ['ellipse', { label: 'E', fontFamily: 'code', align: 'right' }],
      ['diamond', { label: 'D', fontSize: 40 }],
      ['cylinder', { label: 'C', fillStyle: 'hachure' }],
      ['sticky', { fontFamily: 'code', fontSize: 30, align: 'center', label: 'S2' }],
      ['text', { fontFamily: 'normal', fontSize: 48, align: 'right', text: 'T2' }],
      ['arrow', { startArrowhead: 'bar', endArrowhead: 'triangle', roundness: 'round', points: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 9, y: 0 }] }],
      ['line', { startArrowhead: 'dot', endArrowhead: 'dot', roughness: 2 }],
      ['pen', { seed: 77, roughness: 1.5 }],
      ['image', { seed: 8, roundness: 'round' }],
    ];
    for (const [type, fields] of cases) {
      const created = validateElement({ ...SAMPLES[type], ...fields });
      const stored = validateElement(SAMPLES[type]);
      const [op] = validateOps([{ ...base, kind: 'update', elementId: stored.id, patch: fields }]);
      const merged = validateElement({ ...stored, ...op.patch });
      for (const k of Object.keys(fields)) {
        assert.deepEqual(merged[k], created[k], `${type}.${k} survives an update exactly as a create`);
      }
    }
  });

  test('a null patch removes a binding, a group and a shape label after the merge', () => {
    const stored = validateElement({ ...SAMPLES.arrow, startId: 'b1', endId: 'b2', groupId: 'g' });
    const [op] = validateOps([{ ...base, kind: 'update', elementId: stored.id, patch: { startId: null, endId: null, groupId: null } }]);
    const merged = validateElement({ ...stored, ...op.patch });
    assert.equal('startId' in merged, false);
    assert.equal('endId' in merged, false);
    assert.equal('groupId' in merged, false);

    const shape = validateElement({ ...SAMPLES.rect, label: 'bye' });
    const [op2] = validateOps([{ ...base, kind: 'update', elementId: shape.id, patch: { label: null } }]);
    assert.equal('label' in validateElement({ ...shape, ...op2.patch }), false);

    // A sticky's label is required: removing it is invalid, not silently kept.
    const sticky = validateElement(SAMPLES.sticky);
    const [op3] = validateOps([{ ...base, kind: 'update', elementId: sticky.id, patch: { label: null } }]);
    assert.throws(() => validateElement({ ...sticky, ...op3.patch }), /label/);
  });

  test('a multi-point points patch is accepted; the merged connector needs >= 2', () => {
    const stored = validateElement(SAMPLES.arrow);
    const pts = [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }, { x: 30, y: 10 }];
    const [op] = validateOps([{ ...base, kind: 'update', elementId: stored.id, patch: { points: pts } }]);
    const merged = validateElement({ ...stored, ...op.patch });
    assert.equal(merged.points.length, 4);
    assert.deepEqual([merged.x, merged.y, merged.w, merged.h], [0, 0, 30, 10]);
    const [one] = validateOps([{ ...base, kind: 'update', elementId: stored.id, patch: { points: [{ x: 1, y: 1 }] } }]);
    assert.throws(() => validateElement({ ...stored, ...one.patch }), /at least 2 points/);
  });

  test('tryValidateOps reports invalid without throwing', () => {
    assert.equal(tryValidateOps([{ ...base, kind: 'clear' }]).valid, true);
    assert.equal(tryValidateOps([{ boardId: 'b', kind: 'clear' }]).valid, false);
  });
});
