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
  pointInShape,
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
  rebindMovedConnectors,
} from './scene.js';

/** Modes during which a pointer button is held and owns the gesture. */
const HELD_MODES = new Set(['panning', 'marquee', 'moving', 'resizing', 'rotating', 'creating', 'freedraw', 'editingPoint', 'erasing']);

/**
 * The second press of a double-click lands within this time (ms) and
 * distance (CSS px) of the first — the usual OS defaults, a bit generous.
 */
const DOUBLE_CLICK_MS = 500;
const DOUBLE_CLICK_SLOP = 16;

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
    swallowAt: null, // {x, y, at}: screen point and time of that finishing click
    clearedByClick: null, // {ids, groupId, x, y, at}: the selection a click in its empty frame just cleared
    lastPointer: null, // last pointer event, to re-evaluate a gesture when Shift/Alt change
    toolSeen: null, // the tool as of the last event (a change ends the old tool's gesture)
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

/**
 * Does a LONE selected connector show the transform box (frame, resize and
 * rotation handles) on top of its point handles? Only with more than two
 * points, and not while its points are being edited — Excalidraw's
 * shouldShowBoundingBox. A 2-point connector's box handles would only
 * duplicate its two point handles.
 */
export function linearShowsBox(el, linearEdit = null) {
  if (!isLinear(el) || !Array.isArray(el.points) || el.points.length <= 2) return false;
  return !(linearEdit && linearEdit.id === el.id && linearEdit.editing);
}

/** Handle options for a selection — must match what the renderer draws. */
function handleOpts(selected) {
  // A lone connector only has box handles when linearShowsBox, and then it
  // turns like a multi-selection: the turn is baked into its points.
  return { rotatable: selected.length !== 1 || isRotatable(selected[0]) || isLinear(selected[0]) };
}

/**
 * Does this selection show box transform handles? Not with locked members,
 * and for a lone connector only when linearShowsBox (`s` is the reducer
 * state, for its point-editing flag).
 */
function hasBoxHandles(selected, s) {
  if (selected.length === 0) return false;
  if (selected.some((el) => el.locked)) return false;
  if (selected.length === 1 && isLinear(selected[0])) return linearShowsBox(selected[0], s?.linearEdit);
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

/**
 * How close (board units) to the centre of a transparent container a text
 * gesture over its empty middle must land to write the container's label:
 * Excalidraw's TEXT_TO_CENTER_SNAP_THRESHOLD (labelContainerAt widens it to a
 * quarter of the shape's smaller side, so a big shape is a big target).
 */
const LABEL_SNAP_DISTANCE = 30;

/**
 * The container a text gesture at `p` writes into when nothing was hit
 * directly — the pointer is over the empty middle of a transparent shape,
 * which is not ink (hitTest misses it) but is still where the user expects
 * the shape's label to go (Excalidraw's getTextBindableContainerAtPosition):
 *  1. the single selected container, anywhere inside its selection frame
 *     (the hint line promises "double-click to edit the text");
 *  2. otherwise the topmost container whose inside holds `p`, near enough to
 *     its centre (LABEL_SNAP_DISTANCE, or a quarter of its smaller side) —
 *     farther out, a big transparent frame keeps taking free text.
 * Locked and invisible shapes are never written into.
 */
function labelContainerAt(ctx, p) {
  const zoom = zoomOf(ctx);
  const selected = selectedElements(ctx);
  if (selected.length === 1) {
    const el = selected[0];
    if (isContainer(el) && !el.locked && el.opacity !== 0 && pointInFrame(selectionFrame(selected, zoom), p)) return el;
  }
  for (let i = ctx.elements.length - 1; i >= 0; i--) {
    const el = ctx.elements[i];
    if (!isContainer(el) || el.locked || el.opacity === 0) continue;
    if (!pointInShape(el, p)) continue;
    const reach = Math.max(LABEL_SNAP_DISTANCE, Math.min(el.w, el.h) / 4);
    if (Math.hypot(p.x - (el.x + el.w / 2), p.y - (el.y + el.h / 2)) <= reach) return el;
  }
  return null;
}

/**
 * Is `e` from a pointer other than the one holding the active gesture (a
 * palm or finger touching down while a pen or mouse drags)? Such a pointer
 * must neither feed the gesture its moves nor end it with its pointerup or
 * pointercancel. Events without a pointerId (synthetic ones) are the owner's.
 */
function isStrayPointer(s, e) {
  const g = s.g;
  return Boolean(g && g.held && e.pointerId !== undefined && g.pointerId !== undefined && e.pointerId !== g.pointerId);
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
  if (hasBoxHandles(selected, s)) {
    const frame = selectionFrame(selected, zoom);
    const key = hitHandle(frame, p, zoom, handleOpts(selected));
    if (key) return cursorForHandle(key, frame.rotation);
  }
  const hit = hitTest(ctx.elements, p, zoom, { skipLocked: true });
  if (hit) return 'move';
  if (grabsSelection(selected, p, zoom, s)) return 'move';
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

  // The tool changed since the last event this reducer saw (toolbar,
  // shortcut, a text edit that committed and returned to select): finish or
  // drop the old tool's gesture before anything else. Keyed on the tool the
  // reducer last SAW rather than on the Canvas' deferred 'toolchange'
  // notification: when a click on the board commits a text edit (tool text ->
  // select) and then starts a drag, the pointerdown already sees 'select' and
  // the late notification must not cancel the drag it just started.
  const toolChanged = s.toolSeen !== null && s.toolSeen !== undefined && s.toolSeen !== c.tool;
  s.toolSeen = c.tool;
  if (toolChanged) {
    if (s.g) abortGesture(s, c, fx, { finalize: true });
    s.bindTarget = null;
    s.editingGroupId = null;
    if (!s.g) s.cursor = idleCursor(s, s.lastPointer ? toBoard(s.lastPointer, c) : null, c);
  } else if (s.g && s.g.tool && s.g.tool !== c.tool) {
    // A gesture that belongs to another tool (state from before toolSeen).
    abortGesture(s, c, fx, { finalize: true });
  }

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
      if (isStrayPointer(s, event)) break;
      if (s.g && (s.g.held || HELD_MODES.has(s.mode))) abortGesture(s, c, fx, { finalize: false });
      break;
    case 'blur':
      if (s.g) abortGesture(s, c, fx, { finalize: true });
      s.cursor = idleCursor(s, null, { ...c, spaceDown: false });
      break;
    case 'toolchange':
      // Only a wake-up so the change is seen without waiting for the next
      // pointer event: the change itself was handled above (toolSeen).
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
  if (g.kind === 'pan' && g.resume) {
    // A pan in the middle of a multi-point connector: the pan ends and the
    // connector is back — then finished (finalize) or left to go on.
    resumeAfterPan(s, g);
    if (finalize) abortGesture(s, ctx, fx, { finalize });
    return;
  }
  if (g.kind === 'linear' && finalize && g.phase === 'clicking') {
    finishLinear(s, ctx, fx, g.points.slice(0, -1), { switchTool: false });
    return;
  }
  // Everything else: drafts are dropped; edits already written stay (a point
  // drag that unbound its end at the first movement leaves it unbound).
  endGesture(s);
}

/** A pan started over a multi-point connector ended: the connector goes on. */
function resumeAfterPan(s, g) {
  s.g = g.resume;
  s.mode = 'linear';
  s.cursor = 'crosshair';
}

/** Start a pan (hand tool, Space+drag, middle button). `resume`: the gesture to go back to after it. */
function startPan(s, e, resume = null) {
  s.g = { kind: 'pan', held: true, sx: e.x, sy: e.y, lx: e.x, ly: e.y, pointerId: e.pointerId, resume };
  s.mode = 'panning';
  s.cursor = 'grabbing';
}

/**
 * Is this press the second one of a double-click whose first click finished
 * a creation (s.swallowAt)? Then the dblclick that follows it is swallowed.
 */
function pairsWithSwallowedClick(s, e, ctx) {
  const a = s.swallowAt;
  if (!a || typeof e.x !== 'number') return false;
  const dt = (ctx.now ?? 0) - a.at;
  return dt >= 0 && dt <= DOUBLE_CLICK_MS && Math.hypot(e.x - a.x, e.y - a.y) <= DOUBLE_CLICK_SLOP;
}

/**
 * The selection the first click of this double-click cleared (a click in the
 * empty part of the selection frame deselects, see selectDown step 4), or
 * null. Consumed: only the double-click of that very click pair sees it.
 */
function takeClearedSelection(s, e, ctx) {
  const c = s.clearedByClick;
  s.clearedByClick = null;
  if (!c || typeof e.x !== 'number') return null;
  const dt = (ctx.now ?? 0) - c.at;
  if (dt < 0 || dt > DOUBLE_CLICK_MS || Math.hypot(e.x - c.x, e.y - c.y) > DOUBLE_CLICK_SLOP) return null;
  const alive = new Set(ctx.elements.map((el) => el.id));
  const ids = c.ids.filter((id) => alive.has(id));
  return ids.length ? { ids, groupId: c.groupId } : null;
}

/** A creation just finished: the dblclick its click pair may produce must not act. */
function armDblClickSwallow(s, ctx) {
  s.swallowDblClick = true;
  const lp = s.lastPointer;
  s.swallowAt = lp && typeof lp.x === 'number' ? { x: lp.x, y: lp.y, at: ctx.now ?? 0 } : null;
}

/* ------------------------------------------------------------------ *
 * pointerdown
 * ------------------------------------------------------------------ */

function onPointerDown(s, e, ctx, fx) {
  // Another pointer pressing while a gesture is held (a palm or finger during
  // a pen or mouse drag) is ignored, including by a multi-point connector.
  if (isStrayPointer(s, e)) return;
  s.lastPointer = e;
  const p = toBoard(e, ctx);

  // A multi-point connector in progress owns every click until it finishes;
  // a right click finishes it. Space+drag and the middle button pan the view
  // WITHOUT ending it (like the wheel): the connector resumes on release.
  if (s.g && s.g.kind === 'linear' && s.g.phase === 'clicking') {
    if (e.button === 2) {
      finishLinear(s, ctx, fx, s.g.points.slice(0, -1));
      return;
    }
    if (e.button === 0 && !ctx.spaceDown) {
      linearClick(s, e, p, ctx, fx);
      return;
    }
    if (!s.g.held && (e.button === 1 || (e.button === 0 && ctx.spaceDown))) {
      s.swallowDblClick = false;
      startPan(s, e, s.g);
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
  // The second press of the double-click whose first click finished a
  // creation keeps the swallow armed (its dblclick is part of that click
  // pair); any other press disarms it.
  if (s.swallowDblClick && pairsWithSwallowedClick(s, e, ctx)) s.swallowAt = null;
  else {
    s.swallowDblClick = false;
    s.swallowAt = null;
  }

  // The right button starts nothing: the menu opens on the `contextmenu`
  // event (right click, Ctrl+click on macOS) or on the Canvas' touch
  // long-press timer.
  if (e.button === 2) return;
  if (e.button === 1 || ctx.tool === 'hand' || (ctx.spaceDown && e.button === 0)) {
    startPan(s, e);
    return;
  }
  if (e.button !== 0 && e.button !== undefined) return;

  const tool = ctx.tool;
  if (tool === 'select') selectDown(s, e, p, ctx, fx);
  else if (BOX_TOOLS.includes(tool)) boxDown(s, e, p, ctx);
  else if (LINEAR_TOOLS.includes(tool)) linearDown(s, e, p, ctx);
  else if (tool === 'pen') penDown(s, e, p, ctx);
  else if (tool === 'text') {
    s.g = { kind: 'text', tool, held: true, sx: e.x, sy: e.y, start: p, alt: Boolean(e.altKey), pointerId: e.pointerId };
    s.mode = 'creating';
  } else if (tool === 'eraser') eraserDown(s, e, p, ctx);
  else if (tool === 'image') {
    s.g = { kind: 'image', tool, held: true, sx: e.x, sy: e.y, start: p, pointerId: e.pointerId };
    s.mode = 'creating';
  }
}

function contextMenu(s, e, p, ctx, fx) {
  const zoom = zoomOf(ctx);
  const hit = hitTest(ctx.elements, p, zoom, { skipLocked: true }) ?? hitTest(ctx.elements, p, zoom);
  // Inside the current selection frame (the empty middle of a selected
  // transparent shape, the gap of a marquee or Ctrl+A selection) the menu is
  // about the SELECTION, exactly as a left press there grabs it — Excalidraw
  // counts the common bounding box of the selection the same way.
  const selected = selectedElements(ctx);
  const inSelection = selected.length > 0 && pointInFrame(selectionFrame(selected, zoom), p);
  let targetId = null;
  if (hit && (ctx.selection.has(hit.id) || !inSelection)) {
    if (!ctx.selection.has(hit.id)) fx.push({ type: 'select', ids: expandSelectionToGroups(ctx.elements, [hit.id]) });
    targetId = hit.id;
  } else if (inSelection) {
    targetId = selected[selected.length - 1].id;
  } else if (ctx.selection.size) {
    fx.push({ type: 'select', ids: [] });
  }
  fx.push({ type: 'contextMenu', x: e.x, y: e.y, targetId });
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
  if (hasBoxHandles(selected, s)) {
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
    } else if (grabsSelection(selected, p, zoom, s)) {
      // An unselected element INSIDE the selection frame (a shape inside a
      // selected container, one in the gap of a multi-selection): the press
      // grabs the selection, so a drag moves the selection, not the element
      // under the pointer; a click without a drag selects that element on
      // release (Excalidraw's hasHitCommonBoundingBoxOfSelectedElements).
      next = new Set(ctx.selection);
      deferOnly = groupIds;
    } else {
      next = new Set(groupIds);
    }
    if (!sameIdSet(next, ctx.selection)) fx.push({ type: 'select', ids: [...next] });
    startMove(s, base, els.filter((el) => next.has(el.id)), { deferToggle, deferOnly });
    return;
  }

  // 4. Inside the current selection frame, over no element: grab the
  //    selection, so a drag moves it (a selected transparent shape can be
  //    dragged by its empty middle) — and a click without a drag clears it
  //    on release (Excalidraw's handleCanvasPointerUp: no drag, the common
  //    bounding box hit but no element).
  if (!e.shiftKey && grabsSelection(selected, p, zoom, s)) {
    startMove(s, base, selected, { deferClear: true });
    return;
  }

  // 5. A locked element, only when nothing else is under the pointer: select
  //    it — with its whole group, like any click, so unlocking it unlocks the
  //    group and the group never ends up half locked — and never move it.
  const lockedHit = hitTest(els, p, zoom);
  if (lockedHit && lockedHit.locked) {
    s.editingGroupId = null;
    const ids = expandSelectionToGroups(els, [lockedHit.id]);
    if (e.shiftKey) {
      const next = new Set(ctx.selection);
      if (ids.every((id) => next.has(id))) for (const id of ids) next.delete(id);
      else for (const id of ids) next.add(id);
      fx.push({ type: 'select', ids: [...next] });
    } else if (!sameIdSet(ids, ctx.selection)) {
      fx.push({ type: 'select', ids });
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

/**
 * Does a press at `p` grab the current selection (rather than what is under
 * it, or the empty canvas)? Yes when `p` is inside the selection frame of a
 * selection that can move — but not for a lone connector that shows no
 * transform box (linearShowsBox): its frame is not drawn, it is just the box
 * around its line (Excalidraw hit-tests such a linear element by its stroke).
 */
function grabsSelection(selected, p, zoom, s) {
  if (selected.length === 0 || !selected.some((el) => !el.locked)) return false;
  if (selected.length === 1 && isLinear(selected[0]) && !linearShowsBox(selected[0], s?.linearEdit)) return false;
  return pointInFrame(selectionFrame(selected, zoom), p);
}

/**
 * Start a move of `targets`. What a click (no drag) does on release instead:
 * `deferToggle` drops those ids from the selection (Shift-click on a selected
 * element), `deferOnly` narrows the selection to those ids, `deferClear`
 * clears it (a click in the empty part of the selection frame).
 */
function startMove(s, base, targets, { deferToggle = null, deferOnly = null, deferClear = false }) {
  const originals = targets.filter((el) => !el.locked);
  s.g = {
    ...base,
    kind: 'move',
    originals,
    bounds: originals.length ? commonBounds(originals) : null,
    deferToggle,
    deferOnly,
    deferClear,
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
  // A second pointer (palm, finger) never steers someone else's drag.
  if (isStrayPointer(s, e)) return;
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
  if (isStrayPointer(s, e)) return;
  s.lastPointer = e;
  const p = toBoard(e, ctx);
  const g = s.g;
  if (!g) return;
  switch (g.kind) {
    case 'pan':
      if (g.resume) resumeAfterPan(s, g);
      else endGesture(s);
      break;
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
        } else if (g.deferClear) {
          // Remembered for a double-click this click may start: it is about
          // the selection this click just cleared (see onDoubleClick).
          s.clearedByClick = { ids: [...ctx.selection], groupId: s.editingGroupId, x: e.x, y: e.y, at: ctx.now ?? 0 };
          s.editingGroupId = null;
          if (ctx.selection.size) fx.push({ type: 'select', ids: [] });
        }
      } else {
        // A connector dragged by its shaft came unbound while moving (so its
        // ends could follow the pointer). An end still close to the shape it
        // was bound to keeps that binding (Excalidraw), snapped back onto the
        // outline — part of the same undo step, no new commit.
        const rebind = rebindMovedConnectors(g.originals, ctx.elements, zoomOf(ctx));
        if (rebind.length) fx.push({ type: 'updateElements', patches: rebind });
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
    // Only a drag that ended (nearly) where it began — tiny in BOTH
    // directions, on screen — is really a click: it gets the default size.
    // A thin one (a 400×3 divider) is kept exactly as its draft showed it
    // (Excalidraw drops only a shape that is 0 in both directions).
    const min = MIN_SHAPE_SIZE / zoomOf(ctx);
    if (box.w < min && box.h < min) {
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
  armDblClickSwallow(s, ctx);
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
  g.pointerId = e.pointerId; // each tap of a touch is a new pointer
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
    armDblClickSwallow(s, ctx);
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
  armDblClickSwallow(s, ctx);
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

/**
 * Text tool click: edit the text under the pointer, or the label of the
 * container under it — also through the empty middle of a transparent shape
 * (labelContainerAt) — or start a new free text there. Alt+click always
 * starts a free text over a container (Excalidraw).
 */
function textUp(s, g, ctx, fx) {
  const hit = hitTest(ctx.elements, g.start, zoomOf(ctx), { skipLocked: true });
  endGesture(s);
  const target = hit ?? (g.alt ? null : labelContainerAt(ctx, g.start));
  if (target && (isText(target) || (isContainer(target) && !g.alt))) {
    fx.push({ type: 'startTextEdit', id: target.id });
    return;
  }
  const el = newTextAt(g.start, ctx);
  fx.push({ type: 'startTextEdit', id: el.id, element: el });
}

/* ------------------------------------------------------------------ *
 * dblclick
 * ------------------------------------------------------------------ */

function onDoubleClick(s, e, ctx, fx) {
  const cleared = takeClearedSelection(s, e, ctx);
  if (s.swallowDblClick) {
    s.swallowDblClick = false;
    s.swallowAt = null;
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
  // The first click of this double-click landed in the empty middle of the
  // selection frame and cleared the selection: the double-click is still
  // about that selection (a selected container's label is edited from
  // anywhere inside its frame, inside the group that was entered).
  let about = ctx;
  if (!hit && cleared) {
    about = { ...ctx, selection: new Set(cleared.ids) };
    s.editingGroupId = cleared.groupId ?? null;
  }
  // What the double-click is about: the element under the pointer or, over
  // the empty middle of a transparent shape, that container (its label).
  // Alt+double-click writes a free text even over a container (Excalidraw).
  const target = hit ?? (e.altKey ? null : labelContainerAt(about, p));

  if (!target) {
    s.editingGroupId = null;
    const el = newTextAt(p, ctx);
    fx.push({ type: 'startTextEdit', id: el.id, element: el });
    return;
  }
  // A member of a group that is not entered yet: the double-click steps into
  // the group (only this member selected) and does nothing else; the next
  // double-click edits the member (Excalidraw's handleCanvasDoubleClick).
  const key = groupKeyOf(target, ctx.elements);
  if (key && s.editingGroupId !== key) {
    s.editingGroupId = key;
    if (!sameIdSet([target.id], ctx.selection)) fx.push({ type: 'select', ids: [target.id] });
    return;
  }
  if (isText(target) || (isContainer(target) && !e.altKey)) {
    if (!sameIdSet([target.id], ctx.selection)) fx.push({ type: 'select', ids: [target.id] });
    fx.push({ type: 'startTextEdit', id: target.id });
    return;
  }
  if (isLinear(target)) {
    linearDoubleClick(s, target, p, ctx, fx);
    return;
  }
  // pen / image (or Alt over a container): write a new text here.
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

/**
 * Delete/Backspace while a connector is in point editing (Excalidraw's line
 * editor): the active point goes — one undo step, bindings re-resolved, an
 * end that goes loses its binding — as long as 2 points remain. With no
 * active point the key does nothing: deleting the whole connector there is
 * almost always a miss for "delete this point" (Excalidraw does the same).
 * Returns false when not point editing, so the global Delete runs.
 */
function deleteActivePoint(s, ctx, fx) {
  const le = s.linearEdit;
  if (!le || !le.editing) return false;
  const el = soleLinear(ctx);
  if (!el || el.id !== le.id) return false;
  const n = el.points.length;
  const idx = le.activeIndex ?? -1;
  if (idx < 0 || idx >= n || n <= 2) return true;
  const patch = { points: el.points.filter((_, i) => i !== idx).map((q) => ({ x: q.x, y: q.y })) };
  if (idx === 0 && el.startId) patch.startId = null;
  if (idx === n - 1 && el.endId) patch.endId = null;
  fx.push({ type: 'commit', label: nextGestureLabel(s, 'point', ctx) });
  fx.push({ type: 'updateElements', patches: withBindings(ctx, [{ id: el.id, patch }], [el.id]) });
  s.linearEdit = { ...le, hoverIndex: -1, activeIndex: -1 };
  return true;
}

/** Undo/redo chords (Mod+Z, Mod+Shift+Z, Mod+Y). */
const isUndoRedoKey = (e) => Boolean(e.mod) && /^[zy]$/i.test(e.key ?? '');

function onKey(s, e, ctx, fx) {
  const g = s.g;
  const down = e.type === 'keydown';
  // Undo/redo while a button holds a gesture (a move, a resize, a pen
  // stroke…) would rewind the store under it: the gesture keeps writing from
  // its originals without a new commit, merges into the previous undo step
  // and leaves a stale redo entry. Swallowed until the button is released.
  if (isUndoRedoKey(e)) return down && Boolean(g && g.held);
  if (down && (e.key === 'Delete' || e.key === 'Backspace')) {
    if (g && g.held) return true; // mid-drag: never delete what is being dragged
    if (g) return false;
    return deleteActivePoint(s, ctx, fx);
  }
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
