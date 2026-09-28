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
  invalidateShape,
} from '../src/editor/render/shape.js';
import { drawElement, drawRough, invalidateElementCache } from '../src/editor/render/renderElement.js';
import { renderStatic, renderInteractive, isElementVisible, visibleBoardRect } from '../src/editor/render/renderScene.js';
import { layoutText } from '../src/editor/text.js';
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
  assert.deepEqual(res, { drawn: 3, culled: 1 });
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
