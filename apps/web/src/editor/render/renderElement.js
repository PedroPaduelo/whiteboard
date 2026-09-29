/**
 * renderElement.js — paints ONE element onto a 2D context.
 *
 * The context is in BOARD space when this runs (the scene renderer has set
 * `dpr*zoom` and the pan); this module only adds the element's own rotation
 * and opacity, inside a save/restore bracket so nothing leaks to the next
 * element.
 *
 * What is drawn how (Excalidraw's look):
 *   - rect / ellipse / diamond / cylinder / arrow / line: roughjs Drawables
 *     from shape.js, replayed here (cached per element object, and compiled
 *     to Path2D once so a repaint is a handful of `stroke()` calls);
 *   - pen: the perfect-freehand outline, filled as a cached Path2D;
 *   - sticky: a crisp rounded note with a soft shadow (deliberately not rough);
 *   - text and labels: `layoutText` from editor/text.js, the same layout the
 *     <textarea> editor uses, baseline-corrected so the text does not jump
 *     when editing starts or ends;
 *   - image: the decoded bitmap, or a light placeholder while it loads.
 *
 * Pure functions of the element: two peers painting the same element paint
 * the same pixels, because the wobble comes from the element's seed.
 */

import { layoutText, textColorOf, labelKeyOf, measureLine } from '../text.js';
import { rotateAround } from '../handles.js';
import { getShape, invalidateShape, isPaint, baselineOffset, FONT_METRICS, DARK_MODE_COUNTER_FILTER } from './shape.js';
import { onFontsLoaded } from '../fonts.js';

/* ------------------------------------------------------------------ *
 * Caches
 * ------------------------------------------------------------------ */

/** Path2D per roughjs op set / pen path string. Keyed by the set object. */
const compiled = new WeakMap();
/** Text layout per element object; replaced wholesale when fonts load. */
let layouts = new WeakMap();
/** Painted text bounds per element object; same lifetime as `layouts`. */
let textBoundsCache = new WeakMap();
/** Measured font metrics per CSS font string. */
const metricsCache = new Map();

/*
 * Paint stamps. Whoever keeps an element's PIXELS (the scene's per-element
 * bitmaps, elementCache.js) keys them by the element object — which the
 * store replaces on every change — plus this stamp, which moves when the
 * same object must be painted anew: the fonts loaded (every text was painted
 * with a fallback font), or invalidateElementCache was called.
 */
let paintEpoch = 0;
const paintVersions = new WeakMap(); // element object -> number

onFontsLoaded(() => {
  // Everything measured so far was measured with a fallback font.
  layouts = new WeakMap();
  textBoundsCache = new WeakMap();
  metricsCache.clear();
  paintEpoch++;
});

const HAS_PATH2D = typeof Path2D !== 'undefined';

/** Drop every cached drawing/layout of one element (or of all of them). */
export function invalidateElementCache(el) {
  invalidateShape(el);
  if (el) {
    layouts.delete(el);
    textBoundsCache.delete(el);
    if (typeof el === 'object') paintVersions.set(el, (paintVersions.get(el) ?? 0) + 1);
  } else {
    layouts = new WeakMap();
    textBoundsCache = new WeakMap();
    paintEpoch++;
  }
}

/**
 * A number that changes whenever `el` (the same object) would paint
 * differently: after the fonts load or invalidateElementCache. Cached pixels
 * of an element are valid while the object AND its stamp are unchanged.
 * @param {object} el
 * @returns {number}
 */
export function paintStamp(el) {
  return paintEpoch * 0x100000 + ((el && typeof el === 'object' && paintVersions.get(el)) || 0);
}

/* ------------------------------------------------------------------ *
 * Images
 * ------------------------------------------------------------------ */

const images = new Map(); // src -> {img, status, callbacks:Set}
const IMAGE_CACHE_MAX = 200;

/**
 * Cached image loader. Returns the decoded <img> once it has loaded, or null
 * while it is loading or when it failed. `onLoad` is called once when a
 * pending image finishes (success or failure), so the caller can repaint.
 * @param {string} src
 * @param {() => void} [onLoad]
 * @returns {HTMLImageElement|null}
 */
export function getImage(src, onLoad) {
  if (!src || typeof Image === 'undefined') return null;
  let entry = images.get(src);
  if (!entry) {
    const img = new Image();
    img.decoding = 'async';
    entry = { img, status: 'loading', callbacks: new Set() };
    const e = entry;
    const settle = (status) => {
      e.status = status;
      const cbs = [...e.callbacks];
      e.callbacks.clear();
      for (const cb of cbs) {
        try {
          cb();
        } catch (err) {
          console.error('[render] image onLoad callback failed', err);
        }
      }
    };
    img.onload = () => settle('loaded');
    img.onerror = () => settle('error');
    img.src = src;
    images.set(src, entry);
    if (images.size > IMAGE_CACHE_MAX) {
      for (const [k, v] of images) {
        if (images.size <= IMAGE_CACHE_MAX) break;
        if (v.status !== 'loading' && k !== src) images.delete(k);
      }
    }
  } else {
    images.delete(src); // LRU bump
    images.set(src, entry);
  }
  if (entry.status === 'loaded') return entry.img;
  if (entry.status === 'loading' && typeof onLoad === 'function') entry.callbacks.add(onLoad);
  return null;
}

/** 'loading' | 'loaded' | 'error' | undefined — for the placeholder look. */
export function imageStatus(src) {
  return images.get(src)?.status;
}

/* ------------------------------------------------------------------ *
 * roughjs replay
 * ------------------------------------------------------------------ */

function opsToContext(ctx, ops) {
  for (const item of ops) {
    const d = item.data;
    if (item.op === 'move') ctx.moveTo(d[0], d[1]);
    else if (item.op === 'bcurveTo') ctx.bezierCurveTo(d[0], d[1], d[2], d[3], d[4], d[5]);
    else if (item.op === 'lineTo') ctx.lineTo(d[0], d[1]);
  }
}

function pathOf(set) {
  if (!HAS_PATH2D) return null;
  let p = compiled.get(set);
  if (!p) {
    p = new Path2D();
    opsToContext(p, set.ops);
    compiled.set(set, p);
  }
  return p;
}

function strokeSet(ctx, set) {
  const p = pathOf(set);
  if (p) ctx.stroke(p);
  else {
    ctx.beginPath();
    opsToContext(ctx, set.ops);
    ctx.stroke();
  }
}

function fillSet(ctx, set, rule) {
  const p = pathOf(set);
  if (p) ctx.fill(p, rule);
  else {
    ctx.beginPath();
    opsToContext(ctx, set.ops);
    ctx.fill(rule);
  }
}

/**
 * Replay a roughjs Drawable onto `ctx` — RoughCanvas.draw without needing a
 * <canvas> element (the scene and the PNG export use contexts they own).
 */
export function drawRough(ctx, drawable) {
  const o = drawable.options;
  for (const set of drawable.sets) {
    switch (set.type) {
      case 'path':
        if (o.stroke === 'none') break;
        ctx.save();
        ctx.strokeStyle = o.stroke;
        ctx.lineWidth = o.strokeWidth;
        if (o.strokeLineDash) ctx.setLineDash(o.strokeLineDash);
        strokeSet(ctx, set);
        ctx.restore();
        break;
      case 'fillPath': {
        ctx.save();
        ctx.fillStyle = o.fill || 'transparent';
        const shape = drawable.shape;
        fillSet(ctx, set, shape === 'curve' || shape === 'polygon' || shape === 'path' ? 'evenodd' : 'nonzero');
        ctx.restore();
        break;
      }
      case 'fillSketch':
        ctx.save();
        ctx.strokeStyle = o.fill || 'transparent';
        ctx.lineWidth = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight;
        if (o.fillLineDash) ctx.setLineDash(o.fillLineDash);
        strokeSet(ctx, set);
        ctx.restore();
        break;
      default:
        break;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Text
 * ------------------------------------------------------------------ */

/** Cached text layout of an element (null when it shows no text). */
export function layoutOf(el) {
  if (layouts.has(el)) return layouts.get(el);
  const l = layoutText(el);
  layouts.set(el, l);
  return l;
}

/**
 * Board-space axis-aligned bounds of the text an element PAINTS, or null
 * when it paints none. Labels are not clipped to their shape and a container
 * does not grow with its label, so a long label (or a note with too much
 * text) runs past the element's box: the viewport culling and the export
 * frame union this with the element's own bounds, or they would drop lines
 * that are plainly on screen. Every laid-out line is measured (the layout
 * wraps to the box, but a long word after another word is not broken), then
 * the rectangle is turned with the element about its centre. Cached per
 * element object, and thrown away when the fonts load.
 * @param {object} el
 * @returns {{x:number,y:number,w:number,h:number}|null}
 */
export function textPaintBounds(el) {
  if (!el || typeof el !== 'object') return null;
  if (textBoundsCache.has(el)) return textBoundsCache.get(el);
  let out = null;
  if (el.type === 'text' || labelKeyOf(el)) {
    const layout = layoutOf(el);
    if (layout && layout.lines.length) {
      let x0 = Infinity;
      let y0 = Infinity;
      let x1 = -Infinity;
      let y1 = -Infinity;
      for (const line of layout.lines) {
        if (!line.text) continue;
        const w = measureLine(line.text, layout.fontFamily, layout.fontSize);
        const left = layout.textAlign === 'center' ? line.x - w / 2 : layout.textAlign === 'right' ? line.x - w : line.x;
        x0 = Math.min(x0, left);
        x1 = Math.max(x1, left + w);
        y0 = Math.min(y0, line.y);
        y1 = Math.max(y1, line.y + layout.lineHeight);
      }
      if (Number.isFinite(x0) && Number.isFinite(y0)) {
        // Glyph ink can poke a little out of its advance box and line box
        // (overhangs, the hand font's tall accents).
        const px = layout.fontSize * 0.1;
        const py = layout.fontSize * 0.05;
        x0 -= px;
        x1 += px;
        y0 -= py;
        y1 += py;
        if (el.rotation && Number.isFinite(el.x) && Number.isFinite(el.w)) {
          const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
          const pts = [
            { x: x0, y: y0 },
            { x: x1, y: y0 },
            { x: x1, y: y1 },
            { x: x0, y: y1 },
          ].map((p) => rotateAround(p, c, el.rotation));
          x0 = Math.min(...pts.map((p) => p.x));
          x1 = Math.max(...pts.map((p) => p.x));
          y0 = Math.min(...pts.map((p) => p.y));
          y1 = Math.max(...pts.map((p) => p.y));
        }
        out = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
    }
  }
  textBoundsCache.set(el, out);
  return out;
}

/**
 * Ascent/descent (px) of a CSS font. Measured from the real font when the
 * browser reports font-box metrics (so the canvas agrees with the textarea,
 * whichever font actually rendered), else from FONT_METRICS.
 */
function fontMetrics(ctx, layout) {
  const key = layout.font;
  let m = metricsCache.get(key);
  if (!m) {
    const table = FONT_METRICS[layout.fontFamily] ?? FONT_METRICS.hand;
    // Measure at the layout's own size: font-box metrics scale linearly.
    let measured = null;
    try {
      ctx.save();
      ctx.font = layout.font;
      const tm = ctx.measureText('Mg');
      ctx.restore();
      if (tm && Number.isFinite(tm.fontBoundingBoxAscent) && Number.isFinite(tm.fontBoundingBoxDescent)) {
        measured = { ascent: tm.fontBoundingBoxAscent / layout.fontSize, descent: tm.fontBoundingBoxDescent / layout.fontSize };
      }
    } catch {
      measured = null;
    }
    m = measured ?? table;
    metricsCache.set(key, m);
  }
  return { ascent: m.ascent * layout.fontSize, descent: m.descent * layout.fontSize };
}

/** Paint a text layout (from layoutText) in `color`. */
export function drawTextLayout(ctx, layout, color) {
  if (!layout || layout.lines.length === 0) return;
  const metrics = fontMetrics(ctx, layout);
  const offset = baselineOffset(layout.lineHeight, metrics);
  ctx.font = layout.font;
  ctx.fillStyle = color;
  ctx.textAlign = layout.textAlign;
  ctx.textBaseline = 'alphabetic';
  for (const line of layout.lines) {
    if (line.text) ctx.fillText(line.text, line.x, line.y + offset);
  }
}

/* ------------------------------------------------------------------ *
 * Per-type painters
 * ------------------------------------------------------------------ */

/** Device px per board unit of the current transform (for shadow sizes). */
function deviceScale(ctx, zoom) {
  try {
    const m = ctx.getTransform?.();
    if (m) return Math.sqrt(Math.abs(m.a * m.d - m.b * m.c)) || zoom;
  } catch {
    /* fake or old context */
  }
  return zoom;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

/** Sticky-note paper colour when the element has none. */
export const STICKY_DEFAULT_FILL = '#ffec99';
/** Corner radius of a sticky note, board units. */
export const STICKY_RADIUS = 4;

const SHADOW_COLOR = 'rgba(0, 0, 0, 0.16)';
const SHADOW_BLUR = 12; // board units
const SHADOW_DY = 4; // board units
const SHADOW_MARGIN = SHADOW_BLUR + 4;

/*
 * A canvas `shadowBlur` is one of the slowest things a 2D context does, and a
 * board full of stickies would pay it for every note on every frame. So the
 * blurred shadow is rendered once into a small sprite and blitted.
 *
 * Notes come in every size (each resize makes a new one), so a sprite per
 * size would thrash any bounded cache. Instead the sprite is a 9-slice: the
 * shadow of one note just large enough that its corners do not reach each
 * other (2·SHADOW_SLICE_K + SHADOW_SLICE_MID units square). Any note at least
 * 2·SHADOW_SLICE_K on both sides is drawn from it — four corners as they are,
 * the edges and the middle stretched from the sprite's straight middle strip
 * — which is exactly the shadow of the big note, because a blur only reaches
 * 3σ = 1.5·blur.
 * One sprite per scale bucket, whatever the sizes. Only notes smaller than
 * that keep a sprite of their own size (small, and rare).
 *
 * The scale is bucketed in quarter octaves: a blur does not show a 9%
 * resample, and a pinch-zoom does not re-render sprites on every frame. A
 * sprite is never larger than SHADOW_SPRITE_MAX_PX: at a huge zoom it is
 * rendered coarser and scaled up (a blur has no detail to lose), instead of
 * falling back to a live `shadowBlur` hundreds of device px wide.
 */
const shadowSprites = new Map();
const SHADOW_SPRITES_MAX = 48;
const SHADOW_SPRITE_MAX_PX = 2048;
/** Corner piece of the 9-slice, board units past the note's edge inwards. */
export const SHADOW_SLICE_K = SHADOW_MARGIN + SHADOW_BLUR + STICKY_RADIUS;
/** Straight strip in the middle of the 9-slice note, board units. */
const SHADOW_SLICE_MID = 2;

function makeCanvas(w, h) {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  }
  return null;
}

function scaleBucket(scale, size) {
  const sb = 2 ** (Math.round(Math.log2(scale) * 4) / 4);
  return Math.min(sb, SHADOW_SPRITE_MAX_PX / (size + 2 * SHADOW_MARGIN));
}

/** Cached sprite by key (LRU), or null when no offscreen canvas exists. */
function cachedSprite(key, render) {
  const hit = shadowSprites.get(key);
  if (hit) {
    shadowSprites.delete(key); // LRU bump
    shadowSprites.set(key, hit);
    return hit;
  }
  const sprite = render();
  if (!sprite) return null;
  shadowSprites.set(key, sprite);
  if (shadowSprites.size > SHADOW_SPRITES_MAX) shadowSprites.delete(shadowSprites.keys().next().value);
  return sprite;
}

/**
 * The blurred shadow of a w x h note, alone, on a canvas covering the note
 * plus SHADOW_MARGIN on every side at `sb` device px per board unit.
 */
function renderShadow(w, h, sb) {
  const m = SHADOW_MARGIN;
  const canvas = makeCanvas(Math.ceil((w + 2 * m) * sb), Math.ceil((h + 2 * m) * sb));
  const g = canvas?.getContext('2d');
  if (!g) return null;
  // Draw the note far to the left, outside the sprite, and let the shadow
  // offset bring only its blurred shadow into view.
  const far = w + 2 * m + 64;
  g.setTransform(sb, 0, 0, sb, 0, 0);
  g.shadowColor = SHADOW_COLOR;
  g.shadowBlur = SHADOW_BLUR * sb;
  g.shadowOffsetX = far * sb;
  g.shadowOffsetY = 0;
  g.fillStyle = '#000';
  roundedRect(g, m - far, m, w, h, STICKY_RADIUS);
  g.fill();
  return canvas;
}

function sliceSprite(scale) {
  const n = 2 * SHADOW_SLICE_K + SHADOW_SLICE_MID;
  const sb = scaleBucket(scale, n);
  return cachedSprite(`9slice@${sb}`, () => {
    const canvas = renderShadow(n, n, sb);
    return canvas && { canvas, sb };
  });
}

function sizedSprite(w, h, scale) {
  const sb = scaleBucket(scale, Math.max(w, h));
  return cachedSprite(`${Math.round(w)}x${Math.round(h)}@${sb}`, () => {
    const canvas = renderShadow(w, h, sb);
    return canvas && { canvas, sb };
  });
}

/** A fill that hides whatever is under it (hex without alpha, or a name). */
function isOpaqueColor(c) {
  return typeof c === 'string' && (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) || (/^[a-z]+$/i.test(c) && c.toLowerCase() !== 'transparent'));
}

/**
 * Blit the note's shadow from a sprite. False when no sprite can be made
 * (no offscreen canvas: node), so the caller draws a live shadow instead.
 */
function drawStickyShadow(ctx, el, scale, fill) {
  const { x, y, w, h } = el;
  if (!(w > 0 && h > 0 && scale > 0)) return false;
  const m = SHADOW_MARGIN;
  const dy = SHADOW_DY;
  const K = SHADOW_SLICE_K;
  if (w >= 2 * K && h >= 2 * K) {
    const sprite = sliceSprite(scale);
    if (!sprite) return false;
    const { canvas, sb } = sprite;
    const c = (m + K) * sb; // a corner piece, sprite px
    const mid = SHADOW_SLICE_MID * sb; // the straight strip, sprite px
    const e = m + K; // a corner piece, board units
    // [source start, source size, destination start, destination size]
    const cols = [
      [0, c, x - m, e],
      [c, mid, x + K, w - 2 * K],
      [c + mid, c, x + w - K, e],
    ];
    const rows = [
      [0, c, y - m + dy, e],
      [c, mid, y + K + dy, h - 2 * K],
      [c + mid, c, y + h - K + dy, e],
    ];
    // The middle piece lies entirely under the note: skip it when the note
    // hides it anyway.
    const skipMiddle = ctx.globalAlpha >= 1 && isOpaqueColor(fill);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const col = cols[i];
        const row = rows[j];
        if (!(col[3] > 0 && row[3] > 0)) continue;
        if (i === 1 && j === 1 && skipMiddle) continue;
        ctx.drawImage(canvas, col[0], row[0], col[1], row[1], col[2], row[2], col[3], row[3]);
      }
    }
    return true;
  }
  const sprite = sizedSprite(w, h, scale);
  if (!sprite) return false;
  ctx.drawImage(sprite.canvas, x - m, y - m + dy, w + 2 * m, h + 2 * m);
  return true;
}

function drawSticky(ctx, el, zoom) {
  const fill = isPaint(el.fill) ? el.fill : STICKY_DEFAULT_FILL;
  const s = deviceScale(ctx, zoom);
  ctx.save();
  if (!drawStickyShadow(ctx, el, s, fill)) {
    // No offscreen canvas (node): the slow, exact way. Shadow sizes are in
    // device px (the transform does not scale them).
    ctx.shadowColor = SHADOW_COLOR;
    ctx.shadowBlur = SHADOW_BLUR * s;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = SHADOW_DY * s;
  }
  ctx.fillStyle = fill;
  roundedRect(ctx, el.x, el.y, el.w, el.h, STICKY_RADIUS);
  ctx.fill();
  ctx.restore();
  // A thin darker edge keeps pale notes readable on the white canvas.
  ctx.save();
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.06)';
  ctx.lineWidth = 1;
  roundedRect(ctx, el.x, el.y, el.w, el.h, STICKY_RADIUS);
  ctx.stroke();
  ctx.restore();
}

function drawShapeDesc(ctx, desc) {
  if (desc.kind === 'rough') {
    ctx.save();
    ctx.translate(desc.origin.x, desc.origin.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const d of desc.drawables) drawRough(ctx, d);
    ctx.restore();
  } else if (desc.kind === 'pen' && desc.path && desc.fill) {
    ctx.save();
    ctx.translate(desc.origin.x, desc.origin.y);
    ctx.fillStyle = desc.fill;
    if (HAS_PATH2D) {
      // Keyed by the outline shared between moved copies of a stroke, so a
      // drag does not re-parse the path on every frame.
      const key = desc.geom || desc;
      let p = compiled.get(key);
      if (!p) {
        p = new Path2D(desc.path);
        compiled.set(key, p);
      }
      ctx.fill(p);
    }
    ctx.restore();
  }
}

function drawImagePlaceholder(ctx, el, zoom, failed) {
  ctx.save();
  ctx.fillStyle = failed ? '#fff5f5' : '#f1f3f5';
  ctx.fillRect(el.x, el.y, el.w, el.h);
  ctx.strokeStyle = failed ? '#ffc9c9' : '#dee2e6';
  ctx.lineWidth = 1 / Math.max(zoom, 0.01);
  ctx.strokeRect(el.x, el.y, el.w, el.h);
  // A small "picture" glyph in the middle: a mountain and a sun.
  const s = Math.min(el.w, el.h) * 0.25;
  if (s > 4) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    ctx.strokeStyle = failed ? '#e03131' : '#adb5bd';
    ctx.lineWidth = Math.max(1 / Math.max(zoom, 0.01), s * 0.06);
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(cx - s, cy + s * 0.6);
    ctx.lineTo(cx - s * 0.3, cy - s * 0.2);
    ctx.lineTo(cx + s * 0.1, cy + s * 0.25);
    ctx.lineTo(cx + s * 0.45, cy - s * 0.05);
    ctx.lineTo(cx + s, cy + s * 0.6);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx + s * 0.45, cy - s * 0.55, s * 0.18, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawImageElement(ctx, el, opts) {
  if (!(el.w > 0 && el.h > 0)) return;
  let img = null;
  const cache = opts.imageCache;
  if (cache && typeof cache.get === 'function' && cache.has?.(el.src)) img = cache.get(el.src);
  else img = getImage(el.src, opts.onImageLoad);
  if (img) {
    // The dark theme is a CSS filter over the whole canvas; drawn through its
    // inverse, a photo keeps its colours instead of turning into a negative.
    // (The placeholder below is chrome: it is meant to go dark with the rest.)
    const counter = opts.dark === true;
    if (counter) {
      ctx.save();
      ctx.filter = DARK_MODE_COUNTER_FILTER;
    }
    try {
      ctx.drawImage(img, el.x, el.y, el.w, el.h);
      return;
    } catch {
      /* broken bitmap: fall through to the placeholder */
    } finally {
      if (counter) ctx.restore();
    }
  }
  drawImagePlaceholder(ctx, el, opts.zoom ?? 1, imageStatus(el.src) === 'error');
}

const POLY = new Set(['pen', 'arrow', 'line']);

/* ------------------------------------------------------------------ *
 * Paint extent (for the per-element bitmaps)
 * ------------------------------------------------------------------ */

/** A box accumulator: {x0, y0, x1, y1}, empty until a point is added. */
const emptyBox = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
const boxIsEmpty = (b) => !(b.x0 <= b.x1 && b.y0 <= b.y1);

function addPoint(b, x, y) {
  if (x < b.x0) b.x0 = x;
  if (x > b.x1) b.x1 = x;
  if (y < b.y0) b.y0 = y;
  if (y > b.y1) b.y1 = y;
}

function addBox(b, o, dx = 0, dy = 0) {
  if (!o || boxIsEmpty(o)) return;
  addPoint(b, o.x0 + dx, o.y0 + dy);
  addPoint(b, o.x1 + dx, o.y1 + dy);
}

/**
 * Local box of what drawRough paints for one Drawable: every op coordinate
 * (a bezier lies inside its control points' hull, so this is conservative),
 * grown by half the widest line it strokes. Cached per Drawable object —
 * Drawables are shared between moved copies (shape.js), and are local.
 */
const drawableBoxes = new WeakMap();

function drawableBox(d) {
  let b = drawableBoxes.get(d);
  if (b) return b;
  b = emptyBox();
  const o = d.options || {};
  let half = 0;
  for (const set of d.sets || []) {
    let width;
    if (set.type === 'path') {
      if (o.stroke === 'none') continue;
      width = o.strokeWidth;
    } else if (set.type === 'fillSketch') width = o.fillWeight < 0 ? o.strokeWidth / 2 : o.fillWeight;
    else if (set.type === 'fillPath') width = 0;
    else continue;
    if (Number.isFinite(width) && width / 2 > half) half = width / 2;
    for (const op of set.ops || []) {
      const v = op.data;
      for (let i = 0; i + 1 < v.length; i += 2) addPoint(b, v[i], v[i + 1]);
    }
  }
  if (!boxIsEmpty(b)) {
    b.x0 -= half;
    b.y0 -= half;
    b.x1 += half;
    b.y1 += half;
  }
  drawableBoxes.set(d, b);
  return b;
}

/** Local box of a pen outline path (its coordinates come in x y pairs). */
const penBoxes = new WeakMap();

function penPathBox(desc) {
  const key = desc.geom || desc;
  let b = penBoxes.get(key);
  if (b) return b;
  b = emptyBox();
  const nums = String(desc.path).match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || [];
  for (let i = 0; i + 1 < nums.length; i += 2) addPoint(b, Number(nums[i]), Number(nums[i + 1]));
  penBoxes.set(key, b);
  return b;
}

/**
 * Board-space axis-aligned box of EVERY pixel drawElement paints for `el`
 * (strokes with their width, rough wobble, arrowheads, the sticky shadow,
 * text that runs past its box), for rasterising an element into a bitmap of
 * its own: unlike the culling margin this must never be too small, or the
 * bitmap would clip the drawing. Computed from the actual Drawables, so a
 * big sketchy ellipse whose wobble reaches far past its box is covered.
 * Not rotated in by the caller: rotation is included here.
 *
 * null when the element paints nothing, or cannot be boxed (images: they are
 * drawn from their own bitmap anyway).
 * @param {object} el
 * @returns {{x0:number, y0:number, x1:number, y1:number}|null}
 */
export function elementPaintBox(el) {
  if (!el || typeof el !== 'object' || el.type === 'image') return null;
  const opacity = typeof el.opacity === 'number' ? el.opacity : 1;
  if (!(opacity > 0)) return null;
  // What turns with the element (its own box shapes), in board space unrotated.
  const local = emptyBox();
  switch (el.type) {
    case 'rect':
    case 'ellipse':
    case 'diamond':
    case 'cylinder':
    case 'arrow':
    case 'line': {
      const desc = getShape(el);
      if (desc.kind === 'rough') {
        for (const d of desc.drawables) addBox(local, drawableBox(d), desc.origin.x, desc.origin.y);
      }
      break;
    }
    case 'pen': {
      const desc = getShape(el);
      if (desc.kind === 'pen' && desc.path && desc.fill) addBox(local, penPathBox(desc), desc.origin.x, desc.origin.y);
      break;
    }
    case 'sticky': {
      const { x, y, w, h } = el;
      if ([x, y, w, h].every(Number.isFinite)) {
        // The note, its 1-unit edge line, and the shadow sprite around it.
        const m = SHADOW_MARGIN + 1;
        addPoint(local, x - m, y - m);
        addPoint(local, x + w + m, y + h + m + SHADOW_DY);
      }
      break;
    }
    case 'text':
      break;
    default:
      return null;
  }
  const out = emptyBox();
  if (!boxIsEmpty(local)) {
    const rotation = !POLY.has(el.type) && el.rotation ? el.rotation : 0;
    if (rotation && Number.isFinite(el.x) && Number.isFinite(el.w)) {
      const c = { x: el.x + el.w / 2, y: el.y + el.h / 2 };
      for (const [px, py] of [
        [local.x0, local.y0],
        [local.x1, local.y0],
        [local.x1, local.y1],
        [local.x0, local.y1],
      ]) {
        const p = rotateAround({ x: px, y: py }, c, rotation);
        addPoint(out, p.x, p.y);
      }
    } else addBox(out, local);
  }
  // The text (already turned with the element, and not clipped to its box),
  // with extra room for glyphs whose ink leaves their line box (accents on
  // capitals, a hand font's swashes): clipped ink would be a visible bug.
  const t = textPaintBounds(el);
  if (t) {
    const pad = (layoutOf(el)?.fontSize ?? 20) * 0.15;
    addBox(out, { x0: t.x - pad, y0: t.y - pad, x1: t.x + t.w + pad, y1: t.y + t.h + pad });
  }
  if (boxIsEmpty(out) || ![out.x0, out.y0, out.x1, out.y1].every(Number.isFinite)) return null;
  return out;
}

/**
 * Paint one element. `ctx` is in BOARD space; the element's rotation (about
 * its box centre) and opacity are applied here.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} el
 * @param {{zoom?:number, imageCache?:Map<string, CanvasImageSource>,
 *          isEditing?:boolean, onImageLoad?:() => void, dark?:boolean}} [opts]
 *   `imageCache`: pre-decoded images by src (the PNG export passes one);
 *   otherwise images come from `getImage`, and `onImageLoad` is called when
 *   one finishes loading. `isEditing`: the element's text is being edited in
 *   the <textarea>, so its text (or label) is not painted. `dark`: the
 *   canvas is shown through DARK_MODE_FILTER, so raster images are drawn
 *   through its inverse and keep their real colours.
 */
export function drawElement(ctx, el, opts = {}) {
  if (!el || typeof el !== 'object') return;
  const opacity = typeof el.opacity === 'number' ? Math.min(1, Math.max(0, el.opacity)) : 1;
  if (opacity <= 0) return;
  const zoom = opts.zoom ?? 1;
  ctx.save();
  if (opacity < 1) ctx.globalAlpha *= opacity;
  // Polylines carry any rotation in their points (handles.js treats them the
  // same way), so `rotation` is only applied to box elements.
  const rotation = !POLY.has(el.type) && el.rotation ? el.rotation : 0;
  if (rotation) {
    const cx = el.x + el.w / 2;
    const cy = el.y + el.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    ctx.translate(-cx, -cy);
  }
  try {
    switch (el.type) {
      case 'text':
        if (!opts.isEditing) drawTextLayout(ctx, layoutOf(el), textColorOf(el));
        break;
      case 'sticky':
        drawSticky(ctx, el, zoom);
        if (!opts.isEditing) drawTextLayout(ctx, layoutOf(el), textColorOf(el));
        break;
      case 'image':
        drawImageElement(ctx, el, opts);
        break;
      case 'pen':
      case 'arrow':
      case 'line':
        drawShapeDesc(ctx, getShape(el));
        break;
      case 'rect':
      case 'ellipse':
      case 'diamond':
      case 'cylinder':
        drawShapeDesc(ctx, getShape(el));
        if (!opts.isEditing) drawTextLayout(ctx, layoutOf(el), textColorOf(el));
        break;
      default:
        break;
    }
  } finally {
    ctx.restore();
  }
}
