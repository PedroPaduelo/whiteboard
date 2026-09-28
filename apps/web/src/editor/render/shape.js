/**
 * shape.js — the hand-drawn geometry of every element, as pure data.
 *
 * This module turns an element into roughjs Drawables (plain objects: op
 * lists, no canvas) and a perfect-freehand outline path. Both consumers read
 * from here:
 *
 *   - renderElement.js replays the Drawables onto a 2D context;
 *   - export/export.js turns the SAME Drawables into SVG paths with
 *     `generator.toPaths`.
 *
 * One source is what makes an exported SVG/PNG look exactly like the screen:
 * the wobble comes from the element's `seed`, so every peer, every reload and
 * every export draws the identical stroke.
 *
 * Everything here is DOM-free and runs under `node --test`.
 *
 * Coordinates: each shape is generated in LOCAL coordinates, relative to
 * `origin` (the element's box top-left, or the min corner of its points).
 * The caller translates to `origin` before drawing. Two elements that differ
 * only by position therefore have identical Drawables, which lets the cache
 * below reuse them while an element is being dragged.
 */

import rough from 'roughjs';
import { getStroke } from 'perfect-freehand';
import { boundsOfPoints } from '@whiteboard/shared';

/** The one roughjs generator. Stateless apart from default options. */
export const generator = rough.generator();

/* ------------------------------------------------------------------ *
 * Seeds and resolved style
 * ------------------------------------------------------------------ */

const SEED_MOD = 2147483647; // 2^31 - 1

/** 32-bit FNV-1a hash of a string (unsigned). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * The roughjs seed of an element: its stored `seed`, else FNV-1a of its id.
 * Never 0 — roughjs treats seed 0 as "use Math.random", which would make the
 * wobble change on every repaint.
 */
export function seedOf(el) {
  const raw = Number.isInteger(el?.seed) && el.seed >= 0 ? el.seed : fnv1a(el?.id ?? '');
  return raw % SEED_MOD || 1;
}

/** True for a colour that actually paints (not absent, 'none' or 'transparent'). */
export function isPaint(c) {
  return typeof c === 'string' && c !== '' && c !== 'none' && c !== 'transparent';
}

const FILL_STYLE_SET = new Set(['hachure', 'cross-hatch', 'solid', 'zigzag']);
const ARROWHEAD_SET = new Set(['none', 'arrow', 'triangle', 'bar', 'dot']);
const LINEAR = new Set(['arrow', 'line']);

/** Default ink for types that are invisible without a stroke. */
export const DEFAULT_INK = '#1e1e1e';

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Every style field the renderer reads, with the documented defaults for
 * legacy elements applied (EDITOR_CONTRACT §1): roughness 1, fillStyle
 * 'solid', roundness 'sharp', fontFamily 'hand', arrow end 'arrow'.
 * `stroke`/`fill` are null when they do not paint.
 */
export function resolveStyle(el) {
  const type = el.type;
  const linear = LINEAR.has(type);
  let stroke = isPaint(el.stroke) ? el.stroke : null;
  // A connector or pen stroke without a colour would be invisible; legacy
  // data sometimes omits it, so those get the default ink instead.
  if (!stroke && el.stroke === undefined && (linear || type === 'pen')) stroke = DEFAULT_INK;
  const strokeWidth = Math.max(0, num(el.strokeWidth, 2));
  const head = (v, d) => (ARROWHEAD_SET.has(v) ? v : d);
  return {
    stroke,
    fill: linear ? null : isPaint(el.fill) ? el.fill : null,
    strokeWidth,
    strokeStyle: el.strokeStyle === 'dashed' || el.strokeStyle === 'dotted' ? el.strokeStyle : 'solid',
    roughness: clamp(num(el.roughness, 1), 0, 2),
    fillStyle: FILL_STYLE_SET.has(el.fillStyle) ? el.fillStyle : 'solid',
    roundness: el.roundness === 'round' ? 'round' : 'sharp',
    startArrowhead: linear ? head(el.startArrowhead, 'none') : 'none',
    endArrowhead: linear ? head(el.endArrowhead, type === 'arrow' ? 'arrow' : 'none') : 'none',
    seed: seedOf(el),
  };
}

/** Dash pattern for a stroke style, board units (Excalidraw's values). */
export function dashArray(strokeStyle, strokeWidth) {
  if (strokeStyle === 'dashed') return [8, 8 + strokeWidth];
  if (strokeStyle === 'dotted') return [1.5, 6 + strokeWidth];
  return null;
}

/**
 * Excalidraw's roughness damping: small shapes drawn at full roughness look
 * like scribbles, so they get a gentler wobble.
 */
export function adjustRoughness(type, w, h, roughness, roundness) {
  const maxSize = Math.max(Math.abs(w), Math.abs(h));
  const minSize = Math.min(Math.abs(w), Math.abs(h));
  if (
    (minSize >= 20 && maxSize >= 50) ||
    (minSize >= 15 && roundness === 'round' && (type === 'rect' || type === 'diamond')) ||
    (LINEAR.has(type) && maxSize >= 50)
  ) {
    return roughness;
  }
  return Math.min(roughness / (maxSize < 10 ? 3 : 2), 2.5);
}

/**
 * roughjs options for an element. A FRESH object on every call: roughjs
 * attaches its seeded randomizer to the options object, so sharing one
 * between two generator calls would make the second continue the first's
 * random sequence.
 */
function roughOptions(spec, { continuousPath = false, withFill = true } = {}) {
  const { st, w, h, type } = spec;
  const sw = st.strokeWidth;
  const o = {
    seed: st.seed,
    roughness: adjustRoughness(type, w, h, st.roughness, st.roundness),
    stroke: st.stroke && sw > 0 ? st.stroke : 'none',
    // Dashed/dotted strokes are single-stroke, so they are drawn a touch
    // thicker to read like a solid one (Excalidraw does the same).
    strokeWidth: st.strokeStyle !== 'solid' ? sw + 0.5 : Math.max(sw, 0.01),
    fillWeight: Math.max(sw, 1) / 2,
    // roughjs rounds the gap; below 1 it would round to 0 and never finish.
    hachureGap: Math.max(sw, 1) * 4,
    disableMultiStroke: st.strokeStyle !== 'solid',
    preserveVertices: continuousPath || st.roughness < 2,
  };
  const dash = dashArray(st.strokeStyle, sw);
  if (dash) o.strokeLineDash = dash;
  if (withFill && st.fill) {
    o.fill = st.fill;
    o.fillStyle = st.fillStyle;
  }
  return o;
}

/* ------------------------------------------------------------------ *
 * Box shapes
 * ------------------------------------------------------------------ */

/** Corner radius of a round rect / diamond side: 25% of the short side, max 32. */
export function cornerRadius(size) {
  return Math.min(Math.max(0, size) * 0.25, 32);
}

/** SVG path of a rounded rectangle 0,0,w,h (Excalidraw's quadratic corners). */
export function roundRectPath(w, h) {
  const r = cornerRadius(Math.min(w, h));
  return (
    `M ${r} 0 L ${w - r} 0 Q ${w} 0, ${w} ${r} L ${w} ${h - r} Q ${w} ${h}, ${w - r} ${h} ` +
    `L ${r} ${h} Q 0 ${h}, 0 ${h - r} L 0 ${r} Q 0 0, ${r} 0`
  );
}

/** SVG path of a diamond in 0,0,w,h with rounded vertices. */
export function roundDiamondPath(w, h) {
  const [tx, ty, rx, ry, bx, by, lx, ly] = [w / 2, 0, w, h / 2, w / 2, h, 0, h / 2];
  const vr = cornerRadius(Math.abs(tx - lx));
  const hr = cornerRadius(Math.abs(ry - ty));
  return (
    `M ${tx + vr} ${ty + hr} L ${rx - vr} ${ry - hr} ` +
    `C ${rx} ${ry}, ${rx} ${ry}, ${rx - vr} ${ry + hr} ` +
    `L ${bx + vr} ${by - hr} C ${bx} ${by}, ${bx} ${by}, ${bx - vr} ${by - hr} ` +
    `L ${lx + vr} ${ly + hr} C ${lx} ${ly}, ${lx} ${ly}, ${lx + vr} ${ly - hr} ` +
    `L ${tx - vr} ${ty + hr} C ${tx} ${ty}, ${tx} ${ty}, ${tx + vr} ${ty + hr}`
  );
}

/** Half-height of a cylinder's elliptical cap. */
export function cylinderCap(w, h) {
  return Math.max(0, Math.min(h * 0.15, w * 0.25, 30));
}

/**
 * A database drum in 0,0,w,h: `body` is the closed silhouette (filled and
 * outlined), `rim` the front half of the top ellipse.
 */
export function cylinderPaths(w, h) {
  const ry = cylinderCap(w, h);
  const rx = w / 2;
  return {
    body: `M 0 ${ry} A ${rx} ${ry} 0 0 1 ${w} ${ry} L ${w} ${h - ry} A ${rx} ${ry} 0 0 1 0 ${h - ry} Z`,
    rim: `M 0 ${ry} A ${rx} ${ry} 0 0 0 ${w} ${ry}`,
  };
}

/* ------------------------------------------------------------------ *
 * Connectors and arrowheads
 * ------------------------------------------------------------------ */

/** Base arrowhead length for a stroke width (contract §6). */
export function arrowheadBaseSize(strokeWidth) {
  return Math.min(30, 4 * strokeWidth + 10);
}

const DEG = Math.PI / 180;
/** Angle between the shaft and each wing of an `arrow`/`triangle` head. */
export const ARROWHEAD_ANGLE = 25;

function rot(p, c, a) {
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

/**
 * Geometry of one arrowhead.
 *
 * @param {'none'|'arrow'|'triangle'|'bar'|'dot'} kind
 * @param {{x,y}} tip     the connector end the head sits on
 * @param {{x,y}} from    a point back along the stroke: the head points from here to `tip`
 * @param {number} strokeWidth
 * @param {number} [segmentLength] length of the last segment; heads are
 *   scaled down to at most half of it so short arrows keep a visible shaft
 * @returns {null |
 *   {kind:'arrow', tip, left, right, size} |
 *   {kind:'triangle', tip, left, right, size} |
 *   {kind:'bar', a, b, size} |
 *   {kind:'dot', center, diameter, size}}
 */
export function arrowheadGeometry(kind, tip, from, strokeWidth, segmentLength = Infinity) {
  if (!kind || kind === 'none' || !tip || !from) return null;
  const dx = tip.x - from.x;
  const dy = tip.y - from.y;
  const d = Math.hypot(dx, dy);
  if (!(d > 1e-9)) return null;
  const ux = dx / d;
  const uy = dy / d;
  const base = arrowheadBaseSize(strokeWidth);
  const limit = Number.isFinite(segmentLength) ? Math.max(0, segmentLength) * 0.5 : Infinity;
  switch (kind) {
    case 'arrow':
    case 'triangle': {
      const size = Math.min(kind === 'arrow' ? base : base * 0.8, limit);
      const back = { x: tip.x - ux * size, y: tip.y - uy * size };
      return {
        kind,
        tip: { x: tip.x, y: tip.y },
        left: rot(back, tip, -ARROWHEAD_ANGLE * DEG),
        right: rot(back, tip, ARROWHEAD_ANGLE * DEG),
        size,
      };
    }
    case 'bar': {
      const size = base * 0.5;
      return {
        kind,
        a: { x: tip.x - uy * size, y: tip.y + ux * size },
        b: { x: tip.x + uy * size, y: tip.y - ux * size },
        size,
      };
    }
    case 'dot': {
      const size = Math.min(base * 0.45, limit);
      return { kind, center: { x: tip.x, y: tip.y }, diameter: size + strokeWidth, size };
    }
    default:
      return null;
  }
}

/** Point on a cubic bezier. */
function bezierAt(p0, p1, p2, p3, t) {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/**
 * The cubic segments roughjs' `curve` draws through `pts` (Catmull-Rom with
 * the end points doubled, tightness 0). Used to aim arrowheads along the
 * visible curve instead of the chord.
 */
export function curveSegments(pts) {
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  const segs = [];
  for (let i = 1; i + 2 < P.length; i++) {
    const p0 = P[i];
    const p3 = P[i + 1];
    const c1 = { x: p0.x + (P[i + 1].x - P[i - 1].x) / 6, y: p0.y + (P[i + 1].y - P[i - 1].y) / 6 };
    const c2 = { x: p3.x + (P[i].x - P[i + 2].x) / 6, y: p3.y + (P[i].y - P[i + 2].y) / 6 };
    segs.push([p0, c1, c2, p3]);
  }
  return segs;
}

/** Nearest point to `pts[i]` walking by `step` (±1) that is not on top of it. */
function distinctNeighbour(pts, i, step) {
  for (let j = i + step; j >= 0 && j < pts.length; j += step) {
    if (Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y) > 1e-6) return j;
  }
  return -1;
}

/**
 * Where each end's arrowhead points from, for a polyline (or a curve when
 * `curved`). Excalidraw aims the head from the point 30% back along the last
 * segment, which follows a curve's bend instead of its chord.
 * @returns {{start: null|{tip, from, segLen}, end: null|{tip, from, segLen}}}
 */
export function connectorEnds(pts, curved) {
  const n = pts.length;
  const out = { start: null, end: null };
  if (n < 2) return out;
  const endPrev = distinctNeighbour(pts, n - 1, -1);
  const startNext = distinctNeighbour(pts, 0, 1);
  if (endPrev >= 0) {
    const tip = pts[n - 1];
    const prev = pts[endPrev];
    let from = prev;
    if (curved && n > 2) {
      const segs = curveSegments(pts);
      const last = segs[segs.length - 1];
      from = bezierAt(last[0], last[1], last[2], last[3], 0.7);
      if (Math.hypot(tip.x - from.x, tip.y - from.y) < 1e-6) from = prev;
    }
    out.end = { tip, from, segLen: Math.hypot(tip.x - prev.x, tip.y - prev.y) };
  }
  if (startNext >= 0) {
    const tip = pts[0];
    const next = pts[startNext];
    let from = next;
    if (curved && n > 2) {
      const first = curveSegments(pts)[0];
      from = bezierAt(first[0], first[1], first[2], first[3], 0.3);
      if (Math.hypot(tip.x - from.x, tip.y - from.y) < 1e-6) from = next;
    }
    out.start = { tip, from, segLen: Math.hypot(tip.x - next.x, tip.y - next.y) };
  }
  return out;
}

/** roughjs Drawables for one arrowhead (empty for 'none'). */
function arrowheadDrawables(head, spec, base) {
  if (!head) return [];
  const { st } = spec;
  // Heads are always solid and at most mildly rough, or they turn to mush.
  const o = (extra) => {
    const r = { ...base };
    delete r.strokeLineDash;
    delete r.fill;
    delete r.fillStyle;
    r.disableMultiStroke = false;
    r.strokeWidth = st.strokeWidth;
    return Object.assign(r, extra);
  };
  switch (head.kind) {
    case 'arrow':
      return [
        generator.line(head.left.x, head.left.y, head.tip.x, head.tip.y, o({ roughness: Math.min(1, base.roughness) })),
        generator.line(head.right.x, head.right.y, head.tip.x, head.tip.y, o({ roughness: Math.min(1, base.roughness) })),
      ];
    case 'triangle':
      return [
        generator.polygon(
          [
            [head.tip.x, head.tip.y],
            [head.left.x, head.left.y],
            [head.right.x, head.right.y],
          ],
          o({ roughness: Math.min(1, base.roughness), fill: st.stroke, fillStyle: 'solid' }),
        ),
      ];
    case 'bar':
      return [generator.line(head.a.x, head.a.y, head.b.x, head.b.y, o({ roughness: Math.min(1, base.roughness) }))];
    case 'dot':
      return [
        generator.circle(
          head.center.x,
          head.center.y,
          head.diameter,
          o({ roughness: Math.min(0.5, base.roughness), fill: st.stroke, fillStyle: 'solid' }),
        ),
      ];
    default:
      return [];
  }
}

/* ------------------------------------------------------------------ *
 * Freehand
 * ------------------------------------------------------------------ */

/**
 * perfect-freehand options for a pen stroke (contract §6). Pressure is
 * simulated from the pointer speed (we store only x/y), so a quick stroke
 * comes out thinner than a slow one, like a felt pen.
 */
export function penStrokeOptions(strokeWidth) {
  return {
    size: Math.max(4, strokeWidth * 4.25),
    thinning: 0.6,
    smoothing: 0.5,
    streamline: 0.5,
    simulatePressure: true,
    last: true,
  };
}

/** The outline polygon of a pen stroke, `[x, y][]`, in the points' own space. */
export function penOutline(points, strokeWidth) {
  if (!points || points.length === 0) return [];
  const input = points.map((p) => [p.x, p.y]);
  return getStroke(input, penStrokeOptions(strokeWidth));
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

/**
 * SVG path data for a freehand outline: quadratic curves through the
 * midpoints (the smoothing perfect-freehand's author recommends and Excalidraw
 * uses). The canvas fills it as a Path2D, the export as a <path>.
 */
export function outlineToPath(outline) {
  const n = outline.length;
  if (n === 0) return '';
  if (n < 3) {
    return `M ${fmt(outline[0][0])} ${fmt(outline[0][1])} ` + outline.slice(1).map((p) => `L ${fmt(p[0])} ${fmt(p[1])}`).join(' ') + ' Z';
  }
  const parts = [`M ${fmt(outline[0][0])} ${fmt(outline[0][1])} Q`];
  for (let i = 0; i < n; i++) {
    const p = outline[i];
    const q = outline[(i + 1) % n];
    parts.push(`${fmt(p[0])} ${fmt(p[1])} ${fmt((p[0] + q[0]) / 2)} ${fmt((p[1] + q[1]) / 2)}`);
  }
  parts.push(`L ${fmt(outline[0][0])} ${fmt(outline[0][1])} Z`);
  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Shape descriptions and the cache
 * ------------------------------------------------------------------ */

/**
 * @typedef {Object} ShapeDesc
 * @property {'rough'|'pen'|'sticky'|'text'|'image'|'none'} kind
 * @property {{x:number,y:number}} origin   translate here before drawing
 * @property {object[]} drawables           roughjs Drawables (kind 'rough')
 * @property {string} [path]                pen outline path data (kind 'pen')
 * @property {string} [fill]                pen colour (kind 'pen')
 */

const ROUGH_TYPES = new Set(['rect', 'ellipse', 'diamond', 'cylinder', 'arrow', 'line']);

/**
 * Everything a shape's geometry depends on, position excluded. The cache key
 * is this object serialised, so a field that affects the drawing but is not
 * in the spec cannot exist: `buildFromSpec` only reads the spec.
 */
function shapeSpec(el) {
  const st = resolveStyle(el);
  if (LINEAR.has(el.type) || el.type === 'pen') {
    const points = Array.isArray(el.points) ? el.points : [];
    const b = boundsOfPoints(points);
    return {
      type: el.type,
      w: b.w,
      h: b.h,
      origin: { x: b.x, y: b.y },
      pts: points.map((p) => ({ x: p.x - b.x, y: p.y - b.y })),
      st,
    };
  }
  return { type: el.type, w: num(el.w, 0), h: num(el.h, 0), origin: { x: num(el.x, 0), y: num(el.y, 0) }, st };
}

function buildFromSpec(spec) {
  const { type, w, h, st } = spec;
  const none = { kind: 'none', origin: spec.origin, drawables: [] };
  switch (type) {
    case 'rect': {
      if (w <= 0 && h <= 0) return none;
      const d =
        st.roundness === 'round'
          ? generator.path(roundRectPath(w, h), roughOptions(spec, { continuousPath: true }))
          : generator.rectangle(0, 0, w, h, roughOptions(spec));
      return { kind: 'rough', origin: spec.origin, drawables: [d] };
    }
    case 'ellipse': {
      if (w <= 0 && h <= 0) return none;
      const d = generator.ellipse(w / 2, h / 2, w, h, { ...roughOptions(spec), curveFitting: 1 });
      return { kind: 'rough', origin: spec.origin, drawables: [d] };
    }
    case 'diamond': {
      if (w <= 0 && h <= 0) return none;
      const d =
        st.roundness === 'round'
          ? generator.path(roundDiamondPath(w, h), roughOptions(spec, { continuousPath: true }))
          : generator.polygon(
              [
                [w / 2, 0],
                [w, h / 2],
                [w / 2, h],
                [0, h / 2],
              ],
              roughOptions(spec),
            );
      return { kind: 'rough', origin: spec.origin, drawables: [d] };
    }
    case 'cylinder': {
      if (w <= 0 && h <= 0) return none;
      const { body, rim } = cylinderPaths(w, h);
      const drawables = [generator.path(body, roughOptions(spec, { continuousPath: true }))];
      if (st.stroke && st.strokeWidth > 0) {
        drawables.push(generator.path(rim, roughOptions(spec, { continuousPath: true, withFill: false })));
      }
      return { kind: 'rough', origin: spec.origin, drawables };
    }
    case 'arrow':
    case 'line': {
      const pts = spec.pts;
      if (pts.length < 2) return none;
      // Connectors keep their vertices exact at every roughness: a bound end
      // must land on its gap and the arrowhead must sit on the tip.
      const base = { ...roughOptions(spec, { withFill: false }), preserveVertices: true };
      const tuples = pts.map((p) => [p.x, p.y]);
      const curved = st.roundness === 'round' && pts.length > 2;
      const shaft = curved ? generator.curve(tuples, base) : generator.linearPath(tuples, base);
      const drawables = [shaft];
      if (st.stroke && st.strokeWidth > 0) {
        const ends = connectorEnds(pts, curved);
        const headOpts = { ...base };
        if (ends.start) {
          const g = arrowheadGeometry(st.startArrowhead, ends.start.tip, ends.start.from, st.strokeWidth, ends.start.segLen);
          drawables.push(...arrowheadDrawables(g, spec, headOpts));
        }
        if (ends.end) {
          const g = arrowheadGeometry(st.endArrowhead, ends.end.tip, ends.end.from, st.strokeWidth, ends.end.segLen);
          drawables.push(...arrowheadDrawables(g, spec, headOpts));
        }
      }
      return { kind: 'rough', origin: spec.origin, drawables };
    }
    case 'pen': {
      const outline = penOutline(spec.pts, st.strokeWidth);
      return {
        kind: 'pen',
        origin: spec.origin,
        drawables: [],
        path: outlineToPath(outline),
        fill: st.stroke, // null: an explicitly colourless stroke paints nothing
        pointCount: outline.length,
      };
    }
    case 'sticky':
      return { kind: 'sticky', origin: spec.origin, drawables: [] };
    case 'text':
      return { kind: 'text', origin: spec.origin, drawables: [] };
    case 'image':
      return { kind: 'image', origin: spec.origin, drawables: [] };
    default:
      return none;
  }
}

/** Build a shape with no caching (tests, one-off exports). */
export function buildShape(el) {
  return buildFromSpec(shapeSpec(el));
}

/*
 * Two cache levels:
 *  1. WeakMap keyed by the element OBJECT. The store replaces an element
 *     object on every change, so a hit is always current and a stale entry is
 *     garbage-collected with its element.
 *  2. A bounded map keyed by the geometry spec (position excluded), for the
 *     rough types. A moved element is a new object with the same spec, so a
 *     drag re-uses the Drawables instead of re-generating hachure every frame.
 *     Pen strokes are not in it: their key would be as long as the stroke.
 */
let byObject = new WeakMap();
const bySpec = new Map();
const SPEC_CACHE_MAX = 1500;
const SPEC_KEY_MAX_POINTS = 64;

/**
 * The (cached) ShapeDesc for an element. Same object -> the same ShapeDesc
 * instance. A changed element (new object with different geometry or style)
 * gets a new one.
 * @param {object} el
 * @returns {ShapeDesc}
 */
export function getShape(el) {
  const hit = byObject.get(el);
  if (hit) return hit;
  const spec = shapeSpec(el);
  let desc;
  if (ROUGH_TYPES.has(el.type) && (!spec.pts || spec.pts.length <= SPEC_KEY_MAX_POINTS)) {
    const key = JSON.stringify([spec.type, spec.w, spec.h, spec.pts ?? null, spec.st]);
    const shared = bySpec.get(key);
    if (shared) {
      bySpec.delete(key); // LRU bump
      bySpec.set(key, shared);
      desc = { ...shared, origin: spec.origin };
    } else {
      const built = buildFromSpec(spec);
      bySpec.set(key, built);
      if (bySpec.size > SPEC_CACHE_MAX) bySpec.delete(bySpec.keys().next().value);
      desc = built.origin === spec.origin ? built : { ...built, origin: spec.origin };
    }
  } else {
    desc = buildFromSpec(spec);
  }
  if (el && typeof el === 'object') byObject.set(el, desc);
  return desc;
}

/** Forget the cached shape of one element (or of all, with no argument). */
export function invalidateShape(el) {
  if (el) byObject.delete(el);
  else {
    byObject = new WeakMap();
    bySpec.clear();
  }
}

/* ------------------------------------------------------------------ *
 * Text metrics and theme helpers shared by canvas and export
 * ------------------------------------------------------------------ */

/**
 * Font ascent/descent as a fraction of the font size, from the fonts' own
 * hhea tables (the numbers Excalidraw uses). Used where the real metrics
 * cannot be measured (node, SVG export).
 */
export const FONT_METRICS = Object.freeze({
  hand: Object.freeze({ ascent: 886 / 1000, descent: 374 / 1000 }), // Virgil
  normal: Object.freeze({ ascent: 1577 / 2048, descent: 471 / 2048 }), // Helvetica
  code: Object.freeze({ ascent: 1900 / 2048, descent: 480 / 2048 }), // Cascadia Code
});

/**
 * Distance from a line box's top to its alphabetic baseline. A browser lays a
 * line out exactly like this (half-leading above the font's ascent), so text
 * painted at `top + offset` sits where the <textarea> editor shows it.
 * @param {number} lineHeight  px
 * @param {{ascent:number, descent:number}} metrics  px
 */
export function baselineOffset(lineHeight, metrics) {
  return (lineHeight - (metrics.ascent + metrics.descent)) / 2 + metrics.ascent;
}

/**
 * Colour matrix of the dark-mode filter `invert(93%) hue-rotate(180deg)`
 * (DARK_MODE_FILTER), for the export: CSS applies invert then hue-rotate,
 * which composes to `out = M·rgb + 0.93` per channel, in sRGB 0..1.
 */
export const DARK_MATRIX = (() => {
  const H = [
    [-0.574, 1.43, 0.144],
    [0.426, 0.43, 0.144],
    [0.426, 1.43, -0.856],
  ];
  const k = 1 - 2 * 0.93; // invert(93%): c -> c*(1-2a) + a
  return Object.freeze({ m: H.map((row) => row.map((v) => v * k)), offset: 0.93 });
})();

/** Apply DARK_MATRIX to an RGB triple in 0..255. */
export function darkRgb(r, g, b) {
  const { m, offset } = DARK_MATRIX;
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const out = m.map((row) => clamp(row[0] * rr + row[1] * gg + row[2] * bb + offset, 0, 1) * 255);
  return [Math.round(out[0]), Math.round(out[1]), Math.round(out[2])];
}
