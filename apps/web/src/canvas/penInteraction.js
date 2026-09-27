/**
 * penInteraction.js — the freehand pen and the eraser, as a pure reducer.
 *
 * Extracted from a 1,437-line pointer state machine that handled drawing,
 * selection, dragging, resizing, rotating, marquee, panning and zooming. All
 * of that now lives in React Flow, and having it in two places is what made
 * the app feel broken. What is left is the one thing React Flow's model cannot
 * hold: a freehand stroke.
 *
 * PURE — no DOM, no store, no Date.now (the timestamp arrives via `ctx`).
 * That is what makes it testable in node without a browser, and the reason
 * `penInteraction.test.js` can assert on point decimation and stroke
 * finishing without a canvas.
 *
 * ## Point decimation
 *
 * A three-second scribble produces hundreds of samples per pixel. Without a
 * spacing rule that is 10,000 points of which 99% are collinear — and every
 * peer pays for them over the wire, on every keystroke of the sync. Dropping
 * points closer than 2 screen pixels removes the redundancy without changing
 * the visible stroke.
 */

import { reboxPolyline, snapPoint } from '@whiteboard/shared';

/** Minimum on-screen spacing between two recorded points, in CSS pixels. */
const PEN_POINT_SPACING = 2;

export function idleState() {
  return {
    phase: 'idle',
    start: null,
    draft: null,
    current: { x: 0, y: 0 },
    erased: [],
  };
}

const next = (state, patch) => ({ ...state, ...patch });

/** Append a point unless it is too close to the last one. */
function appendPoint(draft, pt, zoom) {
  const pts = draft.points;
  const last = pts[pts.length - 1];
  const minDist = PEN_POINT_SPACING / (zoom || 1);
  const dx = pt.x - last.x;
  const dy = pt.y - last.y;
  if (dx * dx + dy * dy < minDist * minDist) return draft;
  return reboxPolyline({ ...draft, points: pts.concat([{ x: pt.x, y: pt.y }]) });
}

/** A short tap still makes a dot: the user meant to mark the spot. */
function strokeFrom(points, ctx) {
  const el = {
    id: `pen_${ctx.now?.toString(36) ?? 'x'}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'pen',
    x: 0,
    y: 0,
    w: 0,
    h: 0,
    points,
    stroke: ctx.style?.stroke || '#1f2937',
    strokeWidth: ctx.style?.strokeWidth ?? 3,
    strokeStyle: 'solid',
  };
  return reboxPolyline(el);
}

/** Hit a pen stroke within a tolerance in BOARD units. */
function hitStroke(elements, pt, tolerance) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (el.type !== 'pen' || !Array.isArray(el.points)) continue;
    const w = (el.strokeWidth ?? 3) / 2 + tolerance;
    for (let j = 0; j < el.points.length - 1; j++) {
      const a = el.points[j];
      const b = el.points[j + 1];
      if (pointSegDistSq(pt, a, b) <= w * w) return el.id;
    }
    if (el.points.length === 1) {
      const p = el.points[0];
      if ((pt.x - p.x) ** 2 + (pt.y - p.y) ** 2 <= w * w) return el.id;
    }
  }
  return null;
}

function pointSegDistSq(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return (p.x - cx) ** 2 + (p.y - cy) ** 2;
}

/**
 * The reducer.
 *
 * @param {object} state
 * @param {{type:string, boardPt:{x:number,y:number}}} event
 * @param {{tool:string, elements:object[], style:object, view:object, now:number}} ctx
 * @returns {{state:object, effects:Array<object>}}
 */
export function reducePen(state, event, ctx = {}) {
  const s = state || idleState();
  const pt = event?.boardPt;
  if (!pt) return { state: s, effects: [] };
  const zoom = ctx.view?.zoom || 1;

  switch (event.type) {
    case 'pointerdown': {
      if (ctx.tool === 'eraser') {
        const id = hitStroke(ctx.elements || [], pt, 6 / zoom);
        if (!id) return { state: next(s, { phase: 'erase', erased: [] }), effects: [] };
        // One commit, one removal — a sweep must not produce a history entry
        // per stroke crossed.
        return {
          state: next(s, { phase: 'erase', start: pt, erased: [id] }),
          effects: [{ type: 'commit', label: 'erase' }, { type: 'removeElements', ids: [id] }],
        };
      }
      if (ctx.tool !== 'pen') return { state: idleState(), effects: [] };
      const snapped = ctx.gridSize > 0 ? snapPoint(pt, ctx.gridSize) : pt;
      const draft = strokeFrom([{ x: snapped.x, y: snapped.y }], ctx);
      return {
        state: next(s, { phase: 'draw', start: pt, draft, current: pt }),
        effects: [{ type: 'setDraft', element: draft }],
      };
    }

    case 'pointermove': {
      if (s.phase === 'draw') {
        const draft = appendPoint(s.draft, pt, zoom);
        if (draft === s.draft) return { state: next(s, { current: pt }), effects: [] };
        return { state: next(s, { draft, current: pt }), effects: [{ type: 'setDraft', element: draft }] };
      }
      if (s.phase === 'erase') {
        const id = hitStroke(ctx.elements || [], pt, 6 / zoom);
        if (!id || s.erased.includes(id)) return { state: next(s, { current: pt }), effects: [] };
        return {
          state: next(s, { current: pt, erased: s.erased.concat([id]) }),
          effects: [{ type: 'removeElements', ids: [id] }],
        };
      }
      return { state: next(s, { current: pt }), effects: [] };
    }

    case 'pointerup': {
      if (s.phase === 'draw') {
        // The final point snaps like every other one. Appending the RAW
        // pointerup position leaves a stroke's last point a few hundredths of
        // a unit off the grid while the rest is aligned — invisible on a
        // freehand line, obvious on a shape snapped to a grid, and it makes
        // the bounding box disagree with what the user drew.
        const final = ctx.gridSize > 0 ? snapPoint(pt, ctx.gridSize) : pt;
        const draft = appendPoint(s.draft, final, zoom);
        const finished = strokeFrom(draft.points, ctx);
        return {
          state: idleState(),
          effects: [
            { type: 'commit', label: 'add pen' },
            { type: 'addElement', element: finished },
            { type: 'setDraft', element: null },
          ],
        };
      }
      return { state: idleState(), effects: [{ type: 'setDraft', element: null }] };
    }

    // A cancelled gesture is an escape: the pointer was stolen, the window
    // lost focus, the touch was interrupted. Whatever was half-drawn is
    // discarded — committing it would put a stroke on the board that the user
    // never finished, and there is no way to tell it apart from a real one.
    case 'pointercancel':
    case 'lostpointercapture':
      return { state: idleState(), effects: [{ type: 'setDraft', element: null }] };

    default:
      return { state: s, effects: [] };
  }
}

export { hitStroke };
