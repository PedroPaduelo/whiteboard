/**
 * `useDropOnCanvas` — the canvas end of the preset drop.
 *
 * The classic bug lives in this file, so it is stated plainly: the drop
 * coordinate must be converted from SCREEN pixels to BOARD units with the
 * store's `view`. Dropping into the flow layer's coordinate space, or into the
 * canvas element's offset-adjusted space, or forgetting the pan, puts every
 * element 200px off from where the user let go. `dropGeometry.js` does the
 * maths; this hook does the wiring.
 *
 * Placement goes STRAIGHT to the two documented store actions — `commit(label)`
 * then `addElements(elements)` — and to nothing else. The old code dispatched a
 * `drop` EFFECT to whichever of `dispatchEffect` / `dispatch` the store happened
 * to expose. The reducer that owned that effect was deleted in the React Flow
 * rewrite, so NEITHER name existed: every click on a palette item built the
 * elements, handed them to `undefined`, and the click handler died on a
 * TypeError. That indirection is gone, on purpose. `commit` + `addElements` is
 * the contract, it is what undo and the realtime diff bridge already understand,
 * and it is ONE history entry for a multi-element preset.
 *
 * ## Why the handle is published on the module
 *
 * Two components legitimately need this hook: `PresetPalette`, for its
 * click-to-place button, and the canvas host, for the element. They must
 * therefore SHARE one instance — two would mean two `useDroppable` instances
 * under the same id `canvas`, and dnd-kit's container map lets the second
 * overwrite the first, so the canvas would quietly stop being droppable.
 *
 * So the mounted instance is published in a module singleton and both call
 * sites read the SAME object: one drop handler, and the click path and the drag
 * path provably agree because they are literally the same function. Only the
 * canvas host registers the droppable proper (`register: true`); the palette
 * only reads. See the `useDroppable` call for why that distinction is load-
 * bearing rather than tidiness.
 */

import { useCallback, useEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { useBoardStore, useShallowSelector, useSelector } from '../flow/useStore.js';
import {
  buildDroppedElements,
  CANVAS_DROPPABLE_ID,
  viewportCentreToBoard,
} from './dropGeometry.js';

export const selectView = (s) => s.view;
export const selectStyle = (s) => s.style;
export const selectGridSize = (s) => s.gridSize;
export const selectSnapEnabled = (s) => s.snapEnabled;

/**
 * The default drop box, in BOARD units, for a preset that declares no size of
 * its own. This is not cosmetic, it is the bug.
 *
 * `preset.build(box, style)` reads `box.x`, `box.y`, `box.w` AND `box.h`, and
 * `buildDroppedElements` only ever supplies `{ w, h }` — it centres the finished
 * group on the drop point itself, so the box's ORIGIN is meaningless by
 * construction. The old call passed no `size` at all, so `build(undefined, …)`
 * made every one of the 14 presets in `store/presets.js` throw a TypeError on
 * its first `b.x` read. Nothing was ever built, which is the whole of the
 * "I click the item and nothing lands" symptom. `buildPreset` in the store uses
 * this same 160x100 footprint.
 */
const DEFAULT_DROP_SIZE = { w: 160, h: 100 };

/**
 * Presets are authored in BOX-LOCAL coordinates, so their `build` reads
 * `box.x`/`box.y` for the shape's own origin. `buildDroppedElements` builds a
 * `{w,h}`-only box (placement is its job, at the end, by centring the finished
 * group on the drop point), so a preset handed that box raw reads `undefined`
 * for its origin — and for a CONNECTOR, whose box is derived from its two
 * endpoints, that silently produces `NaN` endpoints and an arrow of zero length.
 *
 * This wrapper supplies the origin the preset is authored against — (0, 0) —
 * and lets the caller's width/height through. The result is then translated
 * onto the drop point exactly once, by `centerElementsAt`, which moves a
 * connector's `points` in lockstep with its box so the arrow stays attached to
 * what it spans.
 *
 * @param {{id:string, build:Function}} preset
 * @returns {object} a preset whose `build` tolerates a `{w,h}`-only box
 */
function withBoxOrigin(preset) {
  return {
    ...preset,
    build: (box, style) => preset.build({ x: 0, y: 0, ...(box ?? {}) }, style),
  };
}

/**
 * The live instance, or null before it mounts. Written by the hook, read by
 * `getCanvasDrop()` — the palette and App.jsx both need the drop handler, and
 * only ONE of them may register the droppable.
 * @type {null | { setNodeRef: Function, isOver: boolean, onDrop: Function, onDropAtCentre: Function, droppableId: string }}
 */
let instance = null;

/** The element the droppable is attached to, for the drag-end measurement. */
let canvasNode = null;

/**
 * The viewport size of the canvas, in CSS px, kept current by whichever
 * instance owns the node.
 *
 * It is module state rather than a per-instance ref because the instance that
 * OWNS the node is not the instance that SERVES the click: the palette calls
 * this hook for its `onDropAtCentre` and never attaches a node, so its own
 * measurement is 0x0 forever. If each instance measured only its own ref, the
 * palette's click-to-place would resolve "centre of the viewport" to (0,0) —
 * board origin — and every click would pile elements into the top-left corner
 * instead of the middle of the screen. Sharing the measurement is what makes
 * the click land where the user is looking.
 */
let canvasSize = { width: 0, height: 0 };

/** A no-op-shaped handle, so a caller that runs before mount cannot crash. */
const NO_DROP = {
  setNodeRef: () => {},
  isOver: false,
  onDrop: () => null,
  onDropAtCentre: () => null,
  droppableId: CANVAS_DROPPABLE_ID,
};

/**
 * The shared canvas drop handle, read imperatively.
 *
 * This is deliberately NOT a hook. `<DndProvider>` renders BEFORE the canvas
 * host that owns the droppable, so a hook reading the singleton at render time
 * would capture the no-op permanently and every released drag would silently do
 * nothing. A plain getter, called at DROP time, always sees the live handle
 * however late it mounted.
 *
 * @returns {{
 *   setNodeRef: (el: HTMLElement|null)=>void,
 *   isOver: boolean,
 *   onDrop: (preset: object, screenPoint?: {x:number,y:number}) => any[]|null,
 *   onDropAtCentre: (preset: object) => any[]|null,
 *   droppableId: string,
 * }}
 */
export function getCanvasDrop() {
  return instance ?? NO_DROP;
}

/**
 * `getCanvasDrop()` under a hook-shaped name, for render-time consumers that
 * prefer the `use*` spelling. It subscribes to nothing, so it never re-renders
 * on its own — which is right: the handle changes identity only when the view or
 * the style changes, and both of those already re-render every consumer of the
 * underlying selectors.
 */
export function useCanvasDrop() {
  return getCanvasDrop();
}

/**
 * @param {Object} [opts]
 * @param {React.RefObject<HTMLElement>} [opts.ref] the canvas container to
 *   register as the droppable. Omit to get the callback only.
 * @param {boolean} [opts.register] set by EXACTLY ONE caller — the canvas host
 *   that owns the element. It is the only one that puts the droppable into
 *   dnd-kit's container map; every other caller (the preset palette) reads the
 *   shared handle without registering, so `canvas` always resolves to the real
 *   element. See the note at the `useDroppable` call.
 * @param {(w:number,h:number)=>void} [opts.onSize] viewport size in CSS px,
 *   needed to resolve "centre of the viewport" for click and keyboard drops.
 * @returns {{
 *   setNodeRef: (el: HTMLElement|null)=>void,
 *   isOver: boolean,
 *   onDrop: (preset: object, screenPoint?: {x:number,y:number}) => any[]|null,
 *   onDropAtCentre: (preset: object) => any[]|null,
 *   droppableId: string,
 * }}
 */
export function useDropOnCanvas({ ref, onSize, register = false } = {}) {
  // dnd-kit keys droppables by id in a Map and `RegisterDroppable` does
  // `containers.set(id, element)`, so a SECOND instance of this hook
  // OVERWRITES the first under the id `canvas`. Two components legitimately need
  // this hook: `PresetPalette` (for its click-to-place) and the canvas host
  // (for the node). `PresetPalette` never attaches a node, so whichever
  // registered last used to leave `canvas` pointing at `null` — no measurable
  // rect, no collision, and dragging a preset onto the board silently did
  // nothing while clicking it worked. That is the whole "click works, drag
  // doesn't" split.
  //
  // The fix is `register`. Exactly ONE caller — the canvas host, which owns the
  // element — asks to register; everyone else (the palette) only reads the
  // shared handle. So there is one entry in the map, it is never null, and
  // mount order, StrictMode's remount and the palette mounting later are all
  // irrelevant. Note `useDroppable` destructures only `disabled` (there is no
  // `isDisabled` option in dnd-kit 6), so the "am I the registrar" test has to
  // be a real `disabled` VALUE; passing an unsupported `isDisabled` prop is
  // silently ignored and reintroduces the exact bug this guards against.
  const { setNodeRef: setDropRef, isOver } = useDroppable({
    id: CANVAS_DROPPABLE_ID,
    disabled: !register,
  });

  const view = useShallowSelector(selectView);
  const style = useShallowSelector(selectStyle);
  const gridSize = useSelector(selectGridSize);
  const snapEnabled = useSelector(selectSnapEnabled);

  // The node is published on the module (see `canvasNode`) rather than in a
  // per-instance ref: the instance that OWNS the element is not the instance
  // that SERVES the click, and each would otherwise measure a different (or no)
  // box. `canvasNode` is only ever assigned a real element, never nulled while
  // one is attached, so a `setNodeRef(null)` from a tearing-down registrar
  // cannot leave a live canvas looking absent.
  const setNodeRef = useCallback(
    (el) => {
      if (el) canvasNode = el;
      setDropRef(el);
      if (ref) {
        if (typeof ref === 'function') ref(el);
        else ref.current = el;
      }
    },
    [ref, setDropRef],
  );

  // A non-registering caller still needs the live node and its size — that is
  // what turns a click into "the centre of the viewport" — but it must not push
  // that node into dnd-kit, which is the registrar's job alone.
  useEffect(() => {
    const el = canvasNode;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const apply = () => {
      const r = el.getBoundingClientRect();
      canvasSize = { width: r.width, height: r.height };
      onSize?.(r.width, r.height);
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    window.addEventListener('resize', apply);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', apply);
    };
  }, [onSize]);

  /**
   * The drop, end to end. The click path (`onDropAtCentre`) and the drag path
   * (`onDrop` with a point) both arrive HERE, so they cannot drift apart — the
   * palette's click and a real drag run identical geometry.
   *
   * @param {{id:string, build:Function}} preset
   * @param {{x:number,y:number}} [screenPoint] viewport pixels. Omit to drop at
   *   the centre of the viewport (click and keyboard placement).
   * @returns {any[]|null} the created elements, for the caller to select
   */
  const onDrop = useCallback(
    (preset, screenPoint) => {
      if (!preset || typeof preset.build !== 'function') return null;

      let point = screenPoint;
      if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
        // The centre of the VIEWPORT, in board units, re-converted on every
        // call so a click-to-place lands where the user is actually looking,
        // even mid-pan or mid-zoom. The size comes from the SHARED measurement
        // (see `canvasSize`), never from this instance's own node: the palette
        // is the instance serving the click and it has no node of its own, so
        // reading locally would resolve the centre to (0,0) and stack every
        // placement in the board's top-left corner.
        const size = currentCanvasSize();
        point = viewportCentreToBoard(size, view);
      }

      let elements;
      try {
        elements = buildDroppedElements({
          screenPoint: { x: point.x, y: point.y },
          view,
          style,
          gridSize,
          snapEnabled,
          preset: withBoxOrigin(preset),
          size: DEFAULT_DROP_SIZE,
        });
      } catch (err) {
        // A preset whose `build` throws must not take the click handler down
        // with it: the error would escape as an unhandled rejection and the
        // user would see nothing at all, which is exactly how this looked.
        console.error('[dnd] preset build failed', preset?.id, err);
        return null;
      }
      if (!Array.isArray(elements) || elements.length === 0) return null;

      // The documented mutation path, and now the only one. Commit ONCE for the
      // whole preset — so a single Ctrl+Z removes the sticky AND its arrow —
      // then add them together. The actions are read off the live state at CALL
      // time, not closed over at mount, so a drop always uses the current store
      // rather than a stale render's copy.
      const s = useBoardStore.getState();
      s.commit(`add ${preset.label ?? preset.id ?? 'preset'}`);
      s.addElements(elements);
      return elements;
    },
    [view, style, gridSize, snapEnabled],
  );

  const onDropAtCentre = useCallback((preset) => onDrop(preset, null), [onDrop]);

  // Publish the handle. This runs during RENDER (not in an effect) on purpose:
  // an effect would leave a window in which `DndProvider`'s `onDragEnd` — which
  // reads the singleton at drop time — could observe a stale or absent handle.
  const handle = useRef(null);
  handle.current = {
    setNodeRef,
    isOver,
    onDrop,
    onDropAtCentre,
    droppableId: CANVAS_DROPPABLE_ID,
  };
  instance = handle.current;

  // Unmount: give the handle back only if we are STILL the current one. Under
  // StrictMode the mount → unmount → remount sequence would otherwise let the
  // FIRST instance's cleanup null out the SECOND instance's live handle, and
  // every subsequent drop would hit the no-op. Same guard on the node: it is
  // cleared only once nothing owns it any more.
  useEffect(() => {
    const mine = handle.current;
    return () => {
      if (instance === mine) instance = null;
      if (canvasNode && !canvasNode.isConnected) canvasNode = null;
    };
  }, []);

  return handle.current;
}

/**
 * The canvas viewport size in CSS px: the shared measurement first, then a live
 * measurement of the live node, then the window. The fallbacks matter because
 * the shared value is only populated once an owner has measured it, and a
 * click on the very first frame should still land in the middle of the screen
 * rather than at the board origin.
 *
 * @returns {{width:number,height:number}}
 */
function currentCanvasSize() {
  if (canvasSize.width > 0 && canvasSize.height > 0) return canvasSize;
  const measured = elSize(canvasNode) ?? elSize(document.querySelector('.canvas-host'));
  if (measured && measured.width > 0 && measured.height > 0) return measured;
  return {
    width: typeof window === 'undefined' ? 0 : window.innerWidth,
    height: typeof window === 'undefined' ? 0 : window.innerHeight,
  };
}

function elSize(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
  return { width: r.width, height: r.height };
}

/**
 * The dnd-kit `onDragEnd` half. A drop that landed on the canvas is converted
 * from the pointer's client coordinates; anything else is ignored, so dropping
 * a preset on a toolbar does nothing rather than placing it at 0,0.
 *
 * @param {any} event dnd-kit DragEndEvent
 * @param {(preset:object, screenPoint:{x:number,y:number})=>any} onDrop
 * @returns {any[]|null}
 */
export function resolveCanvasDrop(event, onDrop) {
  if (!event) return null;
  const preset = event.active?.data?.current?.preset;
  if (!preset) return null;
  if (event.over?.id !== CANVAS_DROPPABLE_ID) return null;

  const activator = event.activatorEvent;
  const hasPointer =
    activator && Number.isFinite(activator.clientX) && Number.isFinite(activator.clientY);

  let point = null;
  if (hasPointer) {
    point = { x: activator.clientX, y: activator.clientY };
  } else {
    // Keyboard drag: there is no pointer position, and dnd-kit's `delta` is
    // relative to the activator rect, so the drop point is the activator's own
    // centre. `onDrop(preset, null)` (viewport centre) stays the exact fallback
    // when even that is missing.
    const rect = event.active?.rect?.current?.translated ?? canvasRect();
    if (rect) point = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }
  return onDrop(preset, point);
}

/**
 * The canvas droppable's live box, in VIEWPORT pixels. The node the droppable is
 * attached to is kept in module state by `useDropOnCanvas`, so the drag-end path
 * can measure the same element without a second `useDroppable` registration
 * (which would evict the first).
 */
function canvasRect() {
  const el =
    canvasNode && canvasNode.isConnected ? canvasNode : document.querySelector('.canvas-host');
  if (!el || typeof el.getBoundingClientRect !== 'function') return null;
  const r = el.getBoundingClientRect();
  if (!Number.isFinite(r.width) || !Number.isFinite(r.height)) return null;
  if (r.width === 0 || r.height === 0) return null;
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

export default useDropOnCanvas;
