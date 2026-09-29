/**
 * elementCache.js — a bitmap per element for the static layer.
 *
 * Replaying an element (every roughjs stroke of its hachure, every line of its
 * text) is what a static repaint costs, and every pan or zoom step repaints
 * every visible element. Zoomed out, that is the whole board: 2000 elements
 * took ~85 ms a frame to pan. Excalidraw's answer, used here too: each element
 * is rasterised ONCE at the current scale, and a repaint just blits those
 * bitmaps (one drawImage each) at their new place.
 *
 * Storage. A fresh <canvas> per element costs ~0.1 ms to create and first
 * use in Chromium — more than drawing a small element — so the first frame
 * of a zoomed-out board would be several times slower than drawing it
 * directly. Small bitmaps (both sides <= ATLAS_MAX_SIDE) are therefore packed
 * into shared atlas pages (PAGE_SIZE square canvases, shelf-packed, one
 * transparent device px between slots); only big ones get a canvas of their
 * own, and those are few (few big elements fit on screen).
 *
 * Two passes per frame. Writing to a canvas that another canvas has drawn
 * from, before that draw is flushed, makes the browser copy the whole source
 * first (copy-on-write): rasterising into a page between blits from it
 * copied a 16 MB page per element. So a frame first `prepare`s every visible
 * element (all rasterising happens here), then `paint`s them in z-order
 * (only blits, with the directly drawn elements in between).
 *
 * Validity. A bitmap is the element's pixels at one scale (device px per
 * board unit, dpr * zoom). It holds while
 *   - the element object is the same (the store replaces an element on every
 *     change, like every other cache of the renderer) and its paintStamp has
 *     not moved (the fonts loaded, invalidateElementCache);
 *   - the scale is the same. A pan never changes it.
 *
 * Pixel placement. A bitmap is aligned to the device-pixel grid of the board
 * origin (its left edge is floor(scale * left)) and blitted 1:1 at whole
 * device px, so a blit paints what drawing the element there would — no
 * resampling blur. That needs a pan of whole device px: renderStatic rounds
 * the pan (by at most half a device px, for everything it paints, so nothing
 * drifts apart).
 *
 * Budget. Rasterising a bitmap and blitting it costs more than drawing the
 * element once, so a frame spends at most RENDER_BUDGET_MS rasterising.
 * Past that, an element with no bitmap is drawn directly, and its bitmap is
 * made afterwards in idle time (PREFILL_SLICE_MS at a time, no repaint: the
 * screen is right already), ready for the next pan. So the first frame of a
 * zoomed-out board costs about what drawing it directly did.
 *
 * Zooming. During a continuous zoom (the scale changed again less than
 * ZOOM_SETTLE_MS after the last change) a bitmap made at another scale, within
 * 2x, is stretched instead of re-rendered, and a repaint is scheduled for when
 * the gesture settles. Stale bitmaps are then re-rendered at the exact scale
 * within the budget (the rest stay stretched a frame or two longer), so
 * neither the gesture nor a zoom step stalls on a big board.
 *
 * Drawn directly instead (the caller's job when `draw` returns false):
 * images (already a bitmap, and they change when they finish loading), an
 * element that keeps changing (dragged, resized, streamed from a peer:
 * re-rasterising it every frame would cost more than drawing it), bitmaps
 * too big to be worth it (larger than the viewport or MAX_BITMAP_PX), and
 * whatever does not fit the memory budget in this frame.
 *
 * Memory: at most BITMAP_BUDGET_PX device px of pages and own canvases per
 * target canvas. A slot freed by a changed element is not reused on its own;
 * a page is reset when nothing on it is alive, and when there is no room the
 * least recently used page not painted in this frame is emptied (its
 * elements are simply re-rasterised when next seen). Entries unused for
 * IDLE_MS are dropped. In node there is no canvas to rasterise into, so
 * nothing is cached and the scene is drawn directly (tests install a
 * factory).
 */

import { drawElement, elementPaintBox, paintStamp } from './renderElement.js';

/** Device px of pages and own canvases kept per target canvas (x4 bytes). */
export const BITMAP_BUDGET_PX = 16 * 1024 * 1024;
/** No single bitmap larger than this (nor than the viewport). */
export const MAX_BITMAP_PX = 4 * 1024 * 1024;
const MAX_BITMAP_SIDE = 4096;
/** Side of an atlas page, device px. */
export const PAGE_SIZE = 2048;
/** Bitmaps up to this side go into the atlas; larger ones get their own canvas. */
export const ATLAS_MAX_SIDE = 512;
/** Transparent px between two slots (so a stretched blit never samples a neighbour). */
const SLOT_GAP = 1;
/** Shelf heights are multiples of this (similar sizes share a shelf). */
const SHELF_STEP = 8;
/** An element that changed again within this long is drawn directly. */
export const HOT_MS = 300;
/** A zoom gesture is over when the scale has not changed for this long. */
export const ZOOM_SETTLE_MS = 200;
/** During a zoom gesture, a bitmap within this scale ratio is just stretched. */
const STALE_ZOOM_RATIO = 2;
/** A bitmap further off than this is never stretched (it would be mush). */
const STALE_MAX_STRETCH = 8;
/** Time per frame spent rasterising bitmaps. */
export const RENDER_BUDGET_MS = 12;
/** Idle-time rasterising runs in slices of at most this long. */
const PREFILL_SLICE_MS = 8;
const IDLE_MS = 60_000;
const SWEEP_EVERY_MS = 5_000;

function documentCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

let factory = null;
let budgetMs = RENDER_BUDGET_MS;

/**
 * Where bitmaps come from: (w, h) => canvas-like with width/height and
 * getContext('2d'). Default: detached <canvas> elements (they see the fonts
 * the document loaded). Pass null to restore the default. For tests.
 */
export function setBitmapCanvasFactory(fn) {
  factory = typeof fn === 'function' ? fn : null;
}

/** Override RENDER_BUDGET_MS (null restores it). For tests. */
export function setBitmapRenderBudget(ms) {
  budgetMs = typeof ms === 'number' && ms >= 0 ? ms : RENDER_BUDGET_MS;
}

function canvasFactory() {
  if (factory) return factory;
  if (typeof document !== 'undefined' && typeof document.createElement === 'function') return documentCanvas;
  return null;
}

const clock = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

/** Per target context: its bitmaps, pages and the zoom-gesture tracking. */
const states = new WeakMap();

function stateOf(ctx) {
  let st = states.get(ctx);
  if (!st) {
    st = {
      entries: new Map(), // element id -> entry, least recently used first
      pages: [],
      px: 0, // device px held: pages + own canvases
      scale: 0,
      scaleAt: -Infinity,
      burst: 0,
      frame: 0,
      timer: null,
      prefill: null, // the pending idle-time job, if any
      sweptAt: -Infinity,
    };
    states.set(ctx, st);
  }
  return st;
}

/** Bitmaps held for a target context, for tests and debugging. */
export function bitmapCacheStats(ctx) {
  const st = states.get(ctx);
  return st ? { entries: st.entries.size, pages: st.pages.length, px: st.px } : { entries: 0, pages: 0, px: 0 };
}

/* ------------------------------------------------------------------ *
 * Storage: atlas pages and own canvases
 * ------------------------------------------------------------------ */

/** Empty a page: every element on it loses its bitmap. */
function resetPage(st, page) {
  for (const e of page.live) {
    e.page = null;
    st.entries.delete(e.id);
  }
  page.live.clear();
  page.liveArea = 0;
  page.shelves = [];
  page.nextY = 0;
}

/** Release whatever holds an entry's pixels (the entry itself stays). */
function releaseStorage(st, e) {
  if (e.page) {
    const page = e.page;
    page.live.delete(e);
    page.liveArea -= e.slotArea;
    e.page = null;
    // Nothing alive on it: the whole page is free again.
    if (page.live.size === 0) {
      page.shelves = [];
      page.nextY = 0;
    }
  }
  if (e.canvas) {
    st.px -= e.px;
    e.canvas = null;
  }
}

function dropEntry(st, e) {
  releaseStorage(st, e);
  st.entries.delete(e.id);
}

/** A slot of w x h (plus the gap) on `page`, or null when it has no room. */
function shelfSlot(page, w, h) {
  const needW = w + SLOT_GAP;
  const needH = h + SLOT_GAP;
  for (const sh of page.shelves) {
    if (sh.h >= needH && sh.h <= needH * 1.5 + SHELF_STEP && PAGE_SIZE - sh.x >= needW) {
      const slot = { x: sh.x, y: sh.y };
      sh.x += needW;
      return slot;
    }
  }
  const shelfH = Math.ceil(needH / SHELF_STEP) * SHELF_STEP;
  if (PAGE_SIZE - page.nextY < shelfH || needW > PAGE_SIZE) return null;
  const sh = { y: page.nextY, h: shelfH, x: needW };
  page.shelves.push(sh);
  page.nextY += shelfH;
  return { x: 0, y: sh.y };
}

/* ------------------------------------------------------------------ *
 * Frames
 * ------------------------------------------------------------------ */

/**
 * Start painting a frame of the static layer from bitmaps.
 *
 * @param {CanvasRenderingContext2D} ctx  the target
 * @param {object} p
 * @param {number} p.scale    device px per board unit (dpr * zoom)
 * @param {number} p.originX  device x of board 0 (a whole number: the rounded pan)
 * @param {number} p.originY
 * @param {number} p.zoom     passed on to drawElement
 * @param {number} p.viewportPx  device px of the viewport (caps one bitmap)
 * @param {() => void} [p.repaint]  schedules a repaint; without it no
 *   stretched (stale) bitmap is ever shown, since nothing would sharpen it
 * @returns {BitmapFrame|null}  null when bitmaps cannot be made (node)
 */
export function beginBitmapFrame(ctx, { scale, originX, originY, zoom, viewportPx, repaint }) {
  const make = canvasFactory();
  if (!make || !(scale > 0) || !Number.isFinite(scale)) return null;
  const st = stateOf(ctx);
  const t = clock();
  if (scale !== st.scale) {
    st.burst = t - st.scaleAt < ZOOM_SETTLE_MS ? st.burst + 1 : 1;
    st.scale = scale;
    st.scaleAt = t;
  }
  st.frame++;
  return new BitmapFrame(ctx, st, make, {
    scale,
    originX,
    originY,
    zoom,
    t,
    maxPx: Math.min(MAX_BITMAP_PX, Math.max(viewportPx || 0, 256 * 256)),
    repaint: typeof repaint === 'function' ? repaint : null,
    zooming: st.burst >= 2 && t - st.scaleAt < ZOOM_SETTLE_MS,
    budget: budgetMs,
  });
}

const idle =
  typeof requestIdleCallback === 'function'
    ? (fn) => requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => setTimeout(() => fn(null), 16);

/**
 * Rasterise, in idle time, the bitmaps a frame had no budget for. An element
 * that changed again since (a newer object reached a frame) is skipped: the
 * frames handle it. A newer frame's job, or a new scale, supersedes the job.
 */
function schedulePrefill(st, frame, list) {
  const job = { scale: frame.scale, list, i: 0 };
  st.prefill = job;
  const run = (deadline) => {
    if (st.prefill !== job) return;
    if (st.scale !== job.scale) {
      st.prefill = null;
      return;
    }
    // Same frame number as the one that deferred them: what it painted is
    // not evicted to make room.
    const f = new BitmapFrame(null, st, frame.make, {
      scale: frame.scale,
      originX: 0,
      originY: 0,
      zoom: frame.zoom,
      t: clock(),
      maxPx: frame.maxPx,
      repaint: null,
      zooming: false,
      budget: Infinity,
      prefill: true,
    });
    const slice = Math.min(PREFILL_SLICE_MS, deadline?.timeRemaining?.() ?? PREFILL_SLICE_MS);
    const t0 = clock();
    while (job.i < job.list.length && clock() - t0 < slice) {
      const el = job.list[job.i++];
      const e = st.entries.get(el.id);
      if (e && e.el !== el && e.pending !== el) continue;
      f.prepare(el);
    }
    if (job.i < job.list.length) idle(run);
    else st.prefill = null;
  };
  idle(run);
}

class BitmapFrame {
  constructor(ctx, st, make, p) {
    this.ctx = ctx;
    this.st = st;
    this.make = make;
    Object.assign(this, p);
    this.spent = 0; // ms spent rasterising in this frame
    this.deferred = []; // elements left for idle time
    this.stale = 0; // bitmaps shown stretched
    this.blits = 0;
  }

  /**
   * Pass 1: make sure `el` has a usable bitmap (rasterising or refreshing
   * it when needed) and reserve it for this frame. Returns the entry to hand
   * to `paint`, or null when the element is not to be cached right now: the
   * caller then draws it directly, in board space.
   */
  prepare(el) {
    const id = el?.id;
    if (typeof id !== 'string' || el.type === 'image') return null;
    const st = this.st;
    const e = st.entries.get(id);
    const stamp = paintStamp(el);
    if (e && (e.el !== el || e.stamp !== stamp)) {
      e.el = null; // the pixels are no longer this element's, at any scale
      if (!this.prefill) {
        // Changed again only a moment after its last change: it is being
        // edited live. Draw it directly until it settles.
        const hot = this.t - e.changedAt < HOT_MS;
        e.changedAt = this.t;
        if (hot) {
          e.pending = null;
          return null;
        }
      }
    }
    if (e && e.el === el && (e.page || e.canvas)) {
      if (e.s === this.scale) return this.reserve(e);
      // Made at another scale. Stretched while a zoom gesture is on (unless
      // too far off, then re-rendered while this frame's budget lasts), and
      // whenever this frame's re-render budget is spent.
      const ratio = Math.max(this.scale / e.s, e.s / this.scale);
      const stretch =
        this.repaint &&
        ratio <= STALE_MAX_STRETCH &&
        ((this.zooming && ratio <= STALE_ZOOM_RATIO) || this.spent >= this.budget);
      if (stretch) {
        this.stale++;
        return this.reserve(e);
      }
    }
    if (this.spent >= this.budget) {
      // No time left in this frame: drawn directly, rasterised when idle.
      this.deferred.push(el);
      if (e) e.pending = el;
      return null;
    }
    return this.render(el, id, e, stamp);
  }

  /** Rasterise `el` at the frame's scale into a slot or own canvas. */
  render(el, id, e, stamp) {
    const st = this.st;
    const box = elementPaintBox(el);
    if (!box) {
      if (e) dropEntry(st, e);
      return null;
    }
    const s = this.scale;
    // One device px of room around the box for anti-aliasing.
    const ox = Math.floor(box.x0 * s) - 1;
    const oy = Math.floor(box.y0 * s) - 1;
    const w = Math.ceil(box.x1 * s) + 1 - ox;
    const h = Math.ceil(box.y1 * s) + 1 - oy;
    if (!(w > 0 && h > 0) || w > MAX_BITMAP_SIDE || h > MAX_BITMAP_SIDE || w * h > this.maxPx) {
      if (e) dropEntry(st, e);
      return null;
    }
    const t0 = clock();
    if (!e) {
      e = { id, changedAt: this.t, page: null, canvas: null, frame: -1 };
      st.entries.set(id, e);
    }
    let g;
    let x = 0;
    let y = 0;
    if (w <= ATLAS_MAX_SIDE && h <= ATLAS_MAX_SIDE) {
      releaseStorage(st, e);
      const slot = this.atlasSlot(w, h);
      if (!slot) {
        st.entries.delete(id);
        return null;
      }
      ({ x, y } = slot);
      e.page = slot.page;
      e.slotArea = (w + SLOT_GAP) * (h + SLOT_GAP);
      slot.page.live.add(e);
      slot.page.liveArea += e.slotArea;
      g = slot.page.g;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(x, y, w + SLOT_GAP, h + SLOT_GAP);
      // Never paint into a neighbour, whatever the element does.
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
    } else {
      g = this.ownCanvas(e, w, h);
      if (!g) {
        dropEntry(st, e);
        return null;
      }
      g.save();
    }
    g.setTransform(s, 0, 0, s, x - ox, y - oy);
    try {
      drawElement(g, el, { zoom: this.zoom, isEditing: false, dark: false });
    } finally {
      g.restore();
    }
    this.spent += clock() - t0;
    Object.assign(e, { el, stamp, s, ox, oy, w, h, sx: x, sy: y, pending: null });
    return this.reserve(e);
  }

  /** A canvas of exactly w x h for `e` (re-used when it has one), or null. */
  ownCanvas(e, w, h) {
    const st = this.st;
    const had = e.canvas ? e.px : 0;
    if (e.page) releaseStorage(st, e);
    if (!this.makeRoom(w * h - had, e)) return null;
    let canvas = e.canvas;
    if (!canvas) {
      canvas = this.make(w, h);
      if (!canvas) return null;
    } else if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; // resizing also clears it and resets its state
      canvas.height = h;
    }
    const g = canvas.getContext?.('2d');
    if (!g) return null;
    if (canvas === e.canvas) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, w, h);
    }
    st.px += w * h - had;
    e.canvas = canvas;
    e.px = w * h;
    return g;
  }

  /** A free slot in some page, opening or emptying a page when needed. */
  atlasSlot(w, h) {
    const st = this.st;
    for (const page of st.pages) {
      const slot = shelfSlot(page, w, h);
      if (slot) return this.use(page, slot);
    }
    const area = PAGE_SIZE * PAGE_SIZE;
    if (st.px + area <= BITMAP_BUDGET_PX) return this.newPage(w, h);
    // Full: empty the least recently used page this frame does not paint
    // from (its elements are re-rasterised when next seen). Failing that, a
    // page that is mostly dead slots (elements that changed since), even if
    // this frame reserved bitmaps on it: those elements are drawn directly
    // this once (`paint` returns false), and the page is compact again.
    let victim = null;
    let sparse = null;
    for (const page of st.pages) {
      if (page.frame !== st.frame) {
        if (!victim || page.usedAt < victim.usedAt) victim = page;
      } else if (page.liveArea < PAGE_SIZE * PAGE_SIZE * 0.5 && (!sparse || page.liveArea < sparse.liveArea)) {
        sparse = page;
      }
    }
    victim = victim ?? sparse;
    if (victim) {
      resetPage(st, victim);
      return this.use(victim, shelfSlot(victim, w, h));
    }
    // ...or make room for a new page by dropping big bitmaps.
    return this.makeRoom(area, null) ? this.newPage(w, h) : null;
  }

  newPage(w, h) {
    const st = this.st;
    const canvas = this.make(PAGE_SIZE, PAGE_SIZE);
    const g = canvas?.getContext?.('2d');
    if (!g) return null;
    const page = { canvas, g, shelves: [], nextY: 0, live: new Set(), liveArea: 0, frame: -1, usedAt: this.t };
    st.pages.push(page);
    st.px += PAGE_SIZE * PAGE_SIZE;
    return this.use(page, shelfSlot(page, w, h));
  }

  use(page, slot) {
    if (!slot) return null;
    page.frame = this.st.frame;
    page.usedAt = this.t;
    return { page, x: slot.x, y: slot.y };
  }

  /**
   * Free `need` px of budget: own canvases first, least recently used first,
   * then whole pages; never anything this frame has painted from (or
   * `keep`). False when that is not enough.
   */
  makeRoom(need, keep) {
    const st = this.st;
    const fits = () => st.px + need <= BITMAP_BUDGET_PX;
    if (fits()) return true;
    for (const e of st.entries.values()) {
      if (fits()) return true;
      if (e.frame === st.frame) break; // from here on, all painted this frame
      if (e === keep || !e.canvas) continue;
      dropEntry(st, e);
    }
    const pages = st.pages.filter((p) => p.frame !== st.frame).sort((a, b) => a.usedAt - b.usedAt);
    for (const page of pages) {
      if (fits()) return true;
      resetPage(st, page);
      st.pages.splice(st.pages.indexOf(page), 1);
      st.px -= PAGE_SIZE * PAGE_SIZE;
    }
    return fits();
  }

  /** Mark an entry (and its page) as painted this frame: most recently used. */
  reserve(e) {
    const st = this.st;
    st.entries.delete(e.id);
    st.entries.set(e.id, e);
    e.frame = st.frame;
    e.usedAt = this.t;
    if (e.page) {
      e.page.frame = st.frame;
      e.page.usedAt = this.t;
    }
    return e;
  }

  /**
   * Pass 2: blit a prepared entry for `el`, stretched when it was made at
   * another scale, with the target's current globalAlpha. Leaves the
   * target's transform at identity. False when the bitmap was given away
   * after `prepare` (its page was recycled): draw `el` directly then.
   */
  paint(e, el) {
    if (!e || e.el !== el || !(e.page || e.canvas)) return false;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const k = this.scale / e.s;
    const dx = e.ox * k + this.originX;
    const dy = e.oy * k + this.originY;
    if (e.page) ctx.drawImage(e.page.canvas, e.sx, e.sy, e.w, e.h, dx, dy, e.w * k, e.h * k);
    else if (k === 1) ctx.drawImage(e.canvas, dx, dy);
    else ctx.drawImage(e.canvas, dx, dy, e.w * k, e.h * k);
    this.blits++;
    return true;
  }

  /**
   * Finish the frame: schedule the idle-time rasterising of what the budget
   * left out, the repaint that sharpens stretched bitmaps (when the zoom
   * gesture has settled, or right away when only the budget ran out), and
   * drop bitmaps unused for a long time.
   */
  end() {
    const st = this.st;
    if (this.deferred.length) schedulePrefill(st, this, this.deferred);
    else st.prefill = null;
    if (this.stale && this.repaint) {
      const delay = this.zooming ? Math.max(0, ZOOM_SETTLE_MS - (this.t - st.scaleAt)) + 20 : 0;
      if (st.timer) clearTimeout(st.timer);
      const repaint = this.repaint;
      st.timer = setTimeout(() => {
        st.timer = null;
        repaint();
      }, delay);
    }
    if (this.t - st.sweptAt >= SWEEP_EVERY_MS) {
      st.sweptAt = this.t;
      for (const e of st.entries.values()) {
        if (!(this.t - (e.usedAt ?? -Infinity) >= IDLE_MS)) break;
        dropEntry(st, e);
      }
      // Keep one empty page for what comes next; free the others.
      let emptyKept = false;
      st.pages = st.pages.filter((page) => {
        if (page.live.size) return true;
        if (!emptyKept) {
          emptyKept = true;
          return true;
        }
        st.px -= PAGE_SIZE * PAGE_SIZE;
        return false;
      });
    }
    return { blits: this.blits, stale: this.stale, deferred: this.deferred.length };
  }
}
