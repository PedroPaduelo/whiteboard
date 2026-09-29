/**
 * render.test.js — the renderer's pure half, under `node --test`.
 *
 * roughjs generates Drawables (plain op lists) and perfect-freehand generates
 * outlines without a DOM, so the things that must never regress — the cache
 * handing back the same Drawable for the same element, the wobble being a
 * pure function of the seed, arrowhead geometry, freehand outlines — are
 * asserted here directly. The canvas painters are exercised against a
 * recording fake 2D context.
 *
 *   node --test apps/web/test/render.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  getShape,
  buildShape,
  seedOf,
  fnv1a,
  resolveStyle,
  arrowheadGeometry,
  arrowheadBaseSize,
  connectorEnds,
  penOutline,
  outlineToPath,
  cornerRadius,
  baselineOffset,
  FONT_METRICS,
  darkRgb,
  darkPreimage,
  segmentMidpoints,
  DARK_MODE_COUNTER_FILTER,
  invalidateShape,
} from '../src/editor/render/shape.js';
import {
  drawElement,
  drawRough,
  invalidateElementCache,
  textPaintBounds,
  SHADOW_SLICE_K,
  elementPaintBox,
  paintStamp,
} from '../src/editor/render/renderElement.js';
import {
  setBitmapCanvasFactory,
  bitmapCacheStats,
  BITMAP_BUDGET_PX,
  HOT_MS,
  ZOOM_SETTLE_MS,
  PAGE_SIZE,
  ATLAS_MAX_SIDE,
  setBitmapRenderBudget,
} from '../src/editor/render/elementCache.js';
import {
  renderStatic,
  renderInteractive,
  isElementVisible,
  visibleBoardRect,
  isDarkCanvas,
  colorForDarkCanvas,
  parseColor,
  eraserTrailOutline,
  deviceView,
} from '../src/editor/render/renderScene.js';
import { layoutText } from '../src/editor/text.js';
import { selectionFrame } from '../src/editor/handles.js';
import { SELECTION_COLOR, CANVAS_BACKGROUND } from '../src/editor/constants.js';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const rect = (extra = {}) => ({
  id: 'r1',
  type: 'rect',
  x: 10,
  y: 20,
  w: 120,
  h: 80,
  stroke: '#1e1e1e',
  fill: '#a5d8ff',
  fillStyle: 'hachure',
  strokeWidth: 2,
  roughness: 1,
  seed: 42,
  ...extra,
});

const arrow = (points, extra = {}) => ({
  id: 'a1',
  type: 'arrow',
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  points,
  stroke: '#1e1e1e',
  strokeWidth: 2,
  seed: 7,
  ...extra,
});

/** A 2D context that records every call and property write. */
function fakeCtx(width = 800, height = 600) {
  const calls = [];
  const props = {
    globalAlpha: 1,
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowColor: 'transparent',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    lineDashOffset: 0,
    filter: 'none',
  };
  const stack = [];
  const ctx = {
    canvas: { width, height },
    calls,
    props,
    save() {
      calls.push(['save']);
      stack.push({ ...props });
    },
    restore() {
      calls.push(['restore']);
      const s = stack.pop();
      if (s) Object.assign(props, s);
    },
    measureText(t) {
      return { width: String(t).length * 10 };
    },
    createLinearGradient(...args) {
      const g = { args, stops: [], addColorStop: (o, c) => g.stops.push([o, c]) };
      calls.push(['createLinearGradient', ...args]);
      return g;
    },
  };
  for (const k of Object.keys(props)) {
    Object.defineProperty(ctx, k, {
      get: () => props[k],
      set: (v) => {
        props[k] = v;
        calls.push(['set', k, v]);
      },
    });
  }
  const methods = [
    'setTransform', 'translate', 'rotate', 'scale', 'beginPath', 'closePath', 'moveTo', 'lineTo',
    'bezierCurveTo', 'quadraticCurveTo', 'arc', 'arcTo', 'ellipse', 'rect', 'fill', 'stroke',
    'fillRect', 'strokeRect', 'clearRect', 'fillText', 'strokeText', 'setLineDash', 'drawImage', 'clip',
  ];
  for (const m of methods) {
    ctx[m] = (...args) => {
      calls.push([m, ...args]);
      if (m === 'fillText') calls[calls.length - 1].alpha = props.globalAlpha;
    };
  }
  return ctx;
}

const named = (ctx, name) => ctx.calls.filter((c) => c[0] === name);

/* ------------------------------------------------------------------ *
 * Seeds and determinism
 * ------------------------------------------------------------------ */

test('seedOf: stored seed wins, else FNV-1a of the id, never 0', () => {
  assert.equal(seedOf({ id: 'x', seed: 123 }), 123);
  assert.equal(seedOf({ id: 'abc' }), fnv1a('abc') % 2147483647 || 1);
  assert.equal(seedOf({ id: 'abc' }), seedOf({ id: 'abc' }), 'same id, same seed');
  assert.notEqual(seedOf({ id: 'abc' }), seedOf({ id: 'abd' }));
  // roughjs treats seed 0 as Math.random: it must never reach it.
  assert.equal(seedOf({ id: 'x', seed: 0 }), 1);
  assert.equal(seedOf({ id: 'x', seed: 2147483647 }), 1);
  for (const id of ['', 'a', 'demo-api', 'Zx9_-']) {
    const s = seedOf({ id });
    assert.ok(Number.isInteger(s) && s > 0 && s < 2147483647, `seed for ${JSON.stringify(id)} in range`);
  }
});

test('the same element always generates the identical wobble (no Math.random)', () => {
  const a = buildShape(rect({ seed: undefined, id: 'stable-id' }));
  const b = buildShape(rect({ seed: undefined, id: 'stable-id' }));
  assert.deepEqual(
    a.drawables.map((d) => d.sets),
    b.drawables.map((d) => d.sets),
  );
  const c = buildShape(rect({ seed: undefined, id: 'other-id' }));
  assert.notDeepEqual(
    a.drawables.map((d) => d.sets),
    c.drawables.map((d) => d.sets),
    'a different id wobbles differently',
  );
});

/* ------------------------------------------------------------------ *
 * Cache identity
 * ------------------------------------------------------------------ */

test('getShape: same object -> same drawable; changed object -> new drawable', () => {
  invalidateShape();
  const el = rect();
  const s1 = getShape(el);
  const s2 = getShape(el);
  assert.equal(s1, s2, 'same element object hits the cache');
  assert.equal(s1.drawables[0], s2.drawables[0]);

  // The store replaces an element object on every change.
  const resized = { ...el, w: 200 };
  const s3 = getShape(resized);
  assert.notEqual(s3, s1);
  assert.notEqual(s3.drawables[0], s1.drawables[0], 'new geometry -> new drawable');

  const restyled = { ...el, stroke: '#e03131' };
  assert.notEqual(getShape(restyled).drawables[0], s1.drawables[0], 'new style -> new drawable');
  const reseeded = { ...el, seed: 43 };
  assert.notEqual(getShape(reseeded).drawables[0], s1.drawables[0], 'new seed -> new drawable');
  const rough = { ...el, roughness: 2 };
  assert.notEqual(getShape(rough).drawables[0], s1.drawables[0], 'new roughness -> new drawable');
});

test('getShape: a moved element re-uses the drawables (local coordinates) at its new origin', () => {
  invalidateShape();
  const el = rect();
  const s1 = getShape(el);
  const moved = { ...el, x: 500, y: -40 };
  const s2 = getShape(moved);
  assert.notEqual(s2, s1, 'a different object gets its own desc');
  assert.equal(s2.drawables, s1.drawables, 'geometry is shared');
  assert.deepEqual(s2.origin, { x: 500, y: -40 });
  assert.deepEqual(s1.origin, { x: 10, y: 20 }, 'the first desc keeps its origin');
});

test('invalidateElementCache forgets one element', () => {
  const el = rect({ id: 'inv' });
  const s1 = getShape(el);
  invalidateElementCache(el);
  const s2 = getShape(el);
  assert.notEqual(s1, s2);
});

/* ------------------------------------------------------------------ *
 * Style defaults (legacy elements)
 * ------------------------------------------------------------------ */

test('resolveStyle applies the contract defaults for absent fields', () => {
  const legacyRect = resolveStyle({ id: 'l', type: 'rect', x: 0, y: 0, w: 1, h: 1, fill: '#ffffff' });
  assert.equal(legacyRect.roughness, 1);
  assert.equal(legacyRect.fillStyle, 'solid');
  assert.equal(legacyRect.roundness, 'sharp');
  assert.equal(legacyRect.stroke, null, 'a shape without stroke has no outline');
  assert.equal(resolveStyle({ id: 'n', type: 'rect', stroke: 'none', fill: 'none' }).fill, null);
  const legacyArrow = resolveStyle({ id: 'a', type: 'arrow', points: [] });
  assert.equal(legacyArrow.endArrowhead, 'arrow');
  assert.equal(legacyArrow.startArrowhead, 'none');
  assert.equal(legacyArrow.stroke, '#1e1e1e', 'a connector without a colour gets the default ink');
  const line = resolveStyle({ id: 'l', type: 'line', points: [] });
  assert.equal(line.endArrowhead, 'none');
  assert.equal(line.startArrowhead, 'none');
});

test('roundness: round rects and diamonds are paths, sharp ones are rectangle/polygon', () => {
  assert.equal(buildShape(rect()).drawables[0].shape, 'rectangle');
  assert.equal(buildShape(rect({ roundness: 'round' })).drawables[0].shape, 'path');
  const diamond = { id: 'd', type: 'diamond', x: 0, y: 0, w: 100, h: 80, stroke: '#000', seed: 3 };
  assert.equal(buildShape(diamond).drawables[0].shape, 'polygon');
  assert.equal(buildShape({ ...diamond, roundness: 'round' }).drawables[0].shape, 'path');
  assert.equal(cornerRadius(40), 10);
  assert.equal(cornerRadius(1000), 32, 'radius is capped at 32');
});

test('cylinder: body + rim; fill styles and dashes reach roughjs', () => {
  const cyl = buildShape({ id: 'c', type: 'cylinder', x: 0, y: 0, w: 120, h: 140, stroke: '#000', fill: '#eee', fillStyle: 'cross-hatch', seed: 9 });
  assert.equal(cyl.drawables.length, 2);
  assert.equal(cyl.drawables[0].options.fillStyle, 'cross-hatch');
  const dashed = buildShape(rect({ strokeStyle: 'dashed' }));
  assert.deepEqual(dashed.drawables[0].options.strokeLineDash, [8, 10]);
  const dotted = buildShape(rect({ strokeStyle: 'dotted', strokeWidth: 4 }));
  assert.deepEqual(dotted.drawables[0].options.strokeLineDash, [1.5, 10]);
  const zig = buildShape(rect({ fillStyle: 'zigzag' }));
  assert.ok(zig.drawables[0].sets.some((s) => s.type === 'fillSketch'));
  const solid = buildShape(rect({ fillStyle: 'solid' }));
  assert.ok(solid.drawables[0].sets.some((s) => s.type === 'fillPath'));
  const noFill = buildShape(rect({ fill: 'none' }));
  assert.ok(noFill.drawables[0].sets.every((s) => s.type === 'path'));
});

/* ------------------------------------------------------------------ *
 * Arrowheads
 * ------------------------------------------------------------------ */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('arrowheadGeometry: arrow wings are 25° off the shaft, length min(30, 4sw+10)', () => {
  const tip = { x: 100, y: 0 };
  const g = arrowheadGeometry('arrow', tip, { x: 0, y: 0 }, 2);
  assert.equal(g.kind, 'arrow');
  assert.equal(g.size, 18);
  assert.ok(close(dist(g.left, tip), 18));
  assert.ok(close(dist(g.right, tip), 18));
  // Symmetric about the shaft, pointing back along it.
  assert.ok(close(g.left.x, g.right.x));
  assert.ok(close(g.left.y, -g.right.y));
  assert.ok(g.left.x < tip.x);
  const angle = Math.atan2(Math.abs(g.left.y), tip.x - g.left.x) * (180 / Math.PI);
  assert.ok(close(angle, 25, 1e-6), `wing angle ${angle}`);
  assert.equal(arrowheadBaseSize(10), 30, 'capped at 30');
  assert.equal(arrowheadBaseSize(1), 14);
});

test('arrowheadGeometry: scaled down on short segments; follows any direction', () => {
  const g = arrowheadGeometry('arrow', { x: 0, y: 20 }, { x: 0, y: 0 }, 2, 20);
  assert.equal(g.size, 10, 'half of a 20-unit segment');
  // Pointing down: wings are above the tip.
  assert.ok(g.left.y < 20 && g.right.y < 20);
  assert.ok(close(g.left.y, g.right.y));
});

test('arrowheadGeometry: triangle, bar, dot and none', () => {
  const tip = { x: 50, y: 50 };
  const from = { x: 0, y: 50 };
  const tri = arrowheadGeometry('triangle', tip, from, 2);
  assert.equal(tri.kind, 'triangle');
  assert.ok(close(dist(tri.left, tip), tri.size));
  const bar = arrowheadGeometry('bar', tip, from, 2);
  assert.equal(bar.kind, 'bar');
  // Perpendicular to a horizontal shaft, centred on the tip.
  assert.ok(close(bar.a.x, 50) && close(bar.b.x, 50));
  assert.ok(close((bar.a.y + bar.b.y) / 2, 50));
  assert.ok(close(Math.abs(bar.a.y - bar.b.y), 2 * bar.size));
  const dot = arrowheadGeometry('dot', tip, from, 2);
  assert.equal(dot.kind, 'dot');
  assert.deepEqual(dot.center, tip);
  assert.ok(dot.diameter > 2);
  assert.equal(arrowheadGeometry('none', tip, from, 2), null);
  assert.equal(arrowheadGeometry('arrow', tip, tip, 2), null, 'zero-length shaft has no direction');
});

test('connector drawables: shaft first, then one drawable per arrow wing / head', () => {
  const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }];
  const plain = buildShape(arrow(pts, { startArrowhead: 'none', endArrowhead: 'none' }));
  assert.equal(plain.drawables.length, 1);
  assert.equal(plain.drawables[0].shape, 'linearPath');
  const both = buildShape(arrow(pts, { startArrowhead: 'arrow', endArrowhead: 'arrow' }));
  assert.equal(both.drawables.length, 5, 'shaft + 2 wings per end');
  const mixed = buildShape(arrow(pts, { startArrowhead: 'dot', endArrowhead: 'triangle' }));
  assert.equal(mixed.drawables.length, 3);
  assert.equal(mixed.drawables[1].shape, 'circle');
  assert.equal(mixed.drawables[2].shape, 'polygon');
  assert.equal(mixed.drawables[2].options.fill, '#1e1e1e', 'triangle filled with the stroke colour');
  // Legacy arrow (no arrowhead fields): end arrow only.
  assert.equal(buildShape(arrow(pts)).drawables.length, 3);
  // Heads are always drawn solid, even on a dashed connector.
  const dashed = buildShape(arrow(pts, { strokeStyle: 'dashed' }));
  assert.ok(dashed.drawables[0].options.strokeLineDash);
  assert.equal(dashed.drawables[1].options.strokeLineDash, undefined);
});

test('round multi-point connectors are curves aimed along the bend; sharp ones are polylines', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }];
  const curved = buildShape(arrow(pts, { roundness: 'round' }));
  assert.equal(curved.drawables[0].shape, 'curve');
  const sharp = buildShape(arrow(pts, { roundness: 'sharp' }));
  assert.equal(sharp.drawables[0].shape, 'linearPath');
  const twoPoint = buildShape(arrow([pts[0], pts[2]], { roundness: 'round' }));
  assert.equal(twoPoint.drawables[0].shape, 'linearPath', 'a 2-point round connector is straight');

  const straight = connectorEnds(pts, false);
  assert.deepEqual(straight.end.from, pts[1], 'polyline end aims from the previous point');
  const bend = connectorEnds(pts, true);
  assert.deepEqual(bend.end.tip, pts[2]);
  assert.notDeepEqual(bend.end.from, pts[1], 'curve end aims along the curve, not the chord');
  assert.ok(dist(bend.end.from, pts[2]) < dist(pts[1], pts[2]));
  // Duplicate end points are skipped when finding the direction.
  const dup = connectorEnds([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 0 }], false);
  assert.deepEqual(dup.end.from, { x: 0, y: 0 });
});

test('connector points are local to the min corner of the points', () => {
  const s = buildShape(arrow([{ x: 300, y: 400 }, { x: 250, y: 500 }], { endArrowhead: 'none' }));
  assert.deepEqual(s.origin, { x: 250, y: 400 });
  // preserveVertices: the shaft starts exactly on the first point (local 50,0).
  const first = s.drawables[0].sets[0].ops[0];
  assert.equal(first.op, 'move');
  assert.deepEqual(first.data, [50, 0]);
});

/* ------------------------------------------------------------------ *
 * Freehand
 * ------------------------------------------------------------------ */

test('pen outline is a non-empty closed polygon, and a tap is a dot', () => {
  const pts = [];
  for (let i = 0; i < 30; i++) pts.push({ x: i * 4, y: Math.sin(i / 4) * 20 });
  const outline = penOutline(pts, 2);
  assert.ok(outline.length > 10, `outline has ${outline.length} points`);
  assert.ok(outline.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])));
  const d = outlineToPath(outline);
  assert.match(d, /^M [-\d.]+ [-\d.]+ Q /);
  assert.match(d, / Z$/);

  const tap = penOutline([{ x: 5, y: 5 }], 2);
  assert.ok(tap.length > 3, 'a single point still paints a dot');

  const shape = buildShape({ id: 'p', type: 'pen', x: 0, y: 0, w: 0, h: 0, points: pts, stroke: '#e03131', strokeWidth: 2 });
  assert.equal(shape.kind, 'pen');
  assert.ok(shape.path.length > 20);
  assert.equal(shape.fill, '#e03131');
  const thick = penOutline(pts, 4);
  const widthOf = (o) => Math.max(...o.map((p) => p[1])) - Math.min(...o.map((p) => p[1]));
  assert.ok(widthOf(thick) > widthOf(outline), 'strokeWidth scales the stroke');
  assert.equal(outlineToPath([]), '');
});

/* ------------------------------------------------------------------ *
 * Text metrics and dark colours
 * ------------------------------------------------------------------ */

test('baselineOffset centres the font box in the line box like CSS', () => {
  const fs = 20;
  const lh = 25;
  const m = { ascent: FONT_METRICS.hand.ascent * fs, descent: FONT_METRICS.hand.descent * fs };
  const off = baselineOffset(lh, m);
  assert.ok(close(off, (25 - 25.2) / 2 + 17.72, 1e-9));
});

test('darkRgb maps white to the dark canvas and black to near-white', () => {
  assert.deepEqual(darkRgb(255, 255, 255), [18, 18, 18]);
  assert.deepEqual(darkRgb(0, 0, 0), [237, 237, 237]);
});

/* ------------------------------------------------------------------ *
 * drawElement against a fake context
 * ------------------------------------------------------------------ */

test('drawElement: save/restore bracket, opacity and rotation about the centre', () => {
  const ctx = fakeCtx();
  drawElement(ctx, rect({ opacity: 0.5, rotation: Math.PI / 2 }), { zoom: 1 });
  assert.equal(ctx.calls[0][0], 'save');
  assert.equal(ctx.calls.at(-1)[0], 'restore');
  assert.equal(named(ctx, 'save').length, named(ctx, 'restore').length);
  assert.deepEqual(named(ctx, 'rotate')[0], ['rotate', Math.PI / 2]);
  // translate(centre) ... rotate ... translate(-centre)
  const tr = named(ctx, 'translate');
  assert.deepEqual(tr[0], ['translate', 70, 60]);
  assert.deepEqual(tr[1], ['translate', -70, -60]);
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'globalAlpha' && c[2] === 0.5));
  assert.ok(named(ctx, 'stroke').length > 0, 'outline stroked');
  assert.equal(ctx.props.globalAlpha, 1, 'nothing leaks out of the bracket');
});

test('drawElement: invisible elements paint nothing; polylines ignore rotation', () => {
  const ctx = fakeCtx();
  drawElement(ctx, rect({ opacity: 0 }));
  assert.equal(ctx.calls.length, 0);
  drawElement(ctx, arrow([{ x: 0, y: 0 }, { x: 10, y: 10 }], { rotation: 1 }));
  assert.equal(named(ctx, 'rotate').length, 0);
});

test('drawElement: text is laid out with layoutText, baseline-corrected, and hidden while editing', () => {
  const el = { id: 't', type: 'text', x: 5, y: 7, w: 100, h: 50, text: 'um\ndois', fontSize: 20, fontFamily: 'hand', stroke: '#e03131' };
  const ctx = fakeCtx();
  drawElement(ctx, el);
  const texts = named(ctx, 'fillText');
  assert.equal(texts.length, 2);
  const layout = layoutText(el);
  const off = baselineOffset(layout.lineHeight, { ascent: FONT_METRICS.hand.ascent * 20, descent: FONT_METRICS.hand.descent * 20 });
  assert.deepEqual([...texts[0]], ['fillText', 'um', layout.lines[0].x, layout.lines[0].y + off]);
  assert.deepEqual(texts[1].slice(0, 2), ['fillText', 'dois']);
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === '#e03131'));

  const editing = fakeCtx();
  drawElement(editing, el, { isEditing: true });
  assert.equal(named(editing, 'fillText').length, 0);
});

test('drawElement: container labels are painted inside the shape, not while editing', () => {
  const el = rect({ label: 'Olá' });
  const ctx = fakeCtx();
  drawElement(ctx, el);
  assert.deepEqual(named(ctx, 'fillText').map((c) => c[1]), ['Olá']);
  const editing = fakeCtx();
  drawElement(editing, el, { isEditing: true });
  assert.equal(named(editing, 'fillText').length, 0);
  assert.ok(named(editing, 'stroke').length > 0, 'the shape itself is still painted');
});

test('drawElement: sticky is a crisp filled note with a shadow and its label', () => {
  const ctx = fakeCtx();
  drawElement(ctx, { id: 's', type: 'sticky', x: 0, y: 0, w: 200, h: 200, label: 'nota', fill: '#ffec99' }, { zoom: 2 });
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'shadowBlur' && c[2] > 0));
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === '#ffec99'));
  assert.deepEqual(named(ctx, 'fillText').map((c) => c[1]), ['nota']);
  assert.equal(named(ctx, 'bezierCurveTo').length, 0, 'no rough strokes on a sticky');
});

test('drawElement: an image uses the supplied cache, a missing one draws the placeholder', () => {
  const img = { tag: 'bitmap' };
  const el = { id: 'i', type: 'image', x: 1, y: 2, w: 30, h: 40, src: 'data:image/png;base64,AAAA' };
  const ctx = fakeCtx();
  drawElement(ctx, el, { imageCache: new Map([[el.src, img]]) });
  assert.deepEqual(named(ctx, 'drawImage')[0], ['drawImage', img, 1, 2, 30, 40]);
  const ph = fakeCtx();
  drawElement(ph, el, { imageCache: new Map([[el.src, null]]) });
  assert.equal(named(ph, 'drawImage').length, 0);
  assert.deepEqual(named(ph, 'fillRect')[0], ['fillRect', 1, 2, 30, 40]);
});

test('drawRough replays fill sketches with the fill colour and the outline with the stroke', () => {
  const ctx = fakeCtx();
  const d = buildShape(rect()).drawables[0];
  drawRough(ctx, d);
  const styles = ctx.calls.filter((c) => c[0] === 'set' && c[1] === 'strokeStyle').map((c) => c[2]);
  assert.ok(styles.includes('#a5d8ff'), 'hachure in the fill colour');
  assert.ok(styles.includes('#1e1e1e'), 'outline in the stroke colour');
});

/* ------------------------------------------------------------------ *
 * Scene rendering
 * ------------------------------------------------------------------ */

test('renderStatic: background, board transform, culling, ghosting and the draft', () => {
  const ctx = fakeCtx(1600, 1200);
  const onScreen = rect({ id: 'on', x: 10, y: 10 });
  const offScreen = rect({ id: 'off', x: 5000, y: 5000 });
  const ghost = rect({ id: 'ghost', x: 200, y: 10, label: 'x' });
  const draft = { id: 'draft', type: 'ellipse', x: 100, y: 100, w: 50, h: 50, stroke: '#000' };
  const res = renderStatic(ctx, {
    elements: [onScreen, offScreen, ghost],
    view: { zoom: 2, panX: 10, panY: 20 },
    width: 800,
    height: 600,
    dpr: 2,
    showGrid: true,
    gridSize: 20,
    erasingIds: new Set(['ghost']),
    draft,
  });
  assert.deepEqual(res, { drawn: 3, culled: 1, cached: 0 }, "node has no canvas to cache into");
  assert.deepEqual(named(ctx, 'fillRect')[0], ['fillRect', 0, 0, 1600, 1200]);
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === CANVAS_BACKGROUND));
  assert.ok(named(ctx, 'setTransform').some((c) => c.slice(1).join() === [4, 0, 0, 4, 20, 40].join()), 'dpr*zoom board transform');
  const ghostText = named(ctx, 'fillText').find((c) => c[1] === 'x');
  assert.equal(ghostText.alpha, 0.3, 'erasing elements are painted at 30%');
});

test('renderStatic: no grid below zoom 0.3', () => {
  const ctx = fakeCtx();
  renderStatic(ctx, { elements: [], view: { zoom: 0.25, panX: 0, panY: 0 }, width: 800, height: 600, dpr: 1, showGrid: true, gridSize: 20 });
  assert.equal(named(ctx, 'moveTo').length, 0);
  const on = fakeCtx();
  renderStatic(on, { elements: [], view: { zoom: 1, panX: 0, panY: 0 }, width: 800, height: 600, dpr: 1, showGrid: true, gridSize: 20 });
  assert.ok(named(on, 'moveTo').length > 40);
});

test('isElementVisible / visibleBoardRect use the view convention screen = board*zoom + pan', () => {
  const r = visibleBoardRect({ zoom: 2, panX: 100, panY: 50 }, 800, 600);
  assert.deepEqual(r, { x: -50, y: -25, w: 400, h: 300 });
  assert.equal(isElementVisible(rect({ x: 0, y: 0 }), r), true);
  assert.equal(isElementVisible(rect({ x: 1000, y: 0 }), r), false);
  // A connector is tested by its points, not its (stale) box.
  assert.equal(isElementVisible(arrow([{ x: -200, y: 0 }, { x: -100, y: 0 }]), r), false);
});

test('renderInteractive: single selection draws a frame, square handles and a round rotation handle', () => {
  const ctx = fakeCtx();
  const el = rect({ id: 'sel' });
  renderInteractive(ctx, {
    elements: [el],
    selection: new Set(['sel']),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
    dpr: 1,
    interaction: { mode: 'idle' },
  });
  assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === SELECTION_COLOR));
  assert.equal(named(ctx, 'arc').length, 1, 'one round rotation handle');
  assert.equal(named(ctx, 'arcTo').length, 8 * 4, 'eight rounded square handles');
});

test('renderInteractive: locked selection shows no handles; a linear selection shows its points', () => {
  const locked = fakeCtx();
  renderInteractive(locked, {
    elements: [rect({ id: 'l', locked: true })],
    selection: new Set(['l']),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
  });
  assert.equal(named(locked, 'arc').length, 0);
  assert.equal(named(locked, 'arcTo').length, 0);
  assert.ok(named(locked, 'stroke').length >= 1, 'the frame is still drawn');

  const lin = fakeCtx();
  const a = arrow([{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], { id: 'lin' });
  renderInteractive(lin, {
    elements: [a],
    selection: new Set(['lin']),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
    interaction: { mode: 'idle', linearEdit: { id: 'lin', hoverIndex: 1, activeIndex: 2 } },
  });
  assert.equal(named(lin, 'arc').length, 3, 'one handle per point');
  assert.equal(named(lin, 'arcTo').length, 0, 'no box handles for a single connector');
  assert.ok(lin.calls.some((c) => c[0] === 'set' && c[1] === 'fillStyle' && c[2] === SELECTION_COLOR), 'active point filled');
});

test('renderInteractive: marquee, eraser trail and remote cursors (not my own)', () => {
  const ctx = fakeCtx();
  renderInteractive(ctx, {
    elements: [],
    selection: new Set(),
    view: { zoom: 2, panX: 10, panY: 10 },
    width: 800,
    height: 600,
    dpr: 1,
    interaction: {
      mode: 'marquee',
      marquee: { x: 10, y: 10, w: -5, h: 20 },
      eraserTrail: [{ x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 }],
    },
    remoteCursors: new Map([
      ['p1', { x: 20, y: 30, name: 'Ana', color: '#e03131' }],
      ['me', { x: 20, y: 30, name: 'Eu', color: '#000' }],
    ]),
    myPeerId: 'me',
  });
  // Marquee normalised to a positive rect, in screen px: x=(5*2+10), w=5*2.
  assert.deepEqual(named(ctx, 'fillRect')[0], ['fillRect', 20, 30, 10, 40]);
  assert.deepEqual(named(ctx, 'fillText').map((c) => c[1]), ['Ana']);
  assert.ok(named(ctx, 'lineTo').length >= 2, 'trail segments');
});

test('renderInteractive: multi-selection gets a dashed common frame with handles', () => {
  const ctx = fakeCtx();
  renderInteractive(ctx, {
    elements: [rect({ id: 'a' }), rect({ id: 'b', x: 300 })],
    selection: new Set(['a', 'b']),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
  });
  assert.ok(named(ctx, 'setLineDash').some((c) => c[1].length === 2 && c[1][0] === 2), 'dashed frame');
  assert.equal(named(ctx, 'arc').length, 1, 'rotation handle on the common frame');
});

test('renderInteractive: bind target highlight accepts an id or an element', () => {
  for (const bindTarget of ['t', rect({ id: 't' })]) {
    const ctx = fakeCtx();
    renderInteractive(ctx, {
      elements: [rect({ id: 't' })],
      selection: new Set(),
      view: { zoom: 1, panX: 0, panY: 0 },
      width: 800,
      height: 600,
      interaction: { mode: 'linear', bindTarget },
    });
    assert.ok(ctx.calls.some((c) => c[0] === 'set' && c[1] === 'lineWidth' && c[2] >= 8), 'thick outline');
  }
});

test('renderInteractive: an optional draft is painted in board space', () => {
  const ctx = fakeCtx();
  renderInteractive(ctx, {
    elements: [],
    selection: new Set(),
    view: { zoom: 2, panX: 5, panY: 6 },
    width: 400,
    height: 300,
    dpr: 1,
    draft: rect({ id: 'draft' }),
  });
  assert.ok(named(ctx, 'setTransform').some((c) => c.slice(1).join() === [2, 0, 0, 2, 5, 6].join()));
  assert.ok(named(ctx, 'stroke').length > 0);
});

/* ------------------------------------------------------------------ *
 * Text that overflows its box: culling
 * ------------------------------------------------------------------ */

const LONG_LABEL = 'Um rótulo bem comprido que não cabe dentro do retângulo pequeno';

test('textPaintBounds covers every laid-out line, even past the box', () => {
  const el = rect({ id: 'ovf', x: 700, y: 300, w: 140, h: 50, label: LONG_LABEL, fill: 'none' });
  const layout = layoutText(el);
  assert.ok(layout.lines.length > 2, 'the label wraps to several lines');
  const top = layout.lines[0].y;
  const bottom = layout.lines.at(-1).y + layout.lineHeight;
  assert.ok(top < el.y && bottom > el.y + el.h, 'the label spills above and below the box');
  const t = textPaintBounds(el);
  assert.ok(t.y <= top && t.y + t.h >= bottom, 'vertical extent of all lines');
  assert.equal(textPaintBounds(rect({ id: 'nolabel' })), null, 'no text, no text bounds');
  // Rotated a quarter turn: the tall column of lines becomes a wide row.
  const turned = textPaintBounds({ ...el, rotation: Math.PI / 2 });
  assert.ok(turned.w > t.w && turned.h < t.h, 'rotated with the element');
  const cx = el.x + el.w / 2;
  assert.ok(Math.abs(turned.x + turned.w / 2 - cx) < 1, 'about the element centre');
});

test('isElementVisible keeps an element whose label still shows on screen', () => {
  const el = rect({ id: 'cull', x: 700, y: 300, w: 140, h: 50, label: LONG_LABEL, fill: 'none', strokeWidth: 2 });
  const layout = layoutText(el);
  const bottom = layout.lines.at(-1).y + layout.lineHeight;
  // The viewport starts below the box (and its stroke margin) but above the
  // last line of the label.
  const viewTop = bottom - 12;
  assert.ok(viewTop > el.y + el.h + 2 * 2 + 8, 'the box alone would be culled');
  const view = { zoom: 1, panX: -600, panY: -viewTop };
  assert.equal(isElementVisible(el, visibleBoardRect(view, 1280, 800)), true);
  const below = { zoom: 1, panX: -600, panY: -(bottom + 20) };
  assert.equal(isElementVisible(el, visibleBoardRect(below, 1280, 800)), false, 'culled once all of it is off screen');
  // A sticky whose text runs out of the bottom of the note.
  const note = { id: 'n', type: 'sticky', x: 0, y: 0, w: 200, h: 200, label: 'palavra '.repeat(60).trim(), fill: '#ffec99' };
  const nl = layoutText(note);
  const nBottom = nl.lines.at(-1).y + nl.lineHeight;
  assert.ok(nBottom > 260, 'the text overflows the note');
  const r = visibleBoardRect({ zoom: 1, panX: 0, panY: -(nBottom - 10) }, 800, 600);
  assert.equal(isElementVisible(note, r), true);
});

/* ------------------------------------------------------------------ *
 * Pen strokes: a drag re-uses the outline
 * ------------------------------------------------------------------ */

function penStroke(id, dx = 0, dy = 0, n = 200) {
  const points = [];
  for (let k = 0; k < n; k++) points.push({ x: 100 + dx + k * 0.7 + Math.sin(k / 9) * 15, y: 50 + dy + Math.cos(k / 11) * 20 });
  return { id, type: 'pen', x: 0, y: 0, w: 0, h: 0, points, stroke: '#1e1e1e', strokeWidth: 2 };
}

test('getShape: a moved pen stroke re-uses its outline (and the compiled path) at the new origin', () => {
  invalidateShape();
  const a = penStroke('pen-move');
  const s1 = getShape(a);
  // A drag: a new object, every absolute point shifted (by a fractional step).
  const b = { ...a, points: a.points.map((p) => ({ x: p.x + 13.37, y: p.y - 0.1 })) };
  const s2 = getShape(b);
  assert.notEqual(s2, s1, 'a different object gets its own desc');
  assert.equal(s2.geom, s1.geom, 'the outline is shared');
  assert.equal(s2.path, s1.path);
  assert.ok(Math.abs(s2.origin.x - s1.origin.x - 13.37) < 1e-9 && Math.abs(s2.origin.y - s1.origin.y + 0.1) < 1e-9);
  // Anything that changes the shape builds a new outline.
  const scaled = { ...a, points: a.points.map((p) => ({ x: p.x * 1.5, y: p.y })) };
  assert.notEqual(getShape(scaled).geom, s1.geom, 'resized -> new outline');
  assert.notEqual(getShape({ ...a, strokeWidth: 4 }).geom, getShape(scaled).geom, 'restyled -> new outline');
  const recoloured = getShape({ ...a, stroke: '#e03131' });
  assert.equal(recoloured.fill, '#e03131');
  // Another stroke with the same shape but another id is built on its own.
  assert.equal(getShape({ ...a, id: 'pen-other' }).path, s1.path);
});

test('getShape: moving 150 long pen strokes costs far less than building them', () => {
  invalidateShape();
  let els = Array.from({ length: 150 }, (_, i) => penStroke(`bench-${i}`, (i % 15) * 120, Math.floor(i / 15) * 120, 400));
  let t = performance.now();
  for (const e of els) getShape(e);
  const build = performance.now() - t;
  const moves = [];
  for (let f = 0; f < 5; f++) {
    els = els.map((e) => ({ ...e, points: e.points.map((p) => ({ x: p.x + 1, y: p.y + 1 })) }));
    t = performance.now();
    for (const e of els) getShape(e);
    moves.push(performance.now() - t);
  }
  moves.sort((x, y) => x - y);
  assert.ok(moves[2] < build / 4, `move ${moves[2].toFixed(1)} ms vs build ${build.toFixed(1)} ms`);
});

/* ------------------------------------------------------------------ *
 * Dark mode: images and collaborators keep their colours
 * ------------------------------------------------------------------ */

test('DARK_MODE_COUNTER_FILTER is the inverse chain of the dark filter', () => {
  assert.equal(DARK_MODE_COUNTER_FILTER, 'hue-rotate(180deg) invert(100%) contrast(116.279%)');
});

test('darkPreimage: what to paint so the dark filter shows the colour', () => {
  for (const c of [
    [128, 128, 128],
    [200, 120, 60],
    [240, 200, 180],
    [60, 120, 180],
    [180, 90, 140],
  ]) {
    const shown = darkRgb(...darkPreimage(...c));
    assert.ok(shown.every((v, i) => Math.abs(v - c[i]) <= 2), `${c} shows as ${shown}`);
  }
  // Out of the filter's range: pulled toward grey, greys stay grey.
  assert.deepEqual(darkRgb(...darkPreimage(255, 255, 255)), [237, 237, 237]);
  assert.deepEqual(darkRgb(...darkPreimage(0, 0, 0)), [18, 18, 18]);
  const red = darkRgb(...darkPreimage(224, 49, 49));
  assert.ok(red[0] > red[1] + 60 && Math.abs(red[1] - red[2]) <= 2, `red stays red: ${red}`);
});

test('parseColor / colorForDarkCanvas', () => {
  assert.deepEqual(parseColor('#e03131'), [224, 49, 49, 1]);
  assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
  assert.deepEqual(parseColor('rgba(255, 255, 255, 0.9)'), [255, 255, 255, 0.9]);
  assert.deepEqual(parseColor('hsl(92 72% 45%)'), [109, 197, 32, 1]);
  assert.deepEqual(parseColor('hsla(92, 72%, 45%, 0.5)'), [109, 197, 32, 0.5]);
  assert.equal(parseColor('papayawhip'), null);
  const painted = colorForDarkCanvas('hsl(92 72% 45%)');
  const [r, g, b] = parseColor(painted);
  const shown = darkRgb(r, g, b);
  assert.ok(Math.abs(shown[0] - 109) < 12 && Math.abs(shown[1] - 197) < 30 && shown[1] > shown[0] && shown[1] > shown[2], `${shown}`);
  assert.match(colorForDarkCanvas('rgba(255, 255, 255, 0.9)'), /^rgba\(0, 0, 0, 0\.9\)$/);
  assert.equal(colorForDarkCanvas('papayawhip'), 'papayawhip', 'unparseable (no context): unchanged');
  assert.equal(isDarkCanvas('dark'), true);
  assert.equal(isDarkCanvas('light', { canvas: { style: { filter: 'invert(93%)' } } }), false, 'an explicit theme wins');
  assert.equal(isDarkCanvas(undefined, { canvas: { style: { filter: 'invert(93%) hue-rotate(180deg)' } } }), true);
  assert.equal(isDarkCanvas(undefined, { canvas: { style: { filter: '' } } }), false);
  assert.equal(isDarkCanvas(undefined, { canvas: {} }), false);
});

test('drawElement: in dark mode an image is drawn through the counter filter, and only the image', () => {
  const img = { tag: 'bitmap' };
  const el = { id: 'i', type: 'image', x: 1, y: 2, w: 30, h: 40, src: 'data:image/png;base64,AAAA' };
  const ctx = fakeCtx();
  drawElement(ctx, el, { imageCache: new Map([[el.src, img]]), dark: true });
  const filterSets = ctx.calls.filter((c) => c[0] === 'set' && c[1] === 'filter');
  assert.deepEqual(filterSets.map((c) => c[2]), [DARK_MODE_COUNTER_FILTER]);
  const setAt = ctx.calls.indexOf(filterSets[0]);
  const drawAt = ctx.calls.findIndex((c) => c[0] === 'drawImage');
  assert.ok(setAt < drawAt, 'filter set before drawing');
  assert.equal(ctx.props.filter, 'none', 'and restored after');

  const light = fakeCtx();
  drawElement(light, el, { imageCache: new Map([[el.src, img]]) });
  assert.equal(light.calls.filter((c) => c[0] === 'set' && c[1] === 'filter').length, 0);
  const placeholder = fakeCtx();
  drawElement(placeholder, el, { imageCache: new Map([[el.src, null]]), dark: true });
  assert.equal(placeholder.calls.filter((c) => c[0] === 'set' && c[1] === 'filter').length, 0, 'the placeholder goes dark with the rest');
  const shape = fakeCtx();
  drawElement(shape, rect(), { dark: true });
  assert.equal(shape.calls.filter((c) => c[0] === 'set' && c[1] === 'filter').length, 0, 'drawings are not countered');
});

test('renderStatic: the theme (or the canvas filter) reaches the image painter', () => {
  // An Image stub that "decodes" as soon as it gets a src, so getImage
  // returns a bitmap on the first paint.
  const prevImage = globalThis.Image;
  globalThis.Image = class {
    set src(v) {
      this._src = v;
      this.onload?.();
    }
    get src() {
      return this._src;
    }
  };
  try {
    const base = {
      elements: [{ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:image/png;base64,REFSSw==' }],
      view: { zoom: 1, panX: 0, panY: 0 },
      width: 100,
      height: 100,
    };
    const countered = (ctx) => ctx.calls.some((c) => c[0] === 'set' && c[1] === 'filter' && c[2] === DARK_MODE_COUNTER_FILTER);
    const explicit = fakeCtx();
    renderStatic(explicit, { ...base, theme: 'dark' });
    assert.equal(named(explicit, 'drawImage').length, 1);
    assert.ok(countered(explicit), "theme: 'dark'");
    const inferred = fakeCtx();
    inferred.canvas.style = { filter: 'invert(93%) hue-rotate(180deg)' };
    renderStatic(inferred, base);
    assert.ok(countered(inferred), 'no theme given: read from the canvas filter');
    const light = fakeCtx();
    light.canvas.style = { filter: '' };
    renderStatic(light, base);
    assert.equal(named(light, 'drawImage').length, 1);
    assert.ok(!countered(light), 'light: drawn as is');
  } finally {
    if (prevImage === undefined) delete globalThis.Image;
    else globalThis.Image = prevImage;
  }
});

test('renderInteractive: in dark mode remote cursors and peer selections are pre-countered', () => {
  const base = {
    elements: [rect({ id: 'peer-sel' })],
    selection: new Set(),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
    dpr: 1,
    remoteCursors: new Map([['p1', { x: 20, y: 30, name: 'Zeca', color: '#e03131' }]]),
    peerSelections: new Map([['p1', { ids: ['peer-sel'], color: '#e03131' }]]),
  };
  const styles = (ctx, k) => ctx.calls.filter((c) => c[0] === 'set' && c[1] === k).map((c) => c[2]);
  const light = fakeCtx();
  renderInteractive(light, base);
  assert.ok(styles(light, 'fillStyle').includes('#e03131'));
  assert.ok(styles(light, 'fillStyle').includes('#ffffff'), 'white label');
  const dark = fakeCtx();
  renderInteractive(dark, { ...base, theme: 'dark' });
  const want = colorForDarkCanvas('#e03131');
  assert.ok(styles(dark, 'fillStyle').includes(want), 'cursor and tag painted with the counter colour');
  assert.ok(!styles(dark, 'fillStyle').includes('#e03131'));
  assert.ok(styles(dark, 'fillStyle').includes(colorForDarkCanvas('#ffffff')), 'label painted so it shows white');
  assert.ok(styles(dark, 'strokeStyle').includes(want), 'peer selection frame too');
});

/* ------------------------------------------------------------------ *
 * Hover, point editing, eraser trail
 * ------------------------------------------------------------------ */

const HOVER = 'rgba(105, 101, 219, 0.45)';

/** The screen points of the frame stroked right after a strokeStyle set. */
function framePointsAfter(ctx, color) {
  const i = ctx.calls.findIndex((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === color);
  if (i < 0) return null;
  const pts = [];
  for (let j = i + 1; j < ctx.calls.length && ctx.calls[j][0] !== 'stroke'; j++) {
    if (ctx.calls[j][0] === 'moveTo' || ctx.calls[j][0] === 'lineTo') pts.push({ x: ctx.calls[j][1], y: ctx.calls[j][2] });
  }
  return pts;
}

test('renderInteractive: hovering a grouped element outlines the whole group (what a click selects)', () => {
  const a = rect({ id: 'ga', x: 0, y: 0, w: 100, h: 50, groupId: 'G' });
  const b = { id: 'gb', type: 'ellipse', x: 300, y: 200, w: 80, h: 80, stroke: '#000', groupId: 'G' };
  const c = rect({ id: 'solo', x: 600, y: 0 });
  const frame = selectionFrame([a, b], 1);
  const params = {
    elements: [a, b, c],
    selection: new Set(),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
    interaction: { mode: 'idle' },
  };
  const ctx = fakeCtx();
  renderInteractive(ctx, { ...params, hoveredId: 'ga' });
  const pts = framePointsAfter(ctx, HOVER);
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  assert.ok(Math.abs(Math.min(...xs) - frame.x) < 1e-6 && Math.abs(Math.max(...xs) - (frame.x + frame.w)) < 1e-6);
  assert.ok(Math.abs(Math.max(...ys) - (frame.y + frame.h)) < 1e-6, 'reaches the other member');

  const solo = fakeCtx();
  renderInteractive(solo, { ...params, hoveredId: 'solo' });
  const sp = framePointsAfter(solo, HOVER);
  const sf = selectionFrame([c], 1);
  assert.ok(Math.abs(Math.min(...sp.map((p) => p.x)) - sf.x) < 1e-6, 'an ungrouped element frames itself');

  const selected = fakeCtx();
  renderInteractive(selected, { ...params, hoveredId: 'ga', selection: new Set(['ga', 'gb']) });
  assert.equal(framePointsAfter(selected, HOVER), null, 'no hover frame over a selected group');
});

test('renderInteractive: point editing shows a halo and "+" midpoints; plain selection does not', () => {
  const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 150 }, { x: 205, y: 152 }];
  const a = arrow(pts, { id: 'pe' });
  const base = {
    elements: [a],
    selection: new Set(['pe']),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
  };
  const halo = (ctx) => ctx.calls.some((c) => c[0] === 'set' && c[1] === 'strokeStyle' && c[2] === 'rgba(105, 101, 219, 0.2)');
  const plain = fakeCtx();
  renderInteractive(plain, { ...base, interaction: { mode: 'idle', linearEdit: { id: 'pe', hoverIndex: -1, activeIndex: -1, editing: false } } });
  assert.equal(named(plain, 'arc').length, 4, 'only the point handles');
  assert.ok(!halo(plain));

  const editing = fakeCtx();
  renderInteractive(editing, { ...base, interaction: { mode: 'idle', linearEdit: { id: 'pe', hoverIndex: -1, activeIndex: -1, editing: true } } });
  assert.ok(halo(editing), 'a halo along the connector');
  // 4 points + a "+" on each of the two long segments (the last one is too
  // short on screen for a marker).
  const arcs = named(editing, 'arc');
  assert.equal(arcs.length, 6);
  const centres = arcs.map((c) => ({ x: c[1], y: c[2] }));
  for (const m of segmentMidpoints(pts, false).slice(0, 2)) assert.ok(centres.some((c) => c.x === m.x && c.y === m.y), `marker at ${m.x},${m.y}`);
  assert.ok(!named(editing, 'setLineDash').some((c) => c[1].length === 2 && c[1][0] === 4), 'a sharp connector needs no control polygon');

  // A round connector: the halo follows the curve, the control polygon is dashed.
  const round = fakeCtx();
  const curvedPts = pts.slice(0, 3);
  renderInteractive(round, {
    ...base,
    elements: [arrow(curvedPts, { id: 'pe', roundness: 'round' })],
    interaction: { mode: 'idle', linearEdit: { id: 'pe', hoverIndex: -1, activeIndex: -1, editing: true } },
  });
  assert.equal(named(round, 'bezierCurveTo').length, 2, 'halo along the two curve pieces');
  assert.ok(named(round, 'setLineDash').some((c) => c[1].length === 2 && c[1][0] === 4), 'dashed control polygon');
  const curved = segmentMidpoints(curvedPts, true);
  assert.notDeepEqual(curved[0], { x: 100, y: 0 }, 'markers sit on the curve');
  assert.ok(named(round, 'arc').some((c) => c[1] === curved[0].x && c[2] === curved[0].y));
  assert.equal(segmentMidpoints([pts[0]], false).length, 0);
});

test('eraser trail: one tapered polygon filled once, no per-segment strokes', () => {
  const trail = [];
  for (let i = 0; i < 30; i++) trail.push({ x: i * 10, y: 100 + Math.sin(i / 3) * 30 });
  const poly = eraserTrailOutline(trail);
  assert.ok(poly.length > trail.length * 2, 'both sides plus a round head');
  // Tapered: a hairline at the oldest point, the full width at the newest.
  const n = trail.length;
  const tailWidth = Math.hypot(poly[0].x - poly.at(-1).x, poly[0].y - poly.at(-1).y);
  assert.ok(Math.abs(tailWidth - 1) < 1e-6, `tail ${tailWidth}`);
  const headL = poly[n - 1];
  const headR = poly[poly.length - n];
  assert.ok(Math.abs(Math.hypot(headL.x - headR.x, headL.y - headR.y) - 5) < 1e-6, 'head width');
  assert.deepEqual(eraserTrailOutline([{ x: 1, y: 1 }, { x: 1.1, y: 1 }]), [], 'no zero-length trail');

  const ctx = fakeCtx();
  renderInteractive(ctx, {
    elements: [],
    selection: new Set(),
    view: { zoom: 1, panX: 0, panY: 0 },
    width: 800,
    height: 600,
    interaction: { mode: 'erasing', eraserTrail: trail },
  });
  assert.equal(named(ctx, 'fill').length, 1, 'a single fill');
  assert.equal(named(ctx, 'stroke').length, 0, 'no translucent strokes whose caps overlap');
  assert.equal(named(ctx, 'createLinearGradient').length, 1, 'fading from the oldest to the newest end');
});

/* ------------------------------------------------------------------ *
 * Sticky shadow sprites
 * ------------------------------------------------------------------ */

/** Run `fn` with a fake OffscreenCanvas that counts the sprites made. */
function withFakeOffscreen(fn) {
  const made = [];
  const prev = globalThis.OffscreenCanvas;
  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      made.push(this);
    }
    getContext() {
      return fakeCtx(this.width, this.height);
    }
  };
  try {
    fn(made);
  } finally {
    if (prev === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = prev;
  }
}

// No labels here: text measurement would cache the fake canvas in text.js.
const note = (w, h, extra = {}) => ({ id: `n${w}x${h}`, type: 'sticky', x: 10, y: 20, w, h, label: '', fill: '#ffec99', ...extra });

test('sticky shadow: one 9-slice sprite serves every note size, at any zoom, with no live blur', () => {
  withFakeOffscreen((made) => {
    const ctx = fakeCtx();
    // A zoom not used by any other test, so the sprite is made here.
    for (let i = 0; i < 120; i++) drawElement(ctx, note(150 + i, 110 + (i % 7)), { zoom: 1.37 });
    assert.equal(made.length, 1, '120 sizes, one sprite');
    assert.equal(ctx.calls.filter((c) => c[0] === 'set' && c[1] === 'shadowBlur').length, 0, 'no live shadowBlur');
    const blits = named(ctx, 'drawImage');
    assert.equal(blits.length, 120 * 8, 'eight pieces per opaque note (the middle is hidden under it)');
    // The pieces tile the shadow exactly: corners, stretched edges.
    const first = blits.slice(0, 8);
    const m = 16;
    const dests = first.map((c) => c.slice(6)); // [dx, dy, dw, dh]
    const left = Math.min(...dests.map((d) => d[0]));
    const right = Math.max(...dests.map((d) => d[0] + d[2]));
    assert.ok(Math.abs(left - (10 - m)) < 1e-9 && Math.abs(right - (10 + 150 + m)) < 1e-9, 'covers the note plus the margin');

    const translucent = fakeCtx();
    drawElement(translucent, note(200, 200, { opacity: 0.5 }), { zoom: 1.37 });
    assert.equal(named(translucent, 'drawImage').length, 9, 'a see-through note shows the middle too');

    const huge = fakeCtx();
    drawElement(huge, note(200, 200), { zoom: 40 });
    assert.equal(huge.calls.filter((c) => c[0] === 'set' && c[1] === 'shadowBlur').length, 0, 'still a sprite at zoom 40');
    assert.ok(made.every((c) => c.width <= 2048 && c.height <= 2048), 'sprites never exceed 2048 px');

    const small = fakeCtx();
    const before = made.length;
    drawElement(small, note(2 * SHADOW_SLICE_K - 10, 40), { zoom: 1.37 });
    assert.equal(named(small, 'drawImage').length, 1, 'a note too small to slice has its own sprite');
    assert.equal(made.length, before + 1);
  });
});

test('renderStatic: with no theme given, a change of the canvas filter asks for a repaint', () => {
  const prev = globalThis.MutationObserver;
  const observers = [];
  globalThis.MutationObserver = class {
    constructor(cb) {
      this.cb = cb;
      observers.push(this);
    }
    observe(target, opts) {
      this.target = target;
      this.opts = opts;
    }
  };
  try {
    const ctx = fakeCtx();
    ctx.canvas.nodeType = 1;
    ctx.canvas.style = { filter: '' };
    let repaints = 0;
    const p = { elements: [], view: { zoom: 1, panX: 0, panY: 0 }, width: 10, height: 10, onImageLoad: () => repaints++ };
    renderStatic(ctx, p);
    renderStatic(ctx, p);
    assert.equal(observers.length, 1, 'one observer per canvas');
    assert.deepEqual(observers[0].opts.attributeFilter, ['style']);
    observers[0].cb();
    assert.equal(repaints, 0, 'a style change that leaves the filter alone does nothing');
    ctx.canvas.style.filter = 'invert(93%) hue-rotate(180deg)';
    observers[0].cb();
    assert.equal(repaints, 1, 'the theme switch repaints');
    // An explicit theme needs no watching.
    const explicit = fakeCtx();
    explicit.canvas.nodeType = 1;
    explicit.canvas.style = { filter: '' };
    renderStatic(explicit, { ...p, theme: 'dark' });
    assert.equal(observers.length, 1);
  } finally {
    if (prev === undefined) delete globalThis.MutationObserver;
    else globalThis.MutationObserver = prev;
  }
});

/* ------------------------------------------------------------------ *
 * Per-element bitmaps (elementCache.js)
 * ------------------------------------------------------------------ */

/**
 * Run `fn` with a fake bitmap factory: every bitmap is a recording fake
 * context of its own. `made` lists the bitmaps created. No per-frame time
 * budget unless `budget` is given (a slow test machine must not change what
 * gets cached).
 */
async function withBitmaps(fn, budget = Infinity) {
  setBitmapRenderBudget(budget);
  const made = [];
  setBitmapCanvasFactory((w, h) => {
    const c = {
      width: w,
      height: h,
      ctx: null,
      getContext() {
        if (!this.ctx) this.ctx = fakeCtx(this.width, this.height);
        return this.ctx;
      },
    };
    made.push(c);
    return c;
  });
  try {
    await fn(made);
  } finally {
    setBitmapCanvasFactory(null);
    setBitmapRenderBudget(null);
  }
}

/** Calls that paint an element's geometry or text (not a blit). */
const vectorCalls = (ctx) => ctx.calls.filter((c) => ['stroke', 'fill', 'fillText'].includes(c[0]));

const scene = () => [
  rect({ id: 'b1', x: 0, y: 0, label: 'Olá' }),
  rect({ id: 'b2', x: 300, y: 40, fillStyle: 'cross-hatch' }),
  arrow([{ x: 10, y: 200 }, { x: 200, y: 260 }], { id: 'a2' }),
  { id: 't1', type: 'text', x: 20, y: 320, w: 120, h: 50, text: 'hello\nworld', stroke: '#1e1e1e' },
];

test('deviceView rounds the pan to whole device px, both layers share it', () => {
  const v = deviceView({ zoom: 1.5, panX: 10.3, panY: -4.4 }, 2);
  assert.deepEqual(v, { zoom: 1.5, panX: 10.5, panY: -4.5, originX: 21, originY: -9 });
  const ctx = fakeCtx(1600, 1200);
  renderStatic(ctx, { elements: [], view: { zoom: 1.5, panX: 10.3, panY: -4.4 }, width: 800, height: 600, dpr: 2 });
  assert.ok(named(ctx, 'setTransform').some((c) => c.slice(1).join() === [3, 0, 0, 3, 21, -9].join()), 'board origin on a device pixel');
});

/** The blits of a frame: [canvas, sx, sy, sw, sh, dx, dy, dw, dh] (atlas) or shorter (own canvas). */
const blitsOf = (ctx) => named(ctx, 'drawImage').map((c) => c.slice(1));

test('bitmap cache: a pan only blits, 1:1 at whole device px, with no vector replay', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    const els = scene();
    const base = { elements: els, width: 800, height: 600, dpr: 2, onImageLoad: () => {} };
    const first = renderStatic(ctx, { ...base, view: { zoom: 1, panX: 5, panY: 5 } });
    assert.equal(first.cached, 4, 'every element went through its bitmap');
    assert.equal(made.length, 1, 'small bitmaps share one atlas page (no canvas per element)');
    assert.equal(made[0].width, PAGE_SIZE);
    assert.equal(vectorCalls(ctx).length, 0, 'the target only receives blits');
    const page = made[0].ctx;
    assert.ok(named(page, 'fillText').some((c) => c[1] === 'Olá') && named(page, 'fillText').some((c) => c[1] === 'world'));
    assert.equal(named(page, 'clip').length, 4, 'each element is clipped to its slot');
    // Slots do not overlap.
    const slots = blitsOf(ctx).map(([, sx, sy, sw, sh]) => ({ sx, sy, sw, sh }));
    for (const a of slots) {
      for (const b of slots) {
        if (a === b) continue;
        const apart = a.sx + a.sw <= b.sx || b.sx + b.sw <= a.sx || a.sy + a.sh <= b.sy || b.sy + b.sh <= a.sy;
        assert.ok(apart, 'slots are disjoint');
      }
    }

    for (const panX of [7.3, 12.8, -40.25]) {
      ctx.calls.length = 0;
      page.calls.length = 0;
      const res = renderStatic(ctx, { ...base, view: { zoom: 1, panX, panY: 5.6 } });
      assert.equal(res.cached, 4);
      assert.equal(made.length, 1, 'no bitmap made on a pan');
      assert.equal(vectorCalls(ctx).length + vectorCalls(page).length, 0, 'no rough path or text replayed');
      const blits = blitsOf(ctx);
      assert.equal(blits.length, 4);
      for (const [, , , sw, sh, dx, dy, dw, dh] of blits) {
        assert.ok(dw === sw && dh === sh, 'drawn 1:1');
        assert.ok(Number.isInteger(dx) && Number.isInteger(dy), `at whole device px: ${dx},${dy}`);
      }
    }
    // The blit lands where drawing the element would: bitmap px 0 is
    // floor(scale * left) - 1 of the board, shifted by the rounded pan.
    const box = elementPaintBox(els[0]);
    ctx.calls.length = 0;
    renderStatic(ctx, { ...base, view: { zoom: 1, panX: 10.3, panY: 0 } });
    assert.equal(blitsOf(ctx)[0][5], Math.floor(box.x0 * 2) - 1 + 21);
  });
});

test('bitmap cache: a changed element is re-rasterised, one that keeps changing is drawn directly', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    let els = scene();
    const p = () => ({ elements: els, view: { zoom: 1, panX: 0, panY: 0 }, width: 800, height: 600, dpr: 2, onImageLoad: () => {} });
    renderStatic(ctx, p());
    const page = made[0].ctx;
    // A new object for b2 a moment after it was made: hot, drawn directly.
    els = els.map((e) => (e.id === 'b2' ? { ...e, x: e.x + 10 } : e));
    ctx.calls.length = 0;
    const r = renderStatic(ctx, p());
    assert.equal(r.cached, 3, 'the element being changed is drawn directly');
    assert.ok(vectorCalls(ctx).length > 0);
    // Once it has settled (HOT_MS), the next repaint caches it again.
    await new Promise((res) => setTimeout(res, HOT_MS + 20));
    els = els.map((e) => (e.id === 'b2' ? { ...e, x: e.x + 10 } : e));
    ctx.calls.length = 0;
    page.calls.length = 0;
    const settled = renderStatic(ctx, p());
    assert.equal(settled.cached, 4);
    assert.equal(made.length, 1, 'into the same page');
    assert.equal(vectorCalls(ctx).length, 0);
    assert.equal(named(page, 'clip').length, 1, 'only the changed element was re-rasterised');
    // invalidateElementCache (and the fonts loading) move the paint stamp:
    // the same object is painted anew.
    const t1 = els.find((e) => e.id === 't1');
    const before = paintStamp(t1);
    invalidateElementCache(t1);
    assert.notEqual(paintStamp(t1), before);
    page.calls.length = 0;
    await new Promise((res) => setTimeout(res, HOT_MS + 20));
    renderStatic(ctx, p());
    assert.deepEqual(named(page, 'fillText').map((c) => c[1]), ['hello', 'world'], 'the text alone is re-rasterised');
  });
});

test('bitmap cache: the edited element, images and ghosts', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    const els = [...scene(), { id: 'img', type: 'image', x: 400, y: 300, w: 50, h: 50, src: 'data:x' }];
    const res = renderStatic(ctx, {
      elements: els,
      view: { zoom: 1, panX: 0, panY: 0 },
      width: 800,
      height: 600,
      dpr: 1,
      editingId: 'b1',
      erasingIds: new Set(['b2']),
    });
    assert.equal(res.cached, 3, 'the edited element and the image are drawn directly');
    assert.equal(named(made[0].ctx, 'clip').length, 3);
    assert.ok(!named(ctx, 'fillText').some((c) => c[1] === 'Olá'), 'the edited label is not painted');
    assert.ok(!named(made[0].ctx, 'fillText').some((c) => c[1] === 'Olá'));
    // The ghost's blit happens at 30% alpha.
    const i = ctx.calls.findIndex((c) => c[0] === 'set' && c[1] === 'globalAlpha' && c[2] === 0.3);
    assert.ok(i >= 0);
    assert.equal(ctx.calls.slice(i).find((c) => c[0] === 'drawImage' || c[0] === 'restore')[0], 'drawImage');
  });
});

test('bitmap cache: a big bitmap gets a canvas of its own; pages fill and are recycled within budget', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    const big = rect({ id: 'big', x: 0, y: 0, w: 600, h: 400, label: '' });
    const r = renderStatic(ctx, { elements: [big], view: { zoom: 1, panX: 0, panY: 0 }, width: 800, height: 600, dpr: 1 });
    assert.equal(r.cached, 1);
    assert.equal(made.length, 1);
    assert.ok(made[0].width > ATLAS_MAX_SIDE && made[0].width < PAGE_SIZE, 'sized to the element');
    assert.equal(blitsOf(ctx)[0].length, 3, 'blitted whole, 1:1');

    // Thousands of small elements, far more than four pages hold, seen a
    // screenful at a time: pages are recycled, the budget never exceeded.
    const small = [];
    for (let i = 0; i < 4000; i++) small.push(rect({ id: `s${i}`, x: (i % 40) * 200, y: Math.floor(i / 40) * 150, w: 180, h: 130, label: '' }));
    const view = { zoom: 2, panX: 0, panY: 0 };
    const q = fakeCtx(1600, 1200);
    for (let row = 0; row < 100; row += 5) {
      const res = renderStatic(q, { elements: small, view: { ...view, panY: -row * 150 * 2 }, width: 1600, height: 1200, dpr: 1 });
      assert.equal(res.cached, res.drawn, `row ${row}: every visible element from a bitmap`);
      const st = bitmapCacheStats(q);
      assert.ok(st.px <= BITMAP_BUDGET_PX && st.pages <= BITMAP_BUDGET_PX / PAGE_SIZE ** 2, JSON.stringify(st));
    }
  });
});

test('elementPaintBox covers every stroke: wobble, arrowheads, rotation, overflowing text, sticky shadow', () => {
  const inside = (b, x, y) => x >= b.x0 - 1e-9 && x <= b.x1 + 1e-9 && y >= b.y0 - 1e-9 && y <= b.y1 + 1e-9;
  // A huge cartoonist ellipse wobbles far past its box (5% of the radius
  // times the roughness): the box comes from the Drawables, not a margin.
  const big = { id: 'big', type: 'ellipse', x: 0, y: 0, w: 3000, h: 2000, stroke: '#000', strokeWidth: 4, roughness: 2, seed: 3 };
  const box = elementPaintBox(big);
  const desc = getShape(big);
  let points = 0;
  for (const d of desc.drawables) {
    for (const set of d.sets) {
      for (const op of set.ops) {
        for (let i = 0; i + 1 < op.data.length; i += 2) {
          points++;
          assert.ok(inside(box, op.data[i] + desc.origin.x, op.data[i + 1] + desc.origin.y), 'every op point inside');
        }
      }
    }
  }
  assert.ok(points > 50);
  assert.ok(box.x0 <= -2 && box.y0 <= -2, 'half the stroke width outside the path');

  const a = arrow([{ x: 0, y: 0 }, { x: 100, y: 0 }], { endArrowhead: 'triangle', startArrowhead: 'dot', strokeWidth: 4 });
  const ab = elementPaintBox(a);
  assert.ok(ab.y0 < -8 && ab.y1 > 8, 'arrowheads stick out of a flat connector');
  assert.ok(ab.x0 < -2 && ab.x1 > 102);

  const r = rect({ rotation: Math.PI / 4, fill: null });
  const rb = elementPaintBox(r);
  const c = { x: r.x + r.w / 2, y: r.y + r.h / 2 };
  for (const [px, py] of [[r.x, r.y], [r.x + r.w, r.y], [r.x + r.w, r.y + r.h], [r.x, r.y + r.h]]) {
    const cos = Math.cos(r.rotation);
    const sin = Math.sin(r.rotation);
    const x = c.x + (px - c.x) * cos - (py - c.y) * sin;
    const y = c.y + (px - c.x) * sin + (py - c.y) * cos;
    assert.ok(inside(rb, x, y), 'rotated corners inside');
  }

  const long = rect({ w: 40, h: 30, label: 'a label much wider than its tiny box' });
  const tb = textPaintBounds(long);
  const lb = elementPaintBox(long);
  assert.ok(lb.x0 < tb.x && lb.x1 > tb.x + tb.w, 'overflowing label included');

  const n = { id: 'n', type: 'sticky', x: 0, y: 0, w: 100, h: 100, label: '' };
  const nb = elementPaintBox(n);
  assert.ok(nb.x0 <= -16 && nb.y1 >= 100 + 16 + 4, 'the shadow (margin + offset) included');

  assert.equal(elementPaintBox({ id: 'i', type: 'image', x: 0, y: 0, w: 10, h: 10 }), null, 'images are not boxed');
  assert.equal(elementPaintBox(rect({ opacity: 0 })), null, 'invisible: nothing to paint');
});

test('bitmap cache: never more than its pixel budget; least recently used out first', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(4000, 4000);
    // Bitmaps of ~3.7M px each: four fit in the 16M px budget, five do not.
    const side = 1900;
    const big = (i, x, y) => rect({ id: `big${i}`, x, y, w: side, h: side, fill: null, label: '' });
    const els = [big(0, 0, 0), big(1, 0, 3000), big(2, 3000, 0), big(3, 3000, 3000), big(4, 6000, 0), big(5, 6000, 3000)];
    const p = (panX, width) => ({ elements: els, view: { zoom: 1, panX, panY: 0 }, width, height: 5500, dpr: 1 });
    // Six in view: four fit, the other two are drawn directly (evicting a
    // bitmap this very frame painted would only thrash).
    const r = renderStatic(ctx, p(0, 6500));
    assert.equal(r.drawn, 6);
    assert.equal(r.cached, 4);
    assert.ok(bitmapCacheStats(ctx).px <= BITMAP_BUDGET_PX);
    // Pan so the first column leaves the view: its bitmaps are the least
    // recently used, and make room for the last column's.
    const r2 = renderStatic(ctx, p(-3100, 5000));
    assert.equal(r2.drawn, 4);
    assert.equal(r2.cached, 4);
    const stats = bitmapCacheStats(ctx);
    assert.ok(stats.px <= BITMAP_BUDGET_PX, `${stats.px} px held`);
    assert.equal(stats.entries, 4);
    assert.ok(made.length >= 5);
  });
});

test('bitmap cache: a zoom gesture stretches bitmaps, then sharpens them once it settles', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    let repaints = 0;
    let settled;
    const settledP = new Promise((res) => (settled = res));
    const base = {
      elements: scene(),
      view: { zoom: 1, panX: 0, panY: 0 },
      width: 800,
      height: 600,
      dpr: 2,
      onImageLoad: () => {
        repaints++;
        settled();
      },
    };
    renderStatic(ctx, base);
    const page = made[0].ctx;
    // Two quick zoom steps: the second is inside a gesture.
    renderStatic(ctx, { ...base, view: { zoom: 1.1, panX: 0, panY: 0 } });
    ctx.calls.length = 0;
    page.calls.length = 0;
    renderStatic(ctx, { ...base, view: { zoom: 1.2, panX: 0, panY: 0 } });
    assert.equal(named(page, 'clip').length, 0, 'nothing re-rasterised mid-gesture');
    const blits = blitsOf(ctx);
    assert.equal(blits.length, 4);
    // From the zoom-1.1 bitmaps (or zoom 1 where the first step's re-render
    // budget ran out).
    const ratios = [1.2 / 1.1, 1.2];
    assert.ok(blits.every(([, , , sw, , , , dw]) => ratios.some((k) => Math.abs(dw / sw - k) < 1e-9)), 'stretched to the new scale');
    assert.equal(made.length, 1, 'no new bitmaps');
    await settledP;
    assert.equal(repaints, 1, 'one repaint scheduled for when the gesture settles');
    // The repaint (what Canvas does on onImageLoad) re-renders at the exact scale.
    ctx.calls.length = 0;
    page.calls.length = 0;
    renderStatic(ctx, { ...base, view: { zoom: 1.2, panX: 0, panY: 0 } });
    assert.equal(named(page, 'clip').length, 4, 'all four re-rasterised');
    assert.ok(named(page, 'setTransform').some((c) => Math.abs(c[1] - 2.4) < 1e-9), 'at dpr * zoom');
    assert.ok(blitsOf(ctx).every(([, , , sw, sh, , , dw, dh]) => dw === sw && dh === sh), '1:1 again');
    assert.ok(ZOOM_SETTLE_MS > 0);
  });
});

test('bitmap cache: past the frame budget elements are drawn directly, and cached in idle time', async () => {
  await withBitmaps(async (made) => {
    const ctx = fakeCtx(1600, 1200);
    const base = { elements: scene(), width: 800, height: 600, dpr: 2, onImageLoad: () => {} };
    // No budget at all: nothing is rasterised in the frame itself.
    const first = renderStatic(ctx, { ...base, view: { zoom: 1, panX: 0, panY: 0 } });
    assert.deepEqual([first.drawn, first.cached], [4, 0], 'everything drawn directly, as without a cache');
    assert.ok(named(ctx, 'fillText').some((c) => c[1] === 'world'));
    assert.equal(made.length, 0);
    // Idle time makes the bitmaps (without repainting)...
    await new Promise((res) => setTimeout(res, 120));
    assert.equal(made.length, 1);
    assert.equal(named(made[0].ctx, 'clip').length, 4);
    // ...so the next frame (a pan) only blits.
    ctx.calls.length = 0;
    const pan = renderStatic(ctx, { ...base, view: { zoom: 1, panX: 30, panY: 0 } });
    assert.equal(pan.cached, 4);
    assert.equal(vectorCalls(ctx).length, 0);
    // A mass change (every element moved at once, e.g. dragged and dropped):
    // drawn directly, then rebuilt in idle time as well.
    await new Promise((res) => setTimeout(res, HOT_MS + 20));
    const moved = base.elements.map((e) => ({ ...e, ...(e.points ? { points: e.points.map((q) => ({ x: q.x + 5, y: q.y })) } : { x: e.x + 5 }) }));
    const after = renderStatic(ctx, { ...base, elements: moved, view: { zoom: 1, panX: 30, panY: 0 } });
    assert.equal(after.cached, 0);
    await new Promise((res) => setTimeout(res, 120));
    ctx.calls.length = 0;
    const again = renderStatic(ctx, { ...base, elements: moved, view: { zoom: 1, panX: 40, panY: 0 } });
    assert.equal(again.cached, 4, 'the moved elements have bitmaps again');
    assert.equal(vectorCalls(ctx).length, 0);
  }, 0);
});
