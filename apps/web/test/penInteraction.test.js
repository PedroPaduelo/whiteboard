/**
 * penInteraction.test.js — the one pointer gesture we still own.
 *
 * The React Flow rewrite replaced a 1,437-line pointer state machine with the
 * library's own handling, and the pen is what survived: a freehand stroke is
 * not a node, so it has no place in React Flow's model and no handles to
 * grab. It lives in `canvas/penInteraction.js`, under a canvas, beside the
 * board.
 *
 * Being PURE is the point. No DOM, no store, no `Date.now` — the timestamp
 * arrives via `ctx` — so all of this runs in node without a browser, which is
 * what keeps the pen's point decimation honest. That rule is not
 * over-engineering: a fast stroke produces hundreds of samples per pixel, and
 * every one of them is paid for by every peer over the wire.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { boundsOfPoints, validateElement } from '@whiteboard/shared';
import { reducePen, idleState } from '../src/canvas/penInteraction.js';

const ctx = (over = {}) => ({
  tool: 'pen',
  elements: [],
  style: { stroke: '#1f2937', strokeWidth: 3 },
  view: { zoom: 1, panX: 0, panY: 0 },
  now: 1_700_000_000_000,
  ...over,
});

const down = (x, y) => ({ type: 'pointerdown', boardPt: { x, y } });
const move = (x, y) => ({ type: 'pointermove', boardPt: { x, y } });
const up = (x, y) => ({ type: 'pointerup', boardPt: { x, y } });

/** Run a whole gesture, collecting every effect. */
function gesture(context, steps) {
  let st = idleState();
  const effects = [];
  for (const ev of steps) {
    const r = reducePen(st, ev, context);
    st = r.state;
    effects.push(...r.effects);
  }
  return { state: st, effects };
}

const count = (effects, type) => effects.filter((e) => e.type === type);

/* ================================================================== *
 * Drawing
 * ================================================================== */

test('pen: a drag accumulates points and emits addElement exactly once on pointerup', () => {
  const { state, effects } = gesture(ctx(), [
    down(0, 0),
    move(20, 0), move(40, 10), move(60, 30), move(80, 60),
    up(100, 100),
  ]);

  assert.equal(state.phase, 'idle', 'the gesture is finished');
  const adds = count(effects, 'addElement');
  assert.equal(adds.length, 1, 'exactly one addElement');
  const el = adds[0].element;
  assert.equal(el.type, 'pen');
  assert.ok(el.points.length >= 4, `expected several points, got ${el.points.length}`);
  assert.deepEqual(el.points[el.points.length - 1], { x: 100, y: 100 });
  // The box is re-derived from the points, never left at zero.
  assert.deepEqual({ x: el.x, y: el.y, w: el.w, h: el.h }, boundsOfPoints(el.points));
  // A commit precedes the mutation, so undo removes it in one step.
  assert.equal(count(effects, 'commit').length, 1);
  assert.ok(
    effects.findIndex((e) => e.type === 'commit') < effects.findIndex((e) => e.type === 'addElement'),
    'commit must come before addElement',
  );
});

test('pen: a single tap still makes a dot — the user meant to mark the spot', () => {
  const { effects } = gesture(ctx(), [down(10, 10), up(10, 10)]);
  const el = count(effects, 'addElement')[0].element;
  assert.equal(el.points.length, 1);
  assert.deepEqual(el.points[0], { x: 10, y: 10 });
});

test('pen: the draft is previewed live and never touches the board mid-stroke', () => {
  // The draft lives in a ref, not the store: a stroke in progress is not part
  // of the board, and syncing it would ship 60 partial strokes per second.
  const st0 = idleState();
  const r1 = reducePen(st0, down(0, 0), ctx());
  assert.equal(r1.state.phase, 'draw');
  assert.equal(count(r1.effects, 'addElement').length, 0, 'nothing is added on pointerdown');
  assert.equal(count(r1.effects, 'setDraft').length, 1);

  const r2 = reducePen(r1.state, move(50, 50), ctx());
  assert.equal(count(r2.effects, 'addElement').length, 0, 'still nothing mid-drag');
  assert.equal(count(r2.effects, 'setDraft').length, 1, 'the preview moves');
});

test('pen: cancel discards the stroke without adding anything', () => {
  const r1 = reducePen(idleState(), down(0, 0), ctx());
  const r2 = reducePen(r1.state, { type: 'pointercancel', boardPt: { x: 30, y: 30 } }, ctx());
  assert.equal(r2.state.phase, 'idle');
  assert.equal(count(r2.effects, 'addElement').length, 0, 'a cancelled stroke is not a stroke');
  assert.equal(count(r2.effects, 'setDraft').at(-1).element, null, 'the draft is cleared');
});

test('pen: the stroke ANCHORS snap to the grid, the freehand middle does not', () => {
  // Snapping every point of a freehand stroke would defeat the point of it —
  // the pen follows the hand. What snaps is the two ANCHORS: where the stroke
  // starts and where it ends, so a snapped shape lands on the grid while the
  // line between stays as drawn.
  const c = ctx({ gridSize: 20 });
  const { effects } = gesture(c, [down(3, 7), move(47, 41), up(47, 41)]);
  const el = count(effects, 'addElement')[0].element;
  const first = el.points[0];
  const last = el.points[el.points.length - 1];
  assert.equal(first.x % 20, 0, `start x ${first.x} is on the grid`);
  assert.equal(first.y % 20, 0, `start y ${first.y} is on the grid`);
  assert.equal(last.x % 20, 0, `end x ${last.x} is on the grid`);
  assert.equal(last.y % 20, 0, `end y ${last.y} is on the grid`);
});

test('pen: with the grid off, nothing is snapped', () => {
  const c = ctx({ gridSize: 0 });
  const { effects } = gesture(c, [down(3, 7), move(47, 41), up(47, 41)]);
  const el = count(effects, 'addElement')[0].element;
  assert.deepEqual(el.points[0], { x: 3, y: 7 }, 'the raw position is kept');
});

/* ================================================================== *
 * Point decimation — the reason this module stays pure
 * ================================================================== */

test('pen: near-identical points are dropped, so a fast stroke is not 10k collinear points', () => {
  const steps = [down(0, 0)];
  // 50 moves 0.1px apart — under the 2-unit spacing at zoom 1.
  for (let i = 1; i <= 50; i++) steps.push(move(i * 0.1, 0));
  steps.push(up(50, 0));
  const { effects } = gesture(ctx(), steps);
  const el = count(effects, 'addElement')[0].element;
  assert.ok(el.points.length < 5, `sub-pixel spam should be collapsed, got ${el.points.length} points`);
});

test('pen: the spacing rule scales with zoom', () => {
  // Zoomed out, 2 board units is a lot of screen, so fewer points are kept;
  // zoomed in, the same board distance is a small screen move and is kept.
  // Either way the visible stroke is the same shape.
  const out = gesture(ctx({ view: { zoom: 0.5, panX: 0, panY: 0 } }), [
    down(0, 0), move(1, 0), move(2, 0), move(30, 0), up(30, 0),
  ]);
  const zoomed = gesture(ctx({ view: { zoom: 4, panX: 0, panY: 0 } }), [
    down(0, 0), move(1, 0), move(2, 0), move(30, 0), up(30, 0),
  ]);
  const a = count(out.effects, 'addElement')[0].element;
  const b = count(zoomed.effects, 'addElement')[0].element;
  assert.ok(b.points.length > a.points.length, 'zoomed in keeps more detail, not fewer');
});

/* ================================================================== *
 * The eraser
 * ================================================================== */

test('pen: the eraser removes the stroke it hits, with one commit', () => {
  const stroke = {
    id: 's1', type: 'pen', x: 0, y: 0, w: 20, h: 20,
    points: [{ x: 0, y: 10 }, { x: 20, y: 10 }], stroke: '#000', strokeWidth: 4,
  };
  const c = ctx({ tool: 'eraser', elements: [stroke] });
  const { effects } = gesture(c, [down(10, 10)]);
  assert.equal(count(effects, 'commit').length, 1);
  assert.deepEqual(count(effects, 'removeElements')[0].ids, ['s1']);
});

test('pen: the eraser ignores empty space and starts nothing', () => {
  const c = ctx({ tool: 'eraser', elements: [] });
  const { effects } = gesture(c, [down(500, 500)]);
  assert.equal(count(effects, 'removeElements').length, 0);
  assert.equal(count(effects, 'commit').length, 0, 'nothing removed, nothing to undo');
});

test('pen: an eraser sweep removes each stroke once, not once per sample', () => {
  const mk = (id, y) => ({
    id, type: 'pen', x: 0, y: y - 2, w: 20, h: 4,
    points: [{ x: 0, y }, { x: 20, y }], stroke: '#000', strokeWidth: 4,
  });
  const els = [mk('a', 0), mk('b', 10), mk('c', 20)];
  const c = ctx({ tool: 'eraser', elements: els });
  const { effects } = gesture(c, [down(5, 0), move(5, 10), move(5, 20), move(5, 25)]);
  const removed = count(effects, 'removeElements').flatMap((e) => e.ids);
  assert.deepEqual([...new Set(removed)].sort(), ['a', 'b', 'c'], 'each stroke once');
  assert.equal(count(effects, 'commit').length, 1, 'the whole sweep is one undo step');
});

/* ================================================================== *
 * Robustness
 * ================================================================== */

test('pen: the wrong tool produces nothing rather than guessing', () => {
  const { state, effects } = gesture(ctx({ tool: 'rect' }), [down(0, 0), move(10, 10), up(10, 10)]);
  assert.equal(count(effects, 'addElement').length, 0);
  assert.equal(state.phase, 'idle');
});

test('pen: junk input is a no-op, not a throw', () => {
  for (const bad of [null, undefined, {}, { type: 'pointerdown' }, { type: 'nope' }]) {
    const r = reducePen(idleState(), bad, ctx());
    assert.ok(Array.isArray(r.effects));
  }
});

test('pen: a stroke from the pen passes the SERVER validator', () => {
  // The element has to survive a round trip through the API, or a pen stroke
  // silently loses its points the first time another peer loads the board.
  const { effects } = gesture(ctx(), [down(0, 0), move(30, 10), move(60, 40), up(60, 40)]);
  const el = count(effects, 'addElement')[0].element;
  const clean = validateElement(el);
  assert.equal(clean.type, 'pen');
  assert.equal(clean.points.length, el.points.length, 'no point is lost in validation');
  assert.equal(clean.x, el.x);
  assert.equal(clean.w, el.w);
});
