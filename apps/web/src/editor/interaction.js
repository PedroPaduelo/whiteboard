/**
 * interaction.js — every pointer gesture on the canvas, as a pure reducer.
 *
 *     reduce(state, event, ctx) -> { state, effects, handled }
 *
 * `event` is a normalised pointer/keyboard/wheel event in CSS px relative to
 * the canvas; `ctx` is a read-only snapshot of the store (elements, selection,
 * tool, style, view, …); `effects` is an ordered list of store operations the
 * Canvas applies (commit, addElements, updateElements, select, setTool, panBy,
 * zoomAt, startTextEdit, …). Nothing here touches the DOM or the store, which
 * is what lets interaction.test.js drive whole gestures in node and assert
 * exactly which commits and patches they produce.
 *
 * The rules that keep undo and sync honest:
 *  - A gesture that edits existing elements (move, resize, rotate, point
 *    drag) emits ONE `commit` with a label unique to the gesture at its first
 *    real movement (never on pointerdown, so a click creates no undo entry),
 *    then `updateElements` every frame — peers watch it happen live. Bound
 *    connectors are re-resolved into the same batch (scene.resolveBindingPatches).
 *  - A gesture that CREATES an element keeps a local `draft` (rendered, not in
 *    the store) and emits `commit` + `addElements` once, when it finishes.
 *  - The eraser marks elements while dragging and removes them all with one
 *    commit on release.
 *  - Locked elements never move, resize or get erased.
 *
 * `handled` (an extension of the contract's `{state, effects}`) tells the
 * Canvas it consumed a key/wheel event, so it can preventDefault and keep the
 * global shortcut handler from acting on it too (Escape finishing a
 * multi-point arrow must not also clear the selection).
 */

import { boundsOfPoints, rectFromDrag, resolveConnectors, constrainAngle, snapValue, LIMITS } from '@whiteboard/shared';
import {
  DRAG_THRESHOLD,
  DEFAULT_SHAPE_SIZE,
  STICKY_SIZE,
  MIN_SHAPE_SIZE,
  FREEDRAW_MIN_SPACING,
  POINT_HANDLE_RADIUS,
  FONT_SIZES,
} from './constants.js';
import { createElement, cloneElements, isLinear, isText, isContainer, isRotatable } from './elements.js';
import { BOX_TOOLS, LINEAR_TOOLS } from './tools.js';
import { selectionFrame, hitHandle, cursorForHandle, commonBounds } from './handles.js';
import { lineHeightPx } from './text.js';
import {
  hitTest,
  hitTestAll,
  elementsInMarquee,
  hitLinearPoint,
  hitLinearSegment,
  pointInFrame,
} from './hitTest.js';
import {
  expandSelectionToGroups,
  groupMembers,
  moveElements,
  resizeElements,
  rotateElements,
  resolveBindingPatches,
  findBindTarget,
  snapToGrid,
  transformFrame,
  handlePoint,
  applyPatches,
} from './scene.js';

/** Modes during which a pointer button is held and owns the gesture. */
const HELD_MODES = new Set(['panning', 'marquee', 'moving', 'resizing', 'rotating', 'creating', 'freedraw', 'editingPoint', 'erasing']);

/** Maximum number of recent points kept for the fading eraser trail. */
const ERASER_TRAIL_MAX = 24;

/** A small circle cursor for the eraser (Excalidraw draws a similar ring). */
const ERASER_CURSOR =
  'url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2720%27 height=%2720%27%3E%3Ccircle cx=%2710%27 cy=%2710%27 r=%277%27 fill=%27white%27 stroke=%27%231e1e1e%27 stroke-width=%271.5%27/%3E%3C/svg%3E") 10 10, crosshair';

/** Initial interaction state. The public fields are read by the renderer. */
export function initialInteraction() {
  return {
    mode: 'idle',
    draft: null, // element being created (not in the store yet)
    marquee: null, // {x,y,w,h} board units while marquee-selecting
    bindTarget: null, // element object an arrow end would bind to (highlight)
    erasingIds: null, // Set of ids marked by the eraser
    eraserTrail: null, // [{x,y,at}] recent eraser positions, board units
    linearEdit: null, // {id, hoverIndex, activeIndex, editing} for a single selected connector
    cursor: 'default',
    // --- private ---
    seq: 0, // gesture counter (unique commit labels)
    g: null, // the active gesture record
    hoveredId: null,
    editingGroupId: null, // group entered by double-click (clicks then select members)
    swallowDblClick: false, // the click pair that finished a creation must not also dblclick
    lastPointer: null, // last pointer event, to re-evaluate a gesture when Shift/Alt change
  };
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const IDENTITY_VIEW = { zoom: 1, panX: 0, panY: 0 };
const viewOf = (ctx) => ctx.view ?? IDENTITY_VIEW;
const zoomOf = (ctx) => viewOf(ctx).zoom || 1;

function toBoard(e, ctx) {
  const v = viewOf(ctx);
  return { x: (e.x - v.panX) / (v.zoom || 1), y: (e.y - v.panY) / (v.zoom || 1) };
}

const screenDist = (g, e) => Math.hypot(e.x - g.sx, e.y - g.sy);
const selectionOf = (ctx) => (ctx.selection instanceof Set ? ctx.selection : new Set(ctx.selection ?? []));
const selectedElements = (ctx) => {
  const sel = selectionOf(ctx);
  return ctx.elements.filter((el) => sel.has(el.id));
};

function sameIdSet(a, b) {
  const sa = a instanceof Set ? a : new Set(a);
  const sb = b instanceof Set ? b : new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

const snapOn = (ctx) => Boolean(ctx.snapEnabled) && ctx.gridSize > 0;
const snapP = (p, ctx) => snapToGrid(p, ctx.gridSize, snapOn(ctx));

/** Handle options for a selection — must match what the renderer draws. */
function handleOpts(selected) {
  return { rotatable: selected.length > 1 || (selected.length === 1 && isRotatable(selected[0])) };
}

/** Does this selection show box transform handles? (Not for a lone connector, not with locked members.) */
function hasBoxHandles(selected) {
  if (selected.length === 0) return false;
  if (selected.some((el) => el.locked)) return false;
  if (selected.length === 1 && isLinear(selected[0])) return false;
  return true;
}

/** The single, unlocked, selected connector (point handles), or null. */
function soleLinear(ctx) {
  const sel = selectionOf(ctx);
  if (sel.size !== 1) return null;
  const [id] = sel;
  const el = ctx.elements.find((e) => e.id === id);
  return el && isLinear(el) && !el.locked ? el : null;
}

function groupKeyOf(el, elements) {
  if (el.groupId) return el.groupId;
  return elements.some((e) => e.groupId === el.id) ? el.id : null;
}

function nextGestureLabel(s, kind, ctx) {
  s.seq += 1;
  return `${kind}:${ctx.now ?? 0}:${s.seq}`;
}

function newTextAt(p, ctx) {
  const style = ctx.style ?? {};
  const fontSize = style.fontSize ?? FONT_SIZES.M;
  return createElement('text', { x: p.x, y: p.y - lineHeightPx(fontSize) / 2, text: '' }, style);
}

function endGesture(s) {
  s.g = null;
  s.mode = 'idle';
  s.draft = null;
  s.marquee = null;
  s.bindTarget = null;
  s.erasingIds = null;
  s.eraserTrail = null;
}

/* ------------------------------------------------------------------ *
 * Cursor
 * ------------------------------------------------------------------ */

function idleCursor(s, p, ctx) {
  if (ctx.spaceDown || ctx.tool === 'hand') return 'grab';
  switch (ctx.tool) {
    case 'select':
      break;
    case 'text':
      return 'text';
    case 'eraser':
      return ERASER_CURSOR;
    case 'image':
      return 'copy';
    default:
      return 'crosshair';
  }
  if (!p) return 'default';
  const zoom = zoomOf(ctx);
  const lin = soleLinear(ctx);
  if (lin && hitLinearPoint(lin, p, zoom) >= 0) return 'pointer';
  const selected = selectedElements(ctx);
  if (hasBoxHandles(selected)) {
    const frame = selectionFrame(selected, zoom);
    const key = hitHandle(frame, p, zoom, handleOpts(selected));
    if (key) return cursorForHandle(key, frame.rotation);
  }
  const hit = hitTest(ctx.elements, p, zoom, { skipLocked: true });
  if (hit) return 'move';
  if (selected.length && !selected.every((el) => el.locked) && pointInFrame(selectionFrame(selected, zoom), p)) return 'move';
  return 'default';
}

/* ------------------------------------------------------------------ *
 * The reducer
 * ------------------------------------------------------------------ */

/**
 * @param {object} state  from initialInteraction() or a previous reduce()
 * @param {object} event  {type, x, y, button, buttons, shiftKey, altKey, mod, pointerType, pointerId, key, pressure,
 *                         deltaX, deltaY, deltaMode (wheel)}
 * @param {object} ctx    {elements, selection, tool, toolLocked, style, view, gridSize, snapEnabled, editingId, now, spaceDown}
 * @returns {{state: object, effects: object[], handled: boolean}}
 */
export function reduce(state, event, ctx) {
  const s = { ...(state ?? initialInteraction()) };
  // Gesture handlers update their record in place: copy it so the reducer
  // never mutates the state it was given.
  if (s.g) s.g = { ...s.g };
  const fx = [];
  let handled = false;
  const c = { ...ctx, elements: ctx.elements ?? [], selection: selectionOf(ctx) };

  // Keep the connector point-editing state in step with the selection.
  syncLinearEdit(s, c);

  // The tool changed under a gesture that belongs to a tool (a shortcut while
  // drawing): finish or drop it before anything else.
  if (s.g && s.g.tool && s.g.tool !== c.tool) abortGesture(s, c, fx, { finalize: true });

  switch (event.type) {
    case 'pointerdown':
      onPointerDown(s, event, c, fx);
      break;
    case 'pointermove':
      onPointerMove(s, event, c, fx);
      break;
    case 'pointerup':
      onPointerUp(s, event, c, fx);
      break;
    case 'pointercancel':
      if (s.g && (s.g.held || HELD_MODES.has(s.mode))) abortGesture(s, c, fx, { finalize: false });
      break;
    case 'blur':
      if (s.g) abortGesture(s, c, fx, { finalize: true });
      s.cursor = idleCursor(s, null, { ...c, spaceDown: false });
      break;
    case 'toolchange':
      if (s.g) abortGesture(s, c, fx, { finalize: true });
      s.bindTarget = null;
      s.editingGroupId = null;
      s.cursor = idleCursor(s, s.lastPointer ? toBoard(s.lastPointer, c) : null, c);
      break;
    case 'dblclick':
      onDoubleClick(s, event, c, fx);
      handled = true;
      break;
    case 'contextmenu':
      if (!(s.g && s.g.held)) {
        if (s.g) abortGesture(s, c, fx, { finalize: true });
        contextMenu(s, event, toBoard(event, c), c, fx);
      }
      handled = true;
      break;
    case 'pointerleave':
      // The pointer left the board: drop hover feedback (not an active gesture).
      if (!s.g || !s.g.held) {
        if (s.hoveredId !== null) {
          s.hoveredId = null;
          fx.push({ type: 'setHovered', id: null });
        }
        if (!s.g) s.bindTarget = null;
      }
      break;
    case 'keydown':
    case 'keyup':
      handled = onKey(s, event, c, fx);
      break;
    case 'wheel':
      onWheel(s, event, c, fx);
      handled = true;
      break;
    default:
      break;
  }
  return { state: s, effects: fx, handled };
}

function syncLinearEdit(s, ctx) {
  if (s.mode === 'editingPoint') return;
  const lin = soleLinear(ctx);
  if (!lin) {
    s.linearEdit = null;
    return;
  }
  const prev = s.linearEdit;
  if (prev && prev.id === lin.id) {
    const n = lin.points.length;
    if ((prev.activeIndex ?? -1) >= n || (prev.hoverIndex ?? -1) >= n) {
      s.linearEdit = { ...prev, activeIndex: -1, hoverIndex: -1 };
    }
    return;
  }
  s.linearEdit = { id: lin.id, hoverIndex: -1, activeIndex: -1, editing: false };
}

/**
 * End the active gesture early. `finalize` keeps whatever the user already
 * made (a multi-point connector with ≥ 2 placed points is added); otherwise
 * drafts are dropped. Edits already written to the store (move, resize…)
 * stay: they were committed at their first movement and are one undo step.
 */
function abortGesture(s, ctx, fx, { finalize }) {
  const g = s.g;
  if (!g) return;
  if (g.kind === 'linear' && finalize && g.phase === 'clicking') {
    finishLinear(s, ctx, fx, g.points.slice(0, -1), { switchTool: false });
    return;
  }
  // Everything else: drafts are dropped; edits already written stay (a point
  // drag that unbound its end at the first movement leaves it unbound).
  endGesture(s);
}

/* ------------------------------------------------------------------ *
 * pointerdown
 * ------------------------------------------------------------------ */

function onPointerDown(s, e, ctx, fx) {
  s.lastPointer = e;
  const p = toBoard(e, ctx);

  // A multi-point connector in progress owns every click until it finishes;
  // a right click finishes it.
  if (s.g && s.g.kind === 'linear' && s.g.phase === 'clicking') {
    if (e.button === 2) {
      finishLinear(s, ctx, fx, s.g.points.slice(0, -1));
      return;
    }
    if (e.button === 0 && !ctx.spaceDown) {
      linearClick(s, e, p, ctx, fx);
      return;
    }
  }
  if (s.g && s.g.held) {
    // The SAME pointer pressing again means its pointerup was lost (released
    // outside the window): finish that gesture first. Another pointer (a
    // stray second touch) is ignored.
    if (e.pointerId === undefined || e.pointerId !== s.g.pointerId) return;
    onPointerUp(s, e, ctx, fx);
    if (s.g && s.g.held) return;
  }
  if (s.g) abortGesture(s, ctx, fx, { finalize: true });
  s.swallowDblClick = false;

  // The right button starts nothing: the menu opens on the `contextmenu`
  // event (which also covers Ctrl+click on macOS and touch long-press).
  if (e.button === 2) return;
  if (e.button === 1 || ctx.tool === 'hand' || (ctx.spaceDown && e.button === 0)) {
    s.g = { kind: 'pan', held: true, sx: e.x, sy: e.y, lx: e.x, ly: e.y, pointerId: e.pointerId };
    s.mode = 'panning';
    s.cursor = 'grabbing';
    return;
  }
  if (e.button !== 0 && e.button !== undefined) return;

  const tool = ctx.tool;
  if (tool === 'select') selectDown(s, e, p, ctx, fx);
  else if (BOX_TOOLS.includes(tool)) boxDown(s, e, p, ctx);
  else if (LINEAR_TOOLS.includes(tool)) linearDown(s, e, p, ctx);
  else if (tool === 'pen') penDown(s, e, p, ctx);
  else if (tool === 'text') {
    s.g = { kind: 'text', tool, held: true, sx: e.x, sy: e.y, start: p, pointerId: e.pointerId };
    s.mode = 'creating';
  } else if (tool === 'eraser') eraserDown(s, e, p, ctx);
  else if (tool === 'image') {
    s.g = { kind: 'image', tool, held: true, sx: e.x, sy: e.y, start: p, pointerId: e.pointerId };
    s.mode = 'creating';
  }
}

function contextMenu(s, e, p, ctx, fx) {
  const hit = hitTest(ctx.elements, p, zoomOf(ctx), { skipLocked: true }) ?? hitTest(ctx.elements, p, zoomOf(ctx));
  if (hit) {
    if (!ctx.selection.has(hit.id)) fx.push({ type: 'select', ids: expandSelectionToGroups(ctx.elements, [hit.id]) });
  } else if (ctx.selection.size) {
    fx.push({ type: 'select', ids: [] });
  }
  fx.push({ type: 'contextMenu', x: e.x, y: e.y, targetId: hit ? hit.id : null });
}

/* --- select tool ---------------------------------------------------- */

function selectDown(s, e, p, ctx, fx) {
  const zoom = zoomOf(ctx);
  const els = ctx.elements;
  const selected = selectedElements(ctx);
  const base = { held: true, sx: e.x, sy: e.y, start: p, pointerId: e.pointerId, started: false };

  // 1. Point handles of a lone selected connector.
  const lin = soleLinear(ctx);
  if (lin) {
    let idx = hitLinearPoint(lin, p, zoom);
    let original = lin;
    // Ctrl/⌘-click on a segment while point-editing inserts a point and drags it.
    if (idx < 0 && e.mod && s.linearEdit?.editing && lin.points.length < LIMITS.MAX_POINTS) {
      const seg = hitLinearSegment(lin, p, zoom);
      if (seg >= 0) {
        const points = lin.points.map((q) => ({ x: q.x, y: q.y }));
        points.splice(seg + 1, 0, { x: p.x, y: p.y });
        original = { ...lin, points };
        idx = seg + 1;
        base.insert = true;
      }
    }
    if (idx >= 0) {
      const q = original.points[idx];
      s.g = { ...base, kind: 'point', id: lin.id, index: idx, original, grab: { x: p.x - q.x, y: p.y - q.y } };
      s.mode = 'editingPoint';
      s.linearEdit = { id: lin.id, hoverIndex: idx, activeIndex: idx, editing: s.linearEdit?.editing ?? false };
      s.cursor = 'grabbing';
      return;
    }
  }

  // 2. Transform handles of the selection.
  if (hasBoxHandles(selected)) {
    const frame = selectionFrame(selected, zoom);
    const key = hitHandle(frame, p, zoom, handleOpts(selected));
    if (key) {
      const tf = transformFrame(selected);
      if (key === 'rotation') {
        s.g = { ...base, kind: 'rotate', originals: selected, frame: tf };
        s.mode = 'rotating';
        s.cursor = 'grabbing';
      } else {
        const hp = handlePoint(tf, key);
        s.g = { ...base, kind: 'resize', handle: key, originals: selected, frame: tf, grab: { x: p.x - hp.x, y: p.y - hp.y } };
        s.mode = 'resizing';
        s.cursor = cursorForHandle(key, frame.rotation);
      }
      return;
    }
  }

  // 3. An element under the pointer.
  const hit = hitTest(els, p, zoom, { skipLocked: true });
  if (hit) {
    let groupIds;
    if (s.editingGroupId && groupMembers(els, s.editingGroupId).some((m) => m.id === hit.id)) {
      groupIds = [hit.id];
    } else {
      s.editingGroupId = null;
      groupIds = expandSelectionToGroups(els, [hit.id]);
    }
    const wasSelected = ctx.selection.has(hit.id);
    let next;
    let deferToggle = null;
    let deferOnly = null;
    if (e.shiftKey) {
      if (wasSelected) {
        next = new Set(ctx.selection);
        deferToggle = groupIds; // deselect on release, unless this becomes a drag
      } else {
        next = new Set([...ctx.selection, ...groupIds]);
      }
    } else if (wasSelected) {
      next = new Set(ctx.selection);
      if (!sameIdSet(next, groupIds)) deferOnly = groupIds; // click (no drag) narrows to this one
    } else {
      next = new Set(groupIds);
    }
    if (!sameIdSet(next, ctx.selection)) fx.push({ type: 'select', ids: [...next] });
    startMove(s, base, els.filter((el) => next.has(el.id)), { deferToggle, deferOnly });
    return;
  }

  // 4. Inside the current selection frame: grab the selection (so a selected
  //    transparent shape can be dragged by its empty middle).
  if (!e.shiftKey && selected.length && selected.some((el) => !el.locked)) {
    if (pointInFrame(selectionFrame(selected, zoom), p)) {
      startMove(s, base, selected, {});
      return;
    }
  }

  // 5. A locked element, only when nothing else is under the pointer: select it, never move it.
  const lockedHit = hitTest(els, p, zoom);
  if (lockedHit && lockedHit.locked) {
    s.editingGroupId = null;
    if (e.shiftKey) {
      const next = new Set(ctx.selection);
      if (next.has(lockedHit.id)) next.delete(lockedHit.id);
      else next.add(lockedHit.id);
      fx.push({ type: 'select', ids: [...next] });
    } else if (!sameIdSet([lockedHit.id], ctx.selection)) {
      fx.push({ type: 'select', ids: [lockedHit.id] });
    }
    s.g = { ...base, kind: 'noop' };
    s.mode = 'idle';
    return;
  }

  // 6. Empty canvas: marquee (Shift adds to the selection).
  s.editingGroupId = null;
  if (!e.shiftKey && ctx.selection.size) fx.push({ type: 'select', ids: [] });
  s.g = { ...base, kind: 'marquee', base: e.shiftKey ? [...ctx.selection] : [] };
  s.mode = 'marquee';
}

function startMove(s, base, targets, { deferToggle = null, deferOnly = null }) {
  const originals = targets.filter((el) => !el.locked);
  s.g = {
    ...base,
    kind: 'move',
    originals,
    bounds: originals.length ? commonBounds(originals) : null,
    deferToggle,
    deferOnly,
  };
  s.mode = 'moving';
  s.cursor = 'move';
}

/* --- creation tools -------------------------------------------------- */

function boxDown(s, e, p, ctx) {
  const start = snapP(p, ctx);
  const draft = createElement(ctx.tool, { x: start.x, y: start.y, w: 0, h: 0 }, ctx.style);
  s.g = { kind: 'box', tool: ctx.tool, held: true, sx: e.x, sy: e.y, start, draft, pointerId: e.pointerId, started: false };
  s.mode = 'creating';
  s.draft = null;
  s.cursor = 'crosshair';
}

/** The box of a drag from `a` to `b`: Shift makes it square, Alt grows it from `a` as the centre. */
function dragBox(a, b, { square, fromCenter }) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    dx = (dx < 0 ? -1 : 1) * m;
    dy = (dy < 0 ? -1 : 1) * m;
  }
  if (fromCenter) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return rectFromDrag(a, { x: a.x + dx, y: a.y + dy });
}

function linearDown(s, e, p, ctx) {
  const start = snapP(p, ctx);
  const startTarget = findBindTarget(ctx.elements, p, zoomOf(ctx));
  const draft = createElement(ctx.tool, { points: [start, { x: start.x, y: start.y }] }, ctx.style);
  s.g = {
    kind: 'linear',
    tool: ctx.tool,
    phase: 'dragging',
    held: true,
    sx: e.x,
    sy: e.y,
    start,
    points: [start, { x: start.x, y: start.y }],
    startTarget,
    draft,
    pointerId: e.pointerId,
    started: false,
  };
  s.mode = 'linear';
  s.draft = null;
  s.bindTarget = startTarget;
  s.cursor = 'crosshair';
}

function penDown(s, e, p, ctx) {
  const draft = createElement('pen', { points: [p] }, ctx.style);
  s.g = { kind: 'pen', tool: 'pen', held: true, sx: e.x, sy: e.y, points: [{ x: p.x, y: p.y }], draft, pointerId: e.pointerId };
  s.mode = 'freedraw';
  s.draft = draft;
  s.cursor = 'crosshair';
}

function eraserDown(s, e, p, ctx) {
  s.g = { kind: 'erase', tool: 'eraser', held: true, sx: e.x, sy: e.y, last: p, pointerId: e.pointerId };
  s.mode = 'erasing';
  s.erasingIds = new Set();
  s.eraserTrail = [{ x: p.x, y: p.y, at: ctx.now ?? 0 }];
  eraseAlong(s, p, p, e.altKey, ctx);
}

/* ------------------------------------------------------------------ *
 * pointermove
 * ------------------------------------------------------------------ */

function onPointerMove(s, e, ctx, fx) {
  s.lastPointer = e;
  const p = toBoard(e, ctx);
  const g = s.g;

  // A lost pointerup (released outside the window without capture): finish.
  if (g && g.held && e.buttons === 0 && e.pointerType === 'mouse') {
    onPointerUp(s, e, ctx, fx);
    return;
  }

  if (!g || g.kind === 'noop') {
    hover(s, p, ctx, fx);
    return;
  }

  switch (g.kind) {
    case 'pan': {
      const dx = e.x - g.lx;
      const dy = e.y - g.ly;
      g.lx = e.x;
      g.ly = e.y;
      if (dx || dy) fx.push({ type: 'panBy', dx, dy });
      break;
    }
    case 'marquee':
      marqueeMove(s, e, p, ctx, fx);
      break;
    case 'move':
      moveMove(s, e, p, ctx, fx);
      break;
    case 'resize':
      resizeMove(s, e, p, ctx, fx);
      break;
    case 'rotate':
      rotateMove(s, e, p, ctx, fx);
      break;
    case 'point':
      pointMove(s, e, p, ctx, fx);
      break;
    case 'box':
      boxMove(s, e, p, ctx);
      break;
    case 'linear':
      linearMove(s, e, p, ctx);
      break;
    case 'pen':
      penMove(s, p, ctx);
      break;
    case 'erase':
      eraseAlong(s, g.last, p, e.altKey, ctx);
      g.last = p;
      s.eraserTrail = [...(s.eraserTrail ?? []), { x: p.x, y: p.y, at: ctx.now ?? 0 }].slice(-ERASER_TRAIL_MAX);
      break;
    default:
      break;
  }
}

function hover(s, p, ctx, fx) {
  const zoom = zoomOf(ctx);
  let hovered = null;
  if (ctx.tool === 'select' && !ctx.spaceDown) {
    const hit = hitTest(ctx.elements, p, zoom, { skipLocked: true });
    hovered = hit ? hit.id : null;
    const lin = soleLinear(ctx);
    if (lin && s.linearEdit && s.linearEdit.id === lin.id) {
      const hi = hitLinearPoint(lin, p, zoom);
      if (hi !== s.linearEdit.hoverIndex) s.linearEdit = { ...s.linearEdit, hoverIndex: hi };
    }
  }
  if (hovered !== s.hoveredId) {
    s.hoveredId = hovered;
    fx.push({ type: 'setHovered', id: hovered });
  }
  // Arrow/line tools highlight what a new connector would bind to.
  if (LINEAR_TOOLS.includes(ctx.tool) && !ctx.spaceDown) {
    const t = findBindTarget(ctx.elements, p, zoom);
    if (t !== s.bindTarget) s.bindTarget = t;
  } else if (s.bindTarget) {
    s.bindTarget = null;
  }
  s.cursor = idleCursor(s, p, ctx);
}

function marqueeMove(s, e, p, ctx, fx) {
  const g = s.g;
  if (!g.started && screenDist(g, e) < DRAG_THRESHOLD) return;
  g.started = true;
  const r = rectFromDrag(g.start, p);
  s.marquee = r;
  const inside = elementsInMarquee(
    ctx.elements.filter((el) => !el.locked),
    r,
  );
  const ids = expandSelectionToGroups(ctx.elements, inside);
  const next = new Set([...g.base, ...ids]);
  if (!sameIdSet(next, ctx.selection)) fx.push({ type: 'select', ids: [...next] });
}

/** First real movement of an edit gesture: the one commit (and Alt-duplicate). */
function beginEdit(s, e, ctx, fx, kind) {
  const g = s.g;
  if (g.started) return true;
  if (screenDist(g, e) < DRAG_THRESHOLD) return false;
  g.started = true;
  g.label = nextGestureLabel(s, kind, ctx);
  fx.push({ type: 'commit', label: g.label });
  return true;
}

/** Patches for the gesture + the connectors that must follow, in one batch. */
function withBindings(ctx, patches, changedIds, extraElements = null) {
  let base = ctx.elements;
  if (extraElements && extraElements.length) {
    // Alt-duplicate: on the first frame the copies are not in the store yet.
    const have = new Set(ctx.elements.map((el) => el.id));
    const missing = extraElements.filter((x) => !have.has(x.id));
    if (missing.length) base = [...ctx.elements, ...missing];
  }
  const next = applyPatches(base, patches);
  return [...patches, ...resolveBindingPatches(next, changedIds)];
}

function moveMove(s, e, p, ctx, fx) {
  const g = s.g;
  if (!g.originals.length) return;
  if (!beginEdit(s, e, ctx, fx, 'move')) return;
  if (!g.duplicated && e.altKey && !g.dupChecked) {
    // Alt-drag duplicates: the copies (fresh ids, remapped bindings/groups)
    // are what moves, on top; the originals stay where they were.
    const clones = cloneElements(g.originals);
    if (clones.length) {
      fx.push({ type: 'addElements', elements: clones });
      fx.push({ type: 'select', ids: clones.map((el) => el.id) });
      g.originals = clones;
      g.clones = clones;
      g.duplicated = true;
    }
  }
  g.dupChecked = true;
  let dx = p.x - g.start.x;
  let dy = p.y - g.start.y;
  if (e.shiftKey) {
    if (Math.abs(dx) > Math.abs(dy)) dy = 0;
    else dx = 0;
  }
  if (snapOn(ctx) && g.bounds) {
    dx = snapValue(g.bounds.x + dx, ctx.gridSize) - g.bounds.x;
    dy = snapValue(g.bounds.y + dy, ctx.gridSize) - g.bounds.y;
  }
  const patches = moveElements(g.originals, dx, dy);
  fx.push({ type: 'updateElements', patches: withBindings(ctx, patches, g.originals.map((el) => el.id), g.clones) });
  s.cursor = 'move';
}

function resizeMove(s, e, p, ctx, fx) {
  const g = s.g;
  if (!beginEdit(s, e, ctx, fx, 'resize')) return;
  let q = { x: p.x - g.grab.x, y: p.y - g.grab.y };
  if (!g.frame.rotation) q = snapP(q, ctx);
  const patches = resizeElements(g.originals, g.frame, g.handle, q, { keepAspect: e.shiftKey, fromCenter: e.altKey });
  fx.push({ type: 'updateElements', patches: withBindings(ctx, patches, g.originals.map((el) => el.id)) });
}

function rotateMove(s, e, p, ctx, fx) {
  const g = s.g;
  if (!beginEdit(s, e, ctx, fx, 'rotate')) return;
  const patches = rotateElements(g.originals, g.frame, p, { snap15: e.shiftKey });
  fx.push({ type: 'updateElements', patches: withBindings(ctx, patches, g.originals.map((el) => el.id)) });
}

/** The patch for dragging point `g.index` of the connector to board point `p`. */
function pointPatch(g, e, p, ctx) {
  const el = g.original;
  const n = el.points.length;
  let np = snapP({ x: p.x - g.grab.x, y: p.y - g.grab.y }, ctx);
  if (e.shiftKey && n >= 2) {
    const anchor = g.index === 0 ? el.points[1] : el.points[g.index - 1];
    const d = constrainAngle(np.x - anchor.x, np.y - anchor.y, 15);
    np = { x: anchor.x + d.x, y: anchor.y + d.y };
  }
  const points = el.points.map((q) => ({ x: q.x, y: q.y }));
  points[g.index] = np;
  return { points };
}

function pointMove(s, e, p, ctx, fx) {
  const g = s.g;
  if (!beginEdit(s, e, ctx, fx, 'point')) return;
  const el = g.original;
  const n = el.points.length;
  const patch = pointPatch(g, e, p, ctx);
  const isStart = g.index === 0;
  const isEnd = g.index === n - 1;
  if (isStart || isEnd) {
    const key = isStart ? 'startId' : 'endId';
    const otherKey = isStart ? 'endId' : 'startId';
    // Unbind while dragging (rebound on release if over a shape), so neither
    // the server's resolve pass nor ours snaps the end back mid-drag.
    if (el[key]) patch[key] = null;
    const exclude = [el.id];
    if (n === 2 && el[otherKey]) exclude.push(el[otherKey]);
    s.bindTarget = findBindTarget(ctx.elements, p, zoomOf(ctx), exclude);
  }
  fx.push({ type: 'updateElements', patches: withBindings(ctx, [{ id: el.id, patch }], [el.id]) });
  s.linearEdit = { id: el.id, hoverIndex: g.index, activeIndex: g.index, editing: s.linearEdit?.editing ?? false };
}

function boxMove(s, e, p, ctx) {
  const g = s.g;
  if (!g.started && screenDist(g, e) < DRAG_THRESHOLD) return;
  g.started = true;
  const box = dragBox(g.start, snapP(p, ctx), { square: e.shiftKey, fromCenter: e.altKey });
  s.draft = { ...g.draft, ...box };
}

/** Where the floating end of a connector in progress goes for pointer `p`. */
function linearEndPoint(g, e, p, ctx) {
  let q = snapP(p, ctx);
  if (e.shiftKey) {
    const prev = g.points[g.points.length - 2];
    const d = constrainAngle(q.x - prev.x, q.y - prev.y, 15);
    q = { x: prev.x + d.x, y: prev.y + d.y };
  }
  return q;
}

/** The connector draft as it should look, with the bound start resolved live.
 *  Null while every point coincides (nothing to draw yet). */
function linearDraft(g, points) {
  const b0 = boundsOfPoints(points);
  if (b0.w === 0 && b0.h === 0) return null;
  const el = { ...g.draft, points, ...boundsOfPoints(points) };
  if (!g.startTarget) return el;
  const bound = { ...el, startId: g.startTarget.id };
  const [, out] = resolveConnectors([g.startTarget, bound]);
  const { startId, ...rest } = out; // the draft is not bound until it exists
  return rest;
}

function linearMove(s, e, p, ctx) {
  const g = s.g;
  if (g.phase === 'dragging') {
    if (!g.started && screenDist(g, e) < DRAG_THRESHOLD) return;
    g.started = true;
  }
  const end = linearEndPoint(g, e, p, ctx);
  g.points = [...g.points.slice(0, -1), end];
  const exclude = g.points.length === 2 && g.startTarget ? [g.startTarget.id] : [];
  s.bindTarget = findBindTarget(ctx.elements, p, zoomOf(ctx), exclude);
  s.draft = linearDraft(g, g.points);
}

function penMove(s, p, ctx) {
  const g = s.g;
  const last = g.points[g.points.length - 1];
  const min = FREEDRAW_MIN_SPACING / zoomOf(ctx);
  if (Math.hypot(p.x - last.x, p.y - last.y) < min) return;
  if (g.points.length >= LIMITS.MAX_POINTS) return;
  g.points = [...g.points, { x: p.x, y: p.y }];
  s.draft = { ...g.draft, points: g.points, ...boundsOfPoints(g.points) };
}

/** Mark (or, with Alt, unmark) everything the eraser passes over between a and b. */
function eraseAlong(s, a, b, restore, ctx) {
  const zoom = zoomOf(ctx);
  const step = Math.max(1e-6, 4 / zoom);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const n = Math.min(200, Math.max(1, Math.ceil(len / step)));
  const hits = new Set();
  const erasable = ctx.elements.filter((el) => !el.locked);
  for (let i = 0; i <= n; i++) {
    const t = n === 0 ? 1 : i / n;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    for (const el of hitTestAll(erasable, q, zoom)) hits.add(el.id);
  }
  if (hits.size === 0) return;
  const locked = new Set(ctx.elements.filter((el) => el.locked).map((el) => el.id));
  const ids = expandSelectionToGroups(ctx.elements, [...hits]).filter((id) => !locked.has(id));
  const next = new Set(s.erasingIds ?? []);
  let changed = false;
  for (const id of ids) {
    if (restore) {
      if (next.delete(id)) changed = true;
    } else if (!next.has(id)) {
      next.add(id);
      changed = true;
    }
  }
  if (changed) s.erasingIds = next;
}

/* ------------------------------------------------------------------ *
 * pointerup
 * ------------------------------------------------------------------ */

function onPointerUp(s, e, ctx, fx) {
  s.lastPointer = e;
  const p = toBoard(e, ctx);
  const g = s.g;
  if (!g) return;
  switch (g.kind) {
    case 'pan':
    case 'noop':
      endGesture(s);
      break;
    case 'marquee':
      endGesture(s);
      break;
    case 'move':
      if (!g.started) {
        if (g.deferToggle) {
          const drop = new Set(g.deferToggle);
          fx.push({ type: 'select', ids: [...ctx.selection].filter((id) => !drop.has(id)) });
        } else if (g.deferOnly) {
          fx.push({ type: 'select', ids: g.deferOnly });
        }
      }
      endGesture(s);
      break;
    case 'resize':
    case 'rotate':
      endGesture(s);
      break;
    case 'point':
      pointUp(s, e, p, ctx, fx);
      break;
    case 'box':
      boxUp(s, e, p, ctx, fx);
      break;
    case 'linear':
      if (g.phase === 'dragging') {
        if (g.started) {
          g.points = [...g.points.slice(0, -1), linearEndPoint(g, e, p, ctx)];
          finishLinear(s, ctx, fx, g.points, { endPointer: p });
        } else {
          // A click, not a drag: switch to click-click-click mode. The
          // second point follows the pointer until the next click.
          g.phase = 'clicking';
          g.held = false;
          s.draft = linearDraft(g, g.points);
        }
      } else {
        g.held = false;
      }
      break;
    case 'pen':
      penUp(s, p, ctx, fx);
      break;
    case 'text':
      textUp(s, g, ctx, fx);
      break;
    case 'image':
      fx.push({ type: 'requestImage', x: g.start.x, y: g.start.y });
      endGesture(s);
      break;
    case 'erase': {
      const ids = s.erasingIds ? [...s.erasingIds] : [];
      if (ids.length) {
        fx.push({ type: 'commit', label: nextGestureLabel(s, 'erase', ctx) });
        fx.push({ type: 'removeElements', ids });
      }
      endGesture(s);
      break;
    }
    default:
      endGesture(s);
  }
  if (!s.g) s.cursor = idleCursor(s, p, ctx);
}

function pointUp(s, e, p, ctx, fx) {
  const g = s.g;
  const el = g.original;
  const n = el.points.length;
  if (!g.started && g.insert) {
    // Ctrl/⌘-click on a segment without dragging: the new point stays where clicked.
    fx.push({ type: 'commit', label: nextGestureLabel(s, 'point', ctx) });
    fx.push({ type: 'updateElements', patches: withBindings(ctx, [{ id: el.id, patch: { points: el.points.map((q) => ({ x: q.x, y: q.y })) } }], [el.id]) });
  }
  if (g.started && (g.index === 0 || g.index === n - 1) && s.bindTarget) {
    // Released over a shape: bind that end, with its point resolved onto the outline.
    const key = g.index === 0 ? 'startId' : 'endId';
    const target = s.bindTarget;
    const patch = { ...pointPatch(g, e, p, ctx), [key]: target.id };
    const next = applyPatches(ctx.elements, [{ id: el.id, patch }]);
    const resolved = resolveConnectors(next).find((x) => x.id === el.id);
    if (resolved) patch.points = resolved.points.map((q) => ({ x: q.x, y: q.y }));
    fx.push({ type: 'updateElements', patches: [{ id: el.id, patch }] });
  }
  const editing = s.linearEdit?.editing ?? false;
  endGesture(s);
  s.linearEdit = { id: el.id, hoverIndex: g.index, activeIndex: g.index, editing };
}

function boxUp(s, e, p, ctx, fx) {
  const g = s.g;
  let box;
  const def = g.tool === 'sticky' ? STICKY_SIZE : DEFAULT_SHAPE_SIZE;
  if (!g.started) {
    // Click to place: the default size, centred on the pointer.
    const c = snapP(p, ctx);
    box = { x: c.x - def.w / 2, y: c.y - def.h / 2, w: def.w, h: def.h };
  } else {
    box = dragBox(g.start, snapP(p, ctx), { square: e.shiftKey, fromCenter: e.altKey });
    if (box.w < MIN_SHAPE_SIZE || box.h < MIN_SHAPE_SIZE) {
      const c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
      box = { x: c.x - def.w / 2, y: c.y - def.h / 2, w: def.w, h: def.h };
    }
  }
  const el = { ...g.draft, ...box };
  fx.push({ type: 'commit', label: nextGestureLabel(s, 'create', ctx) });
  fx.push({ type: 'addElements', elements: [el] });
  if (!ctx.toolLocked) {
    fx.push({ type: 'select', ids: [el.id] });
    fx.push({ type: 'setTool', tool: 'select' });
  }
  if (g.tool === 'sticky') fx.push({ type: 'startTextEdit', id: el.id });
  endGesture(s);
  s.swallowDblClick = true;
}

/** Click in click-click-click mode: add a point, or finish on the last one. */
function linearClick(s, e, p, ctx, fx) {
  const g = s.g;
  const zoom = zoomOf(ctx);
  const lastPlaced = g.points[g.points.length - 2];
  if (Math.hypot(p.x - lastPlaced.x, p.y - lastPlaced.y) <= (POINT_HANDLE_RADIUS * 2) / zoom) {
    finishLinear(s, ctx, fx, g.points.slice(0, -1));
    return;
  }
  const fixed = linearEndPoint(g, e, p, ctx);
  g.points = [...g.points.slice(0, -1), fixed, { x: fixed.x, y: fixed.y }];
  g.held = true;
  g.sx = e.x;
  g.sy = e.y;
  if (g.points.length >= LIMITS.MAX_POINTS) {
    finishLinear(s, ctx, fx, g.points.slice(0, -1));
    return;
  }
  s.draft = linearDraft(g, g.points);
}

/**
 * Turn the connector in progress into an element: bind its ends to the
 * shapes they sit on, resolve the bound ends onto the outlines with the
 * shared resolveConnectors, then commit + add. Fewer than 2 distinct points
 * is nothing at all (no element, no commit).
 */
function finishLinear(s, ctx, fx, rawPoints, { switchTool = true, endPointer = null } = {}) {
  const g = s.g;
  const points = rawPoints.map((q) => ({ x: q.x, y: q.y }));
  const b = boundsOfPoints(points);
  const zoom = zoomOf(ctx);
  if (points.length < 2 || (b.w < 1e-6 && b.h < 1e-6)) {
    endGesture(s);
    s.swallowDblClick = true;
    return;
  }
  const startTarget = g.startTarget;
  const last = endPointer ?? points[points.length - 1];
  const exclude = points.length === 2 && startTarget ? [startTarget.id] : [];
  const endTarget = findBindTarget(ctx.elements, last, zoom, exclude);
  const extra = { id: g.draft.id, seed: g.draft.seed };
  if (startTarget) extra.startId = startTarget.id;
  if (endTarget) extra.endId = endTarget.id;
  let el = createElement(g.tool, { points }, ctx.style, extra);
  const anchors = [startTarget, endTarget].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  if (anchors.length) {
    const resolved = resolveConnectors([...anchors, el]);
    el = resolved[resolved.length - 1];
  }
  fx.push({ type: 'commit', label: nextGestureLabel(s, 'create', ctx) });
  fx.push({ type: 'addElements', elements: [el] });
  if (switchTool && !ctx.toolLocked) {
    fx.push({ type: 'select', ids: [el.id] });
    fx.push({ type: 'setTool', tool: 'select' });
  }
  endGesture(s);
  s.swallowDblClick = true;
}

function penUp(s, p, ctx, fx) {
  const g = s.g;
  let points = g.points;
  const last = points[points.length - 1];
  if ((p.x !== last.x || p.y !== last.y) && points.length < LIMITS.MAX_POINTS) points = [...points, { x: p.x, y: p.y }];
  const el = createElement('pen', { points }, ctx.style, { id: g.draft.id, seed: g.draft.seed });
  fx.push({ type: 'commit', label: nextGestureLabel(s, 'create', ctx) });
  fx.push({ type: 'addElements', elements: [el] });
  endGesture(s);
}

function textUp(s, g, ctx, fx) {
  const hit = hitTest(ctx.elements, g.start, zoomOf(ctx), { skipLocked: true });
  endGesture(s);
  if (hit && (isText(hit) || isContainer(hit))) {
    fx.push({ type: 'startTextEdit', id: hit.id });
    return;
  }
  const el = newTextAt(g.start, ctx);
  fx.push({ type: 'startTextEdit', id: el.id, element: el });
}

/* ------------------------------------------------------------------ *
 * dblclick
 * ------------------------------------------------------------------ */

function onDoubleClick(s, e, ctx, fx) {
  if (s.swallowDblClick) {
    s.swallowDblClick = false;
    return;
  }
  const g = s.g;
  if (g && g.kind === 'linear') {
    finishLinear(s, ctx, fx, g.phase === 'clicking' ? g.points.slice(0, -1) : g.points);
    return;
  }
  if (ctx.tool !== 'select' || ctx.spaceDown) return;
  if (g && g.held) endGesture(s);
  const p = toBoard(e, ctx);
  const zoom = zoomOf(ctx);
  const hit = hitTest(ctx.elements, p, zoom, { skipLocked: true });

  if (!hit) {
    s.editingGroupId = null;
    const el = newTextAt(p, ctx);
    fx.push({ type: 'startTextEdit', id: el.id, element: el });
    return;
  }
  if (isText(hit) || isContainer(hit)) {
    if (!sameIdSet([hit.id], ctx.selection)) fx.push({ type: 'select', ids: [hit.id] });
    fx.push({ type: 'startTextEdit', id: hit.id });
    return;
  }
  if (isLinear(hit)) {
    linearDoubleClick(s, hit, p, ctx, fx);
    return;
  }
  // pen / image: step into a group first; otherwise write a new text here.
  const key = groupKeyOf(hit, ctx.elements);
  if (key && s.editingGroupId !== key) {
    s.editingGroupId = key;
    fx.push({ type: 'select', ids: [hit.id] });
    return;
  }
  const el = newTextAt(p, ctx);
  fx.push({ type: 'startTextEdit', id: el.id, element: el });
}

/**
 * Double-click on a connector enters point editing (its point handles are
 * shown whenever it is the only selection). While editing, a double-click on
 * an interior point removes it and one on a segment inserts a point there.
 */
function linearDoubleClick(s, el, p, ctx, fx) {
  const zoom = zoomOf(ctx);
  const editing = s.linearEdit && s.linearEdit.id === el.id && s.linearEdit.editing;
  if (!sameIdSet([el.id], ctx.selection)) fx.push({ type: 'select', ids: [el.id] });
  if (!editing) {
    s.linearEdit = { id: el.id, hoverIndex: -1, activeIndex: -1, editing: true };
    return;
  }
  const n = el.points.length;
  const idx = hitLinearPoint(el, p, zoom);
  let points = null;
  let active = -1;
  if (idx > 0 && idx < n - 1) {
    points = el.points.filter((_, i) => i !== idx).map((q) => ({ x: q.x, y: q.y }));
  } else if (idx < 0 && n < LIMITS.MAX_POINTS) {
    const seg = hitLinearSegment(el, p, zoom);
    if (seg >= 0) {
      points = el.points.map((q) => ({ x: q.x, y: q.y }));
      points.splice(seg + 1, 0, { x: p.x, y: p.y });
      active = seg + 1;
    }
  }
  if (points) {
    fx.push({ type: 'commit', label: nextGestureLabel(s, 'point', ctx) });
    fx.push({ type: 'updateElements', patches: withBindings(ctx, [{ id: el.id, patch: { points } }], [el.id]) });
  }
  s.linearEdit = { id: el.id, hoverIndex: active, activeIndex: active, editing: true };
}

/* ------------------------------------------------------------------ *
 * Keys and wheel
 * ------------------------------------------------------------------ */

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function onKey(s, e, ctx, fx) {
  const g = s.g;
  const down = e.type === 'keydown';
  if (down && (e.key === 'Escape' || e.key === 'Enter')) {
    if (g && g.kind === 'linear') {
      finishLinear(s, ctx, fx, g.phase === 'clicking' ? g.points.slice(0, -1) : g.points);
      return true;
    }
    if (g && g.held) return true; // mid-drag: swallow, do not let Escape clear the selection
    if (e.key === 'Escape' && s.linearEdit?.editing) {
      s.linearEdit = { ...s.linearEdit, editing: false, activeIndex: -1 };
      return true;
    }
    return false;
  }
  if (e.key === 'Shift' || e.key === 'Alt') {
    // A modifier changed mid-gesture: re-evaluate the gesture at the same
    // pointer position so Shift/Alt take effect without moving the mouse.
    if (g && s.lastPointer && (g.held || g.kind === 'linear')) {
      onPointerMove(s, { ...s.lastPointer, type: 'pointermove', shiftKey: e.shiftKey, altKey: e.altKey }, ctx, fx);
      return true;
    }
    return false;
  }
  if (ARROW_KEYS.has(e.key)) return Boolean(g && g.held);
  if (e.key === ' ') {
    if (!g) s.cursor = idleCursor(s, s.lastPointer ? toBoard(s.lastPointer, ctx) : null, ctx);
    return false;
  }
  return false;
}

const LINE_PX = 16;
const PAGE_PX = 400;
/** Largest wheel delta (px) one event may zoom by: a mouse notch is ~100, a pinch step ~1-10. */
const MAX_ZOOM_DELTA = 10;

function onWheel(s, e, ctx, fx) {
  const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? PAGE_PX : 1;
  const dx = (e.deltaX || 0) * unit;
  const dy = (e.deltaY || 0) * unit;
  if (e.mod) {
    // Ctrl/⌘+wheel, and trackpad pinch (the browser sets ctrlKey): zoom at the pointer.
    const d = Math.max(-MAX_ZOOM_DELTA, Math.min(MAX_ZOOM_DELTA, dy));
    if (d) fx.push({ type: 'zoomAt', x: e.x, y: e.y, factor: Math.exp(-d / 100) });
    return;
  }
  if (e.shiftKey) {
    const h = dy || dx;
    if (h) fx.push({ type: 'panBy', dx: -h, dy: 0 });
    return;
  }
  if (dx || dy) fx.push({ type: 'panBy', dx: -dx, dy: -dy });
}
