/**
 * `<DndProvider />` — the app-wide drag-and-drop context.
 *
 * One `DndContext` for the whole app: the preset palette (draggables), the
 * canvas (droppable), and the layer list (its own nested context for sorting)
 * all share it. Nesting two `DndContext`s at the root would make a palette drag
 * invisible to the canvas.
 *
 * `useDndContext` is a small context value holder, not a hook over
 * `useContext` state — it carries the live drag (which preset, which layer) so a
 * panel can show a drag overlay without reaching into dnd-kit internals.
 */

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { canvasCollisionDetection, CANVAS_DROPPABLE_ID } from './dropGeometry.js';
import { resolveCanvasDrop, getCanvasDrop } from './useDropOnCanvas.js';

const DndStateContext = createContext(null);

/**
 * @returns {{
 *   activePreset: object|null,
 *   activeLayerId: string|null,
 *   setActivePreset: (p: object|null)=>void,
 *   setActiveLayerId: (id: string|null)=>void,
 * }}
 */
export function useDndContext() {
  const ctx = useContext(DndStateContext);
  if (ctx) return ctx;
  // Called outside the provider (e.g. a panel rendered in a test or a portal
  // that escaped the tree). Returning a working no-op beats throwing.
  return {
    activePreset: null,
    activeLayerId: null,
    setActivePreset: () => {},
    setActiveLayerId: () => {},
  };
}

const dropAnimation = {
  duration: 180,
  easing: 'cubic-bezier(0.2, 0, 0.13, 1)',
  sideEffects: defaultDropAnimationSideEffects({
    // A "placed" cue on the drop target. The canvas already redraws the new
    // element, so the flash is deliberately short and non-blocking.
    styles: {
      active: { opacity: '0.35' },
    },
  }),
};

/**
 * @param {object} props
 * @param {Function} [props.onDragEnd] called as `(event, placedElements)` after
 *   a release. `placedElements` is the array that was just added, or null when
 *   the drop was not on the canvas.
 * @param {Function} [props.onPlaced] called as `(placedElements, preset)` only
 *   when a drag actually placed something — the "an element was added" hook,
 *   for callers that do not want to inspect every drag end.
 * @param {Function} [props.onDragStart]
 * @param {Function} [props.onDragCancel]
 */
export function DndProvider({ children, onDragEnd, onDragStart, onDragCancel, onPlaced }) {
  const [activePreset, setActivePreset] = useState(null);
  const [activeLayerId, setActiveLayerId] = useState(null);

  // This provider renders BEFORE the canvas host that owns the droppable, so
  // it deliberately holds no reference to the drop handler. Reading it at render
  // time would capture the pre-mount no-op permanently and make every released
  // drag a silent no-op — which is precisely how drag was dead before.
  // `handleDragEnd` reads it at DROP time instead, via `getCanvasDrop()`.

  const sensors = useSensors(
    // A distance constraint so a click on a palette item (which places the
    // preset) is not immediately swallowed as a micro-drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    // Keyboard dragging is a first-class path here, not a nicety: Space picks
    // up the item, arrows move it, Space drops it, Escape cancels.
    useSensor(KeyboardSensor, { keyboardCodes: { start: ['Space', 'Enter'], cancel: ['Escape'], end: ['Space', 'Enter', 'Tab'] } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 160, tolerance: 6 } }),
  );

  const handleDragStart = useCallback(
    (event) => {
      const data = event?.active?.data?.current;
      if (data?.preset) setActivePreset(data.preset);
      else if (data?.layerId) setActiveLayerId(data.layerId);
      onDragStart?.(event);
    },
    [onDragStart],
  );

  const handleDragEnd = useCallback(
    (event) => {
      // A preset released over the canvas is placed HERE. `resolveCanvasDrop`
      // returns null for anything that is not a canvas drop (a layer drag, a
      // release over a toolbar), so this cannot misplace anything.
      //
      // The handle is read at CALL time, so a drag that ends after the canvas
      // host re-rendered still uses the live view/style rather than a stale
      // closure.
      const placed = resolveCanvasDrop(event, getCanvasDrop().onDrop);
      if (placed) onPlaced?.(placed, event?.active?.data?.current?.preset);
      onDragEnd?.(event, placed);
      setActivePreset(null);
      setActiveLayerId(null);
    },
    [onDragEnd, onPlaced],
  );

  const handleDragCancel = useCallback(
    (event) => {
      onDragCancel?.(event);
      setActivePreset(null);
      setActiveLayerId(null);
    },
    [onDragCancel],
  );

  const value = useMemo(
    () => ({ activePreset, activeLayerId, setActivePreset, setActiveLayerId }),
    [activePreset, activeLayerId],
  );

  return (
    <DndStateContext.Provider value={value}>
      <DndContext
        sensors={sensors}
        collisionDetection={canvasCollisionDetection}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
        // The canvas droppable is enormous, and dnd-kit's default only measures
        // while a drag is in flight. `WhileDragging` is correct here; `Always`
        // would re-measure the layer list's 5000 droppables on every render.
        measuring={{ droppable: { strategy: MeasuringStrategy.WhileDragging } }}
      >
        {children}
        <DragOverlay dropAnimation={dropAnimation} zIndex={80}>
          {activePreset ? (
            <PaletteGhost preset={activePreset} />
          ) : null}
        </DragOverlay>
      </DndContext>
    </DndStateContext.Provider>
  );
}

/** The thing that follows the cursor mid-drag. */
export function PaletteGhost({ preset }) {
  return (
    <div
      data-dnd-ghost=""
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--sp-2)',
        padding: 'var(--sp-2) var(--sp-3)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--panel-bg-solid)',
        border: '1px solid var(--color-accent)',
        boxShadow: 'var(--shadow-3)',
        color: 'var(--color-text)',
        fontSize: 'var(--fs-sm)',
        fontFamily: 'var(--font-sans)',
        pointerEvents: 'none',
        transform: 'rotate(-1.5deg)',
      }}
    >
      <span aria-hidden="true">{preset?.icon ?? '▭'}</span>
      {preset?.label ?? 'Element'}
    </div>
  );
}

/**
 * `@dnd-kit/core` exports `MeasuringStrategy`, but importing it by value here
 * would make this module fail to load in a test that has no DOM. So it is
 * vendored — and the values below are COPIED FROM THE REAL ENUM, which is the
 * whole point:
 *
 *     MeasuringStrategy.Always          = 0
 *     MeasuringStrategy.BeforeDragging  = 1
 *     MeasuringStrategy.WhileDragging   = 2
 *
 * The previous fallback here said `WhileDragging: 0`, which is `Always`. Since
 * dnd-kit's `isDisabled()` switches on the raw number, asking for
 * `WhileDragging` while actually passing `0` re-measured EVERY droppable on
 * every render — the exact cost the comment on the prop is trying to avoid, and
 * on the layer list that is thousands of rects per frame. A wrong enum that
 * "works" is worse than a missing one, so this is asserted in the comment
 * rather than left to be re-invented.
 */
const MeasuringStrategy = { Always: 0, BeforeDragging: 1, WhileDragging: 2 };

export { CANVAS_DROPPABLE_ID };
export default DndProvider;
