/**
 * scene.test.js — the pure geometry behind every transform gesture:
 * groups, move, resize (incl. rotated and multi), rotate, connector
 * re-binding and grid snapping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectors, BIND_GAP } from '@whiteboard/shared';
import {
  groupMembers,
  expandSelectionToGroups,
  moveElements,
  resizeElements,
  rotateElements,
  resolveBindingPatches,
  findBindTarget,
  snapToGrid,
  transformFrame,
  handlePoint,
  applyPatches,
  rebindMovedConnectors,
  labelFitHeight,
  growContainerForLabel,
} from '../src/editor/scene.js';
import { commonBounds, elementBounds } from '../src/editor/handles.js';
import { labelBox, layoutText } from '../src/editor/text.js';
import { elementCorners } from '../src/editor/handles.js';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const assertNear = (a, b, eps = 1e-6, msg = '') => assert.ok(near(a, b, eps), `${msg} expected ${b}, got ${a}`);
const assertPt = (p, q, eps = 1e-6, msg = '') => {
  assertNear(p.x, q.x, eps, `${msg} x`);
  assertNear(p.y, q.y, eps, `${msg} y`);
};

const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'rect', x, y, w, h, stroke: '#1e1e1e', fill: 'none', strokeWidth: 2, ...extra });
const arrow = (id, points, extra = {}) => ({ id, type: 'arrow', x: 0, y: 0, w: 0, h: 0, points, stroke: '#1e1e1e', strokeWidth: 2, ...extra });
const pen = (id, points) => ({ id, type: 'pen', x: 0, y: 0, w: 0, h: 0, points, stroke: '#1e1e1e', strokeWidth: 2 });
const text = (id, x, y, w, h, fontSize = 20) => ({ id, type: 'text', x, y, w, h, text: 'hi', fontSize });
const patchOf = (patches, id) => patches.find((p) => p.id === id)?.patch;

/* ---------------------------------------------------------------- groups */

test('groupMembers includes the legacy frame whose id is the group key', () => {
  const els = [rect('frame', 0, 0, 100, 100), rect('a', 10, 10, 10, 10, { groupId: 'frame' }), rect('b', 30, 30, 10, 10, { groupId: 'g2' })];
  assert.deepEqual(groupMembers(els, 'frame').map((e) => e.id), ['frame', 'a']);
  assert.deepEqual(groupMembers(els, 'g2').map((e) => e.id), ['b']);
  assert.deepEqual(groupMembers(els, null), []);
});

test('expandSelectionToGroups grows to whole groups, transitively, in z-order', () => {
  const els = [
    rect('frame', 0, 0, 100, 100, { groupId: 'outer' }),
    rect('child', 10, 10, 10, 10, { groupId: 'frame' }),
    rect('sibling', 200, 0, 10, 10, { groupId: 'outer' }),
    rect('loner', 300, 0, 10, 10),
  ];
  assert.deepEqual(expandSelectionToGroups(els, ['child']), ['frame', 'child', 'sibling']);
  assert.deepEqual(expandSelectionToGroups(els, ['loner']), ['loner']);
  assert.deepEqual(expandSelectionToGroups(els, []), []);
  // Selecting the frame pulls its children in too.
  assert.deepEqual(expandSelectionToGroups(els, new Set(['frame'])), ['frame', 'child', 'sibling']);
});

/* ------------------------------------------------------------------ move */

test('moveElements moves boxes by x/y and polylines by fresh points', () => {
  const r = rect('r', 10, 20, 50, 40);
  const p = pen('p', [{ x: 0, y: 0 }, { x: 10, y: 5 }]);
  const patches = moveElements([r, p], 5, -3);
  assert.deepEqual(patchOf(patches, 'r'), { x: 15, y: 17 });
  assert.deepEqual(patchOf(patches, 'p').points, [{ x: 5, y: -3 }, { x: 15, y: 2 }]);
  // Originals untouched (no in-place mutation).
  assert.deepEqual(p.points, [{ x: 0, y: 0 }, { x: 10, y: 5 }]);
  assert.notEqual(patchOf(patches, 'p').points[0], p.points[0]);
});

test('moveElements unbinds connector ends whose anchor is not moving, keeps the ones that are', () => {
  const a = arrow('ar', [{ x: 0, y: 0 }, { x: 100, y: 0 }], { startId: 'A', endId: 'B' });
  const A = rect('A', -50, -20, 40, 40);
  const onlyArrow = moveElements([a], 10, 10);
  assert.equal(patchOf(onlyArrow, 'ar').startId, null);
  assert.equal(patchOf(onlyArrow, 'ar').endId, null);
  const withA = moveElements([A, a], 10, 10);
  assert.equal('startId' in patchOf(withA, 'ar'), false);
  assert.equal(patchOf(withA, 'ar').endId, null);
});

test('moveElements never moves locked elements', () => {
  const patches = moveElements([rect('r', 0, 0, 10, 10, { locked: true }), rect('s', 0, 0, 10, 10)], 5, 5);
  assert.deepEqual(patches.map((p) => p.id), ['s']);
});

/* ---------------------------------------------------------------- resize */

test('resize an unrotated rect from each corner keeps the opposite corner fixed', () => {
  const r = rect('r', 100, 100, 100, 50);
  const f = transformFrame([r]);
  const se = patchOf(resizeElements([r], f, 'se', { x: 250, y: 200 }), 'r');
  assert.deepEqual(se, { x: 100, y: 100, w: 150, h: 100 });
  const nw = patchOf(resizeElements([r], f, 'nw', { x: 50, y: 80 }), 'r');
  assert.deepEqual(nw, { x: 50, y: 80, w: 150, h: 70 });
  const e = patchOf(resizeElements([r], f, 'e', { x: 260, y: 999 }), 'r');
  assert.deepEqual(e, { x: 100, y: 100, w: 160, h: 50 });
  const n = patchOf(resizeElements([r], f, 'n', { x: 999, y: 90 }), 'r');
  assert.deepEqual(n, { x: 100, y: 90, w: 100, h: 60 });
});

test('resize past the anchor flips the box instead of producing a negative size', () => {
  const r = rect('r', 100, 100, 100, 50);
  const p = patchOf(resizeElements([r], null, 'se', { x: 60, y: 80 }), 'r');
  assert.deepEqual(p, { x: 60, y: 80, w: 40, h: 20 });
});

test('Shift keeps the aspect ratio, Alt resizes from the centre', () => {
  const r = rect('r', 0, 0, 100, 50);
  const aspect = patchOf(resizeElements([r], null, 'se', { x: 300, y: 60 }, { keepAspect: true }), 'r');
  assert.deepEqual(aspect, { x: 0, y: 0, w: 300, h: 150 });
  const centre = patchOf(resizeElements([r], null, 'se', { x: 120, y: 40 }, { fromCenter: true }), 'r');
  assert.deepEqual(centre, { x: -20, y: 10, w: 140, h: 30 });
  // Side handle + Shift: the other axis follows, about the centre.
  const side = patchOf(resizeElements([r], null, 'e', { x: 200, y: 0 }, { keepAspect: true }), 'r');
  assert.deepEqual(side, { x: 0, y: -25, w: 200, h: 100 });
});

test('resizing a ROTATED rect keeps the opposite corner fixed on screen', () => {
  for (const rotation of [Math.PI / 6, Math.PI / 2, -2.2]) {
    const r = rect('r', 100, 100, 120, 60, { rotation });
    const before = elementCorners(r); // TL, TR, BR, BL (rotated)
    const f = transformFrame([r]);
    // Drag the se handle 40 units along the element's own diagonal-ish direction.
    const se = handlePoint(f, 'se');
    const pointer = { x: se.x + 30, y: se.y + 25 };
    const patch = patchOf(resizeElements([r], f, 'se', pointer), 'r');
    const after = elementCorners({ ...r, ...patch });
    assertPt(after[0], before[0], 1e-6, `nw fixed at rotation ${rotation}`);
    assert.equal(patch.rotation, undefined, 'rotation is unchanged');
    // The dragged corner lands on the pointer projected on the element axes:
    // here, since we moved freely, it is exactly at the pointer.
    assertPt(after[2], pointer, 1e-6, `se follows the pointer at rotation ${rotation}`);
  }
});

test('side-resizing a rotated rect keeps the opposite edge fixed', () => {
  const r = rect('r', 0, 0, 100, 40, { rotation: Math.PI / 4 });
  const before = elementCorners(r);
  const f = transformFrame([r]);
  const e = handlePoint(f, 'e');
  const patch = patchOf(resizeElements([r], f, 'e', { x: e.x + 20, y: e.y + 20 }), 'r');
  const after = elementCorners({ ...r, ...patch });
  assertPt(after[0], before[0], 1e-6, 'nw');
  assertPt(after[3], before[3], 1e-6, 'sw');
  assertNear(patch.h, 40);
  assertNear(patch.w, 100 + Math.hypot(20, 20));
});

test('resizing text scales its font size (never stretches it)', () => {
  const t = text('t', 0, 0, 100, 25, 20);
  const p = patchOf(resizeElements([t], null, 'se', { x: 200, y: 30 }), 't');
  assertNear(p.fontSize, 40);
  assert.deepEqual({ x: p.x, y: p.y, w: p.w, h: p.h }, { x: 0, y: 0, w: 200, h: 50 });
  const tiny = patchOf(resizeElements([t], null, 'se', { x: 1, y: 1 }), 't');
  assert.equal(tiny.fontSize, 4, 'clamped to the validator minimum');
  assertNear(tiny.w, 20);
});

test('text dragged past the anchor flips its box to the pointer side, like a rect (glyphs never mirror)', () => {
  const t = text('t', 100, 100, 120, 30, 20);
  const r = rect('r', 100, 100, 120, 30);
  // The se corner dragged up-left past the nw anchor.
  const past = { x: 40, y: 70 };
  const rp = patchOf(resizeElements([r], null, 'se', past), 'r');
  const tp = patchOf(resizeElements([t], null, 'se', past), 't');
  assert.deepEqual({ x: rp.x, y: rp.y, w: rp.w, h: rp.h }, { x: 40, y: 70, w: 60, h: 30 });
  assert.equal(tp.fontSize, 20, 'uniform scale |-1|');
  assertNear(tp.x + tp.w, 100, 1e-6, 'right edge on the anchor');
  assertNear(tp.y + tp.h, 100, 1e-6, 'bottom edge on the anchor');
  assert.ok(tp.x < 100 && tp.y < 100, 'the box is on the pointer side (north-west), not south-east');
  // A side handle past the opposite edge: the box moves across it.
  const side = patchOf(resizeElements([t], null, 'w', { x: 300, y: 115 }), 't');
  assertNear(side.x, 220, 1e-6, 'left edge on the anchor');
  assertNear(side.x + side.w, 300, 1e-6, 'right edge under the pointer');
  assert.ok(!('rotation' in side) && side.w > 0 && side.h > 0);
  // Just past the anchor: the minimum font, still on the pointer side.
  const tiny = patchOf(resizeElements([t], null, 'se', { x: 99, y: 99 }), 't');
  assert.equal(tiny.fontSize, 4);
  assertNear(tiny.x + tiny.w, 100);
  assertNear(tiny.y + tiny.h, 100);
});

test('images keep their aspect by default and stretch with Shift', () => {
  const img = { id: 'i', type: 'image', x: 0, y: 0, w: 100, h: 50, src: 'https://x/y.png' };
  const p = patchOf(resizeElements([img], null, 'se', { x: 200, y: 60 }), 'i');
  assert.deepEqual(p, { x: 0, y: 0, w: 200, h: 100 });
  const free = patchOf(resizeElements([img], null, 'se', { x: 200, y: 60 }, { keepAspect: true }), 'i');
  assert.deepEqual(free, { x: 0, y: 0, w: 200, h: 60 });
});

test('resizing a single pen stroke scales its points into the new box', () => {
  const p = pen('p', [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }]);
  const patch = patchOf(resizeElements([p], null, 'se', { x: 200, y: 50 }), 'p');
  assert.deepEqual(patch.points, [{ x: 0, y: 0 }, { x: 200, y: 25 }, { x: 100, y: 50 }]);
  assert.deepEqual(p.points[1], { x: 100, y: 50 }, 'original untouched');
});

test('multi-selection resize scales positions and sizes about the anchor, polylines by points', () => {
  const a = rect('a', 0, 0, 100, 100);
  const b = rect('b', 200, 100, 100, 100);
  const l = arrow('l', [{ x: 0, y: 200 }, { x: 300, y: 200 }]);
  const f = transformFrame([a, b, l]);
  assert.deepEqual({ x: f.x, y: f.y, w: f.w, h: f.h }, { x: 0, y: 0, w: 300, h: 200 });
  const patches = resizeElements([a, b, l], f, 'se', { x: 600, y: 400 });
  assert.deepEqual(patchOf(patches, 'a'), { x: 0, y: 0, w: 200, h: 200 });
  assert.deepEqual(patchOf(patches, 'b'), { x: 400, y: 200, w: 200, h: 200 });
  assert.deepEqual(patchOf(patches, 'l').points, [{ x: 0, y: 400 }, { x: 600, y: 400 }]);
  // From the centre with Alt.
  const c = resizeElements([a, b], transformFrame([a, b]), 'e', { x: 450, y: 0 }, { fromCenter: true });
  assert.deepEqual(patchOf(c, 'a'), { x: -150, y: 0, w: 200, h: 100 });
});

test('multi resize keeps rotated members rotated and scales text fonts on corner drags', () => {
  const r = rect('r', 0, 0, 100, 50, { rotation: Math.PI / 2 });
  const t = text('t', 200, 0, 100, 25, 20);
  const f = transformFrame([r, t]);
  const patches = resizeElements([r, t], f, 'se', { x: f.x + f.w * 2, y: f.y + f.h * 2 });
  const pr = patchOf(patches, 'r');
  assertNear(pr.w, 200);
  assertNear(pr.h, 100);
  assert.equal(pr.rotation, undefined);
  assertNear(patchOf(patches, 't').fontSize, 40);
});

/* ---------------------------------------------------------------- rotate */

test('rotating a single element sets the angle of the handle, Shift snaps to 15°', () => {
  const r = rect('r', 0, 0, 100, 100);
  const f = transformFrame([r]);
  // Pointer straight right of the centre = 90° clockwise.
  const p = patchOf(rotateElements([r], f, { x: 200, y: 50 }), 'r');
  assertNear(p.rotation, Math.PI / 2);
  assert.equal('x' in p, false, 'a single element turns in place');
  const snapped = patchOf(rotateElements([r], f, { x: 200, y: 60 }, { snap15: true }), 'r');
  assertNear(snapped.rotation, Math.PI / 2);
  const free = patchOf(rotateElements([r], f, { x: 200, y: 60 }), 'r');
  assert.ok(Math.abs(free.rotation - Math.PI / 2) > 0.01);
});

test('rotating several elements orbits them about the common centre; polylines bake the turn into points', () => {
  const a = rect('a', 0, 0, 20, 20);
  const b = rect('b', 80, 0, 20, 20);
  const p = pen('p', [{ x: 0, y: 50 }, { x: 100, y: 50 }]);
  const f = transformFrame([a, b, p]);
  const c = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  // Half a turn: pointer straight below the centre.
  const patches = rotateElements([a, b, p], f, { x: c.x, y: c.y + 100 });
  const pa = patchOf(patches, 'a');
  assertNear(Math.abs(pa.rotation), Math.PI);
  assertNear(pa.x, 80);
  assertNear(pa.y, 30);
  const pts = patchOf(patches, 'p').points;
  assertPt(pts[0], { x: 100, y: 0 });
  assertPt(pts[1], { x: 0, y: 0 });
});

test('a lone 2-point connector is not rotatable; locked elements are skipped', () => {
  assert.deepEqual(rotateElements([arrow('a', [{ x: 0, y: 0 }, { x: 10, y: 0 }])], null, { x: 50, y: 50 }), []);
  assert.deepEqual(rotateElements([rect('r', 0, 0, 10, 10, { locked: true })], null, { x: 50, y: 50 }), []);
});

test('a lone multi-point connector rotates about its box centre, the turn baked into its points', () => {
  const a = arrow('a', [{ x: 0, y: 0 }, { x: 100, y: 50 }, { x: 200, y: 0 }]);
  const f = transformFrame([a]);
  const c = { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  // The handle dragged to the right of the centre: a quarter turn clockwise.
  const p = patchOf(rotateElements([a], f, { x: c.x + 100, y: c.y }), 'a');
  assert.ok(p && !('rotation' in p), 'no rotation field on a connector');
  assertPt(p.points[0], { x: c.x + (c.y - 0), y: c.y + (0 - c.x) }, 1e-6, 'start');
  assertPt(p.points[1], { x: c.x - (50 - c.y), y: c.y + (100 - c.x) }, 1e-6, 'middle');
  // And resizes through its own frame like a pen stroke.
  const r = patchOf(resizeElements([a], null, 'e', { x: 400, y: 25 }), 'a');
  assert.deepEqual(r.points.map((q) => q.x), [0, 200, 400]);
});

/* --------------------------------------------------------------- binding */

test('resolveBindingPatches re-resolves connectors bound to moved shapes (and only those)', () => {
  const A = rect('A', 0, 0, 100, 100);
  const B = rect('B', 300, 0, 100, 100);
  const bound = resolveConnectors([A, B, arrow('ab', [{ x: 0, y: 0 }, { x: 1, y: 1 }], { startId: 'A', endId: 'B' })])[2];
  const free = arrow('free', [{ x: 0, y: 500 }, { x: 50, y: 500 }]);
  const els = [A, B, bound, free];
  const moves = moveElements([B], 0, 200);
  const next = applyPatches(els, moves);
  const patches = resolveBindingPatches(next, ['B']);
  assert.deepEqual(patches.map((p) => p.id), ['ab']);
  const pts = patches[0].patch.points;
  // Start on A's outline toward B's new centre, end on B's outline, BIND_GAP outside.
  const endB = { ...B, y: 200 };
  assert.ok(pts[1].y > endB.y - BIND_GAP - 1e-6 && pts[1].x < endB.x + 1e-6);
  // Applying the patch makes the board a fixed point of resolveConnectors.
  const settled = applyPatches(next, patches);
  assert.deepEqual(resolveConnectors(settled)[2].points, settled[2].points);
  // Nothing changed -> nothing to send.
  assert.deepEqual(resolveBindingPatches(settled, ['B']), []);
  assert.deepEqual(resolveBindingPatches(next, ['unrelated']), []);
});

test('findBindTarget: bindable types only, outline for unfilled, interior for filled, topmost, zoom-aware', () => {
  const empty = rect('empty', 0, 0, 200, 200);
  const filled = rect('filled', 300, 0, 100, 100, { fill: '#ffc9c9' });
  const stroke = pen('pen', [{ x: 0, y: 300 }, { x: 100, y: 300 }]);
  const els = [empty, filled, stroke];
  assert.equal(findBindTarget(els, { x: 100, y: 100 }, 1), null, 'middle of an empty rect does not bind');
  assert.equal(findBindTarget(els, { x: 100, y: 10 }, 1)?.id, 'empty', 'near its outline binds');
  assert.equal(findBindTarget(els, { x: 100, y: -12 }, 1)?.id, 'empty', 'just outside binds');
  assert.equal(findBindTarget(els, { x: 100, y: 30 }, 1)?.id, 'empty', 'a big shape grants up to 32 units (Excalidraw maxBindingGap)');
  assert.equal(findBindTarget(els, { x: 100, y: 40 }, 1), null);
  // Small shapes: the gap is BIND_DISTANCE screen px, so it shrinks with zoom.
  const small = rect('small', 0, 500, 20, 20);
  assert.equal(findBindTarget([small], { x: 10, y: 488 }, 1)?.id, 'small');
  assert.equal(findBindTarget([small], { x: 10, y: 488 }, 4), null, 'the distance is in screen px');
  assert.equal(findBindTarget(els, { x: 350, y: 50 }, 1)?.id, 'filled');
  assert.equal(findBindTarget(els, { x: 50, y: 300 }, 1), null, 'pen strokes are not bindable');
  assert.equal(findBindTarget(els, { x: 350, y: 50 }, 1, ['filled']), null, 'excluded ids are skipped');
  const onTop = rect('top', 320, 20, 60, 60, { fill: '#a5d8ff' });
  assert.equal(findBindTarget([...els, onTop], { x: 350, y: 50 }, 1)?.id, 'top');
});

/* ------------------------------------------------------------ misc utils */

test('snapToGrid only snaps when enabled with a positive grid', () => {
  assert.deepEqual(snapToGrid({ x: 23, y: 37 }, 20, true), { x: 20, y: 40 });
  assert.deepEqual(snapToGrid({ x: 23, y: 37 }, 20, false), { x: 23, y: 37 });
  assert.deepEqual(snapToGrid({ x: 23, y: 37 }, 0, true), { x: 23, y: 37 });
});

test('applyPatches merges like the store: null deletes, polylines re-box, identity kept when untouched', () => {
  const a = arrow('a', [{ x: 0, y: 0 }, { x: 10, y: 10 }], { startId: 'X', x: 0, y: 0, w: 10, h: 10 });
  const r = rect('r', 0, 0, 1, 1);
  const out = applyPatches([a, r], [{ id: 'a', patch: { startId: null, points: [{ x: 5, y: 5 }, { x: 25, y: 15 }] } }]);
  assert.equal('startId' in out[0], false);
  assert.deepEqual({ x: out[0].x, y: out[0].y, w: out[0].w, h: out[0].h }, { x: 5, y: 5, w: 20, h: 10 });
  assert.equal(out[1], r);
});

test('transformFrame and handlePoint agree with the rotated corners', () => {
  const r = rect('r', 10, 20, 100, 50, { rotation: 0.7 });
  const f = transformFrame([r]);
  const corners = elementCorners(r);
  assertPt(handlePoint(f, 'nw'), corners[0]);
  assertPt(handlePoint(f, 'ne'), corners[1]);
  assertPt(handlePoint(f, 'se'), corners[2]);
  assertPt(handlePoint(f, 'sw'), corners[3]);
});

/* ----------------------------------------------------------- review fixes */

test('moveElements with the scene keeps a binding whose end stays close to its shape (a nudge)', () => {
  const A = rect('A', 0, 0, 100, 100);
  const B = rect('B', 300, 0, 100, 100);
  const ar = resolveConnectors([A, B, arrow('ar', [{ x: 0, y: 0 }, { x: 1, y: 1 }], { startId: 'A', endId: 'B' })])[2];
  const scene = [A, B, ar];
  const nudged = patchOf(moveElements([ar], 1, 0, { elements: scene }), 'ar');
  assert.equal('startId' in nudged, false, 'start kept');
  assert.equal('endId' in nudged, false, 'end kept');
  const far = patchOf(moveElements([ar], 0, 200, { elements: scene }), 'ar');
  assert.equal(far.startId, null);
  assert.equal(far.endId, null);
  // Without the scene: the old unbind-on-move (a live drag).
  assert.equal(patchOf(moveElements([ar], 1, 0), 'ar').startId, null);
});

test('rebindMovedConnectors restores close original bindings, resolved onto the outlines', () => {
  const A = rect('A', 0, 0, 100, 100);
  const B = rect('B', 300, 0, 100, 100);
  const ar = resolveConnectors([A, B, arrow('ar', [{ x: 0, y: 0 }, { x: 1, y: 1 }], { startId: 'A', endId: 'B' })])[2];
  const moved = applyPatches([A, B, ar], moveElements([ar], 0, 6));
  assert.equal(moved[2].startId, undefined);
  const patches = rebindMovedConnectors([ar], moved);
  const p = patchOf(patches, 'ar');
  assert.equal(p.startId, 'A');
  assert.equal(p.endId, 'B');
  const after = applyPatches(moved, patches);
  assert.deepEqual(resolveConnectors(after)[2].points, after[2].points, 'settled');
  assert.deepEqual(rebindMovedConnectors([ar], applyPatches([A, B, ar], moveElements([ar], 0, 300))), []);
});

test('multi resize with a member turned 45° scales uniformly: it keeps its angle and stays in the frame', () => {
  const A = rect('A', 300, 250, 100, 100, { rotation: Math.PI / 4 });
  const B = rect('B', 500, 250, 100, 100);
  const f = transformFrame([A, B]);
  const patches = resizeElements([A, B], f, 'e', { x: f.x + f.w * 2, y: f.y + f.h / 2 });
  const pa = patchOf(patches, 'A');
  assert.equal(pa.rotation, undefined, 'angle unchanged');
  assertNear(pa.w, 200);
  assertNear(pa.h, 200);
  const next = applyPatches([A, B], patches);
  const nb = commonBounds(next);
  assertNear(nb.x, f.x, 1e-6, 'anchored left edge');
  assertNear(nb.w, f.w * 2, 1e-6, 'width doubled');
  assertNear(elementBounds(next[0]).x, f.x, 1e-6, 'A still touches the anchored edge');
  // Right angles can still stretch on one axis.
  const C = rect('C', 0, 0, 100, 50, { rotation: Math.PI / 2 });
  const D = rect('D', 200, 0, 100, 50);
  const g = transformFrame([C, D]);
  const pc = patchOf(resizeElements([C, D], g, 'e', { x: g.x + g.w * 2, y: 0 }), 'C');
  assertNear(pc.w, 100);
  assertNear(pc.h, 100);
});

test('labelFitHeight / growContainerForLabel: a long label grows its container downward, never narrower', () => {
  const long = 'Este é um rótulo muito comprido que certamente não cabe dentro deste retângulo pequeno de jeito nenhum';
  for (const type of ['rect', 'ellipse', 'diamond', 'sticky']) {
    const el = { id: 'x', type, x: 300, y: 300, w: 120, h: 70, fontSize: 20 };
    const fit = growContainerForLabel(el, long);
    assert.ok(fit && fit.h > 70, `${type} grows`);
    assert.equal(fit.x, undefined);
    assert.equal(fit.y, undefined, 'the top edge stays');
    const grown = { ...el, ...fit, label: long };
    const lay = layoutText(grown);
    const top = lay.lines[0].y;
    const bottom = lay.lines.at(-1).y + lay.lineHeight;
    const box = labelBox(grown);
    assert.ok(top >= box.y - 1e-6 && bottom <= box.y + box.h + 1e-6, `${type}: text inside its box (${top}..${bottom} vs ${box.y}..${box.y + box.h})`);
    assert.equal(growContainerForLabel(grown, long), null, 'already fits');
    // A short label never shrinks a shape; with minH it shrinks back to it.
    assert.equal(growContainerForLabel(grown, 'oi'), null);
    assert.deepEqual(growContainerForLabel(grown, 'oi', { minH: 70 }), { h: 70 });
  }
  assert.equal(labelFitHeight({ type: 'rect', x: 0, y: 0, w: 100, h: 50 }, ''), 0);
  assert.equal(growContainerForLabel({ type: 'text', x: 0, y: 0, w: 10, h: 10, text: long }, long), null, 'free text is not a container');
});

test('growContainerForLabel keeps the top edge of a rotated container in place', () => {
  const el = { id: 'x', type: 'rect', x: 0, y: 0, w: 100, h: 50, rotation: Math.PI / 2, fontSize: 20 };
  const fit = growContainerForLabel(el, 'uma frase longa que quebra em várias linhas dentro do retângulo');
  assert.ok(fit.h > 50);
  const topMid = (e) => {
    const c = { x: e.x + e.w / 2, y: e.y + e.h / 2 };
    const a = e.rotation;
    const d = { x: 0, y: -e.h / 2 };
    return { x: c.x + d.x * Math.cos(a) - d.y * Math.sin(a), y: c.y + d.x * Math.sin(a) + d.y * Math.cos(a) };
  };
  assertPt(topMid({ ...el, ...fit }), topMid(el), 1e-6);
});
