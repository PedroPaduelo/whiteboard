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

import { layoutText, textColorOf } from '../text.js';
import { getShape, invalidateShape, isPaint, baselineOffset, FONT_METRICS } from './shape.js';
import { onFontsLoaded } from '../fonts.js';

/* ------------------------------------------------------------------ *
 * Caches
 * ------------------------------------------------------------------ */

/** Path2D per roughjs op set / pen path string. Keyed by the set object. */
const compiled = new WeakMap();
/** Text layout per element object; replaced wholesale when fonts load. */
let layouts = new WeakMap();
/** Measured font metrics per CSS font string. */
const metricsCache = new Map();

onFontsLoaded(() => {
  // Everything measured so far was measured with a fallback font.
  layouts = new WeakMap();
  metricsCache.clear();
});

const HAS_PATH2D = typeof Path2D !== 'undefined';

/** Drop every cached drawing/layout of one element (or of all of them). */
export function invalidateElementCache(el) {
  invalidateShape(el);
  if (el) layouts.delete(el);
  else layouts = new WeakMap();
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
 * board full of stickies would pay it for every note on every frame. Notes
 * mostly share a size, so the blurred shadow is rendered once per
 * (size, scale bucket) into a small sprite and blitted. The scale is bucketed
 * in quarter octaves: a blur does not show a 9% resample, and a pinch-zoom
 * does not re-render sprites on every frame.
 */
const shadowSprites = new Map();
const SHADOW_SPRITES_MAX = 48;

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

function stickyShadowSprite(w, h, scale) {
  if (!(w > 0 && h > 0 && scale > 0)) return null;
  const sb = 2 ** (Math.round(Math.log2(scale) * 4) / 4);
  const key = `${Math.round(w)}x${Math.round(h)}@${sb}`;
  const hit = shadowSprites.get(key);
  if (hit) {
    shadowSprites.delete(key); // LRU bump
    shadowSprites.set(key, hit);
    return hit;
  }
  const m = SHADOW_MARGIN;
  const pw = Math.ceil((w + 2 * m) * sb);
  const ph = Math.ceil((h + 2 * m) * sb);
  if (pw > 2048 || ph > 2048) return null;
  const canvas = makeCanvas(pw, ph);
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
  const sprite = { canvas, m };
  shadowSprites.set(key, sprite);
  if (shadowSprites.size > SHADOW_SPRITES_MAX) shadowSprites.delete(shadowSprites.keys().next().value);
  return sprite;
}

function drawSticky(ctx, el, zoom) {
  const fill = isPaint(el.fill) ? el.fill : STICKY_DEFAULT_FILL;
  const s = deviceScale(ctx, zoom);
  const sprite = stickyShadowSprite(el.w, el.h, s);
  ctx.save();
  if (sprite) {
    const m = sprite.m;
    ctx.drawImage(sprite.canvas, el.x - m, el.y - m + SHADOW_DY, el.w + 2 * m, el.h + 2 * m);
  } else {
    // No offscreen canvas (node) or a huge note: the slow, exact way.
    // Shadow sizes are in device px (the transform does not scale them).
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
      let p = compiled.get(desc);
      if (!p) {
        p = new Path2D(desc.path);
        compiled.set(desc, p);
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
    try {
      ctx.drawImage(img, el.x, el.y, el.w, el.h);
      return;
    } catch {
      /* broken bitmap: fall through to the placeholder */
    }
  }
  drawImagePlaceholder(ctx, el, opts.zoom ?? 1, imageStatus(el.src) === 'error');
}

const POLY = new Set(['pen', 'arrow', 'line']);

/**
 * Paint one element. `ctx` is in BOARD space; the element's rotation (about
 * its box centre) and opacity are applied here.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} el
 * @param {{zoom?:number, imageCache?:Map<string, CanvasImageSource>,
 *          isEditing?:boolean, onImageLoad?:() => void}} [opts]
 *   `imageCache`: pre-decoded images by src (the PNG export passes one);
 *   otherwise images come from `getImage`, and `onImageLoad` is called when
 *   one finishes loading. `isEditing`: the element's text is being edited in
 *   the <textarea>, so its text (or label) is not painted.
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
