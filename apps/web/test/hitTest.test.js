/**
 * hitTest.test.js — Excalidraw hit semantics: filled vs unfilled shapes,
 * labels, rotation, zoom-scaled tolerance, marquee full containment and
 * connector point handles.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  hitElement,
  hitTest,
  hitTestAll,
  elementsInMarquee,
  hitLinearPoint,
  hitLinearSegment,
  pointInFrame,
} from '../src/editor/hitTest.js';
import { selectionFrame } from '../src/editor/handles.js';

const rect = (id, x, y, w, h, extra = {}) => ({ id, type: 'rect', x, y, w, h, stroke: '#1e1e1e', fill: 'none', strokeWidth: 2, ...extra });

test('an UNFILLED rect is hit on its outline band, not in its empty middle', () => {
  const r = rect('r', 0, 0, 200, 100);
  assert.equal(hitElement(r, { x: 100, y: 50 }, 1), false, 'middle');
  assert.equal(hitElement(r, { x: 100, y: 0 }, 1), true, 'on the top edge');
  assert.equal(hitElement(r, { x: 100, y: 6 }, 1), true, 'just inside, within tolerance');
  assert.equal(hitElement(r, { x: 100, y: -6 }, 1), true, 'just outside, within tolerance');
  assert.equal(hitElement(r, { x: 100, y: 12 }, 1), false, 'inside, beyond tolerance');
  assert.equal(hitElement(r, { x: 100, y: -12 }, 1), false, 'outside, beyond tolerance');
});

test('a FILLED rect is hit anywhere inside; a transparent fill counts as unfilled', () => {
  assert.equal(hitElement(rect('r', 0, 0, 200, 100, { fill: '#ffc9c9' }), { x: 100, y: 50 }, 1), true);
  assert.equal(hitElement(rect('r', 0, 0, 200, 100, { fill: 'transparent' }), { x: 100, y: 50 }, 1), false);
});

test('an unfilled shape with a non-empty label is hit in its interior', () => {
  assert.equal(hitElement(rect('r', 0, 0, 200, 100, { label: 'Olá' }), { x: 100, y: 50 }, 1), true);
  assert.equal(hitElement(rect('r', 0, 0, 200, 100, { label: '   ' }), { x: 100, y: 50 }, 1), false, 'blank label is no ink');
  const e = { id: 'e', type: 'ellipse', x: 0, y: 0, w: 200, h: 100, fill: 'none', label: 'x' };
  assert.equal(hitElement(e, { x: 100, y: 50 }, 1), true);
});

test('ellipse and diamond use their real outlines, not the bounding box', () => {
  const e = { id: 'e', type: 'ellipse', x: 0, y: 0, w: 200, h: 100, fill: '#a5d8ff', strokeWidth: 2 };
  assert.equal(hitElement(e, { x: 100, y: 50 }, 1), true);
  assert.equal(hitElement(e, { x: 5, y: 5 }, 1), false, 'bbox corner is outside the ellipse');
  const eo = { ...e, fill: 'none' };
  assert.equal(hitElement(eo, { x: 0, y: 50 }, 1), true, 'left vertex of an unfilled ellipse');
  assert.equal(hitElement(eo, { x: 100, y: 50 }, 1), false);
  const d = { id: 'd', type: 'diamond', x: 100, y: 100, w: 200, h: 200, fill: '#ffec99', strokeWidth: 2 };
  assert.equal(hitElement(d, { x: 200, y: 200 }, 1), true, 'centre');
  assert.equal(hitElement(d, { x: 101, y: 101 }, 1), false, 'bbox corner misses');
  assert.equal(hitElement(d, { x: 299, y: 101 }, 1), false);
  assert.equal(hitElement(d, { x: 100, y: 200 }, 1), true, 'left vertex');
});

test('text, sticky and image are hit anywhere in their box', () => {
  assert.equal(hitElement({ id: 't', type: 'text', x: 0, y: 0, w: 80, h: 25, text: 'hi', fontSize: 20 }, { x: 40, y: 12 }, 1), true);
  assert.equal(hitElement({ id: 's', type: 'sticky', x: 0, y: 0, w: 200, h: 200, label: '' }, { x: 100, y: 100 }, 1), true);
  assert.equal(hitElement({ id: 'i', type: 'image', x: 0, y: 0, w: 50, h: 50, src: 'https://x' }, { x: 25, y: 25 }, 1), true);
  assert.equal(hitElement({ id: 'i', type: 'image', x: 0, y: 0, w: 50, h: 50, src: 'https://x' }, { x: 80, y: 25 }, 1), false);
});

test('rotation is honoured: a thin rotated bar is hit along its rotated axis only', () => {
  // 200x10 filled bar rotated 90°: it now stands vertically about its centre (100, 5).
  const bar = rect('bar', 0, 0, 200, 10, { fill: '#1e1e1e', rotation: Math.PI / 2 });
  assert.equal(hitElement(bar, { x: 100, y: 90 }, 1), true, 'on the rotated bar');
  assert.equal(hitElement(bar, { x: 180, y: 5 }, 1), false, 'where the unrotated bar would be');
});

test('lines and pen strokes are hit near the stroke; tolerance is divided by zoom', () => {
  const line = { id: 'l', type: 'line', x: 0, y: 0, w: 100, h: 0, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], strokeWidth: 2 };
  assert.equal(hitElement(line, { x: 50, y: 5 }, 1), true, '5 board units = 5 px at zoom 1');
  assert.equal(hitElement(line, { x: 50, y: 5 }, 4), false, '5 board units = 20 px at zoom 4');
  assert.equal(hitElement(line, { x: 50, y: 20 }, 0.25), true, '20 board units = 5 px at zoom 0.25');
  const pen = { id: 'p', type: 'pen', x: 0, y: 0, w: 100, h: 0, points: [{ x: 0, y: 0 }, { x: 100, y: 0 }], strokeWidth: 2 };
  assert.equal(hitElement(pen, { x: 50, y: 9 }, 1), true, 'pen band includes its painted width');
  assert.equal(hitElement(pen, { x: 50, y: 60 }, 1), false);
});

test('hitTest returns the topmost element, can skip locked ones, ignores invisible ones', () => {
  const back = rect('back', 0, 0, 100, 100, { fill: '#ffc9c9' });
  const front = rect('front', 50, 50, 100, 100, { fill: '#a5d8ff' });
  const locked = rect('locked', 60, 60, 20, 20, { fill: '#b2f2bb', locked: true });
  const ghost = rect('ghost', 0, 0, 300, 300, { fill: '#000000', opacity: 0 });
  const els = [back, front, locked, ghost];
  assert.equal(hitTest(els, { x: 70, y: 70 }, 1).id, 'locked');
  assert.equal(hitTest(els, { x: 70, y: 70 }, 1, { skipLocked: true }).id, 'front');
  assert.equal(hitTest(els, { x: 20, y: 20 }, 1).id, 'back');
  assert.equal(hitTest(els, { x: 250, y: 250 }, 1), null, 'opacity 0 is not clickable');
  assert.deepEqual(hitTestAll(els, { x: 70, y: 70 }, 1).map((e) => e.id), ['locked', 'front', 'back']);
});

test('elementsInMarquee selects only FULLY contained elements (rotation and points aware)', () => {
  const inside = rect('in', 10, 10, 50, 50);
  const partial = rect('partial', 80, 10, 50, 50);
  const rotated = rect('rot', 20, 70, 60, 10, { rotation: Math.PI / 2 }); // stands 60 tall around (50,75)
  const line = { id: 'l', type: 'line', x: 0, y: 0, w: 0, h: 0, points: [{ x: 5, y: 5 }, { x: 95, y: 95 }] };
  const els = [inside, partial, rotated, line];
  assert.deepEqual(elementsInMarquee(els, { x: 0, y: 0, w: 100, h: 100 }), ['in', 'l']);
  assert.deepEqual(elementsInMarquee(els, { x: 0, y: 0, w: 100, h: 110 }), ['in', 'rot', 'l']);
  // Negative extents (dragging up-left) are accepted.
  assert.deepEqual(elementsInMarquee(els, { x: 100, y: 100, w: -100, h: -100 }), ['in', 'l']);
});

test('hitLinearPoint finds the handle under the pointer within a zoom-scaled radius', () => {
  const a = { id: 'a', type: 'arrow', points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], strokeWidth: 2 };
  assert.equal(hitLinearPoint(a, { x: 1, y: 1 }, 1), 0);
  assert.equal(hitLinearPoint(a, { x: 52, y: -3 }, 1), 1);
  assert.equal(hitLinearPoint(a, { x: 100, y: 6 }, 1), 2);
  assert.equal(hitLinearPoint(a, { x: 100, y: 6 }, 4), -1, 'radius shrinks in board units when zoomed in');
  assert.equal(hitLinearPoint(a, { x: 25, y: 0 }, 1), -1);
  assert.equal(hitLinearSegment(a, { x: 25, y: 2 }, 1), 0);
  assert.equal(hitLinearSegment(a, { x: 75, y: 2 }, 1), 1);
  assert.equal(hitLinearSegment(a, { x: 75, y: 40 }, 1), -1);
});

test('pointInFrame honours the rotation of a single-element selection frame', () => {
  const r = rect('r', 0, 0, 200, 20, { rotation: Math.PI / 2 });
  const f = selectionFrame([r], 1);
  assert.equal(pointInFrame(f, { x: 100, y: 80 }), true);
  assert.equal(pointInFrame(f, { x: 180, y: 10 }), false);
});
