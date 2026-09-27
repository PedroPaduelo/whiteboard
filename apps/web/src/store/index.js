/**
 * React bindings for the board store.
 *
 * Components should import from HERE, not from `boardStore.js` directly, and
 * should use the narrow hooks rather than `useBoardStore()` with an inline
 * selector. Two reasons, both real:
 *
 *  1. `useBoardStore()` with no selector re-renders on EVERY store change.
 *     On a canvas app that is every pointer move, so a dragging shape would
 *     re-render the entire UI tree at 60fps.
 *  2. Selecting an object or array without `useShallow` produces a new
 *     reference on every change, so `useSyncExternalStore` sees a changed
 *     snapshot and re-renders even when the contents are identical. A
 *     `Set` for selection, a `Map` for cursors and an array for elements are
 *     all exactly this shape — which is why `useSelection` and `usePeers`
 *     below are wrapped.
 */

import { useShallow } from 'zustand/react/shallow';
import { useBoardStore } from './boardStore.js';
import { shallow } from 'zustand/shallow';

export { useBoardStore };
export { subscribe, getState, initialState, CURSOR_TTL_MS } from './boardStore.js';
export * as selectors from './selectors.js';
export * from './presets.js';

/**
 * The raw store, for imperative code outside React (`realtime/sync.js`,
 * the canvas hot path, the SVG export). Prefer the hooks below in a
 * component — reaching for this one is how re-render storms start.
 */
export const store = useBoardStore;

/**
 * Generic selector hook — the escape hatch for anything the named hooks
 * below do not cover.
 *
 * Identity comparison is the default, and that is the right default: a
 * selector returning a primitive or a stable reference re-renders only when
 * that value actually changes. For a selector that builds a NEW object or
 * array every call, identity comparison re-renders on every store change,
 * so pass `shallow` as the second argument:
 *
 *     const { stroke, fill } = useSelector((s) => s.style, shallow);
 *
 * This is a thin wrapper over zustand's own hook, so it inherits the same
 * `useSyncExternalStore` behaviour and the same StrictMode safety.
 *
 * @param {(state: object) => unknown} selector
 * @param {(a: unknown, b: unknown) => boolean} [equality]
 */
export function useSelector(selector, equality) {
  return useBoardStore(selector, equality);
}

/** `useSelector` pre-wrapped for the common "object/array result" case. */
export function useShallowSelector(selector) {
  return useBoardStore(useShallow(selector));
}

/** The active tool. A string — no shallow needed. */
export const useTool = () => useBoardStore((s) => s.tool);

/** The active selection as a stable ARRAY. Never return the Set itself. */
export const useSelection = () => useBoardStore(useShallow((s) => Array.from(s.selection)));

/** The number of selected elements, for "3 selected" labels. */
export const useSelectionCount = () => useBoardStore((s) => s.selection.size);

/** The hovered / in-place-edited element id, or null. */
export const useHoveredId = () => useBoardStore((s) => s.hoveredId);
export const useEditingId = () => useBoardStore((s) => s.editingId);

/** The live marquee rectangle while drag-selecting, or null. */
export const useMarquee = () => useBoardStore((s) => s.marquee);

/** The view transform. An object, so it needs the shallow wrapper. */
export const useView = () => useBoardStore(useShallow((s) => s.view));

/** The style palette. An object — shallow wrapper keeps it from churning. */
export const useStyle = () => useBoardStore(useShallow((s) => s.style));

/** Grid size (0 = snapping off) and whether snapping is enabled. */
export const useGridSize = () => useBoardStore((s) => s.gridSize);
export const useSnapEnabled = () => useBoardStore((s) => s.snapEnabled);

/** The peer roster. An array that is replaced wholesale on presence events. */
export const usePeers = () => useBoardStore(useShallow((s) => s.peers));

/** Our own peer id — null until the socket says `ready`. */
export const useMyPeerId = () => useBoardStore((s) => s.myPeerId);

/**
 * Remote cursors as an array. This one matters most: a cursor moves on every
 * pointer event, so an unwrapped Map here re-renders the whole board on
 * every mouse move of every collaborator.
 */
export const useRemoteCursors = () =>
  useBoardStore(useShallow((s) => Array.from(s.remoteCursors, ([peerId, cur]) => ({ peerId, ...cur }))));

/** Load status, board id, board rev, last error. */
export const useStatus = () => useBoardStore(useShallow((s) => s.status));
export const useBoardId = () => useBoardStore((s) => s.boardId);
export const useRev = () => useBoardStore((s) => s.rev);
export const useError = () => useBoardStore((s) => s.error);
export const useBoard = () => useBoardStore((s) => s.board);

/**
 * The full element list, in z-order. This array changes on every element
 * mutation — that is the point, it is what makes the canvas redraw.
 */
export const useElements = () => useBoardStore((s) => s.elements);

/** Undo/redo availability and stack depths, for the toolbar's disabled state. */
export const useCanUndo = () => useBoardStore((s) => s.canUndo);
export const useCanRedo = () => useBoardStore((s) => s.canRedo);
export const useHistoryDepth = () => useBoardStore(useShallow((s) => ({ past: s.pastDepth, future: s.futureDepth })));

/**
 * Actions are stable for the lifetime of the store, so they are read through
 * `getState` and never trigger a re-render. Pull them out of the render path
 * entirely — this is what lets a component call `commit()` in a pointer
 * handler without subscribing to anything.
 */
export const useActions = () => useBoardStore.getState;

/**
 * A live facade over the store for code that is NOT a React render: the
 * global keydown listener, the shortcut table, the dnd drop path, anything
 * that runs inside a DOM event handler.
 *
 * The problem this solves, concretely: the actions live INSIDE the state
 * object, not on the hook function. `useBoardStore` only carries `getState`.
 * So a shortcut written as `store.commit('delete')` receives `undefined`, and
 * because `runShortcut` wraps handlers in a try/catch the TypeError is
 * swallowed — the key matches, the handler runs, and nothing happens. That is
 * exactly how Delete came to look broken while the app was otherwise healthy.
 *
 * Properties are read through a Proxy against the CURRENT state, so
 * `store.selection` is always live, and the actions are bound to the state
 * object they came from, so `commit`/`removeElements`/etc. are real calls.
 *
 * Not a hook: nothing here subscribes, so using it inside a component does
 * not re-render on store writes. For rendering, use the narrow hooks above —
 * subscribing to the whole state in a component is the mistake that makes a
 * board re-render on every remote cursor.
 *
 * @returns {object} the facade
 */
export function useStoreHandle() {
  return storeHandle;
}

const storeHandle = new Proxy(
  {},
  {
    get(_t, prop) {
      // `getState` is how the shortcut table reads the live state
      // (`store.getState().selection`), so the facade has to answer it too.
      if (prop === 'getState') return useBoardStore.getState;
      const state = useBoardStore.getState();
      const value = state[prop];
      return typeof value === 'function' ? value.bind(state) : value;
    },
    has(_t, prop) {
      return prop in useBoardStore.getState();
    },
    ownKeys() {
      return Reflect.ownKeys(useBoardStore.getState());
    },
    getOwnPropertyDescriptor(_t, prop) {
      const d = Reflect.getOwnPropertyDescriptor(useBoardStore.getState(), prop);
      // The proxy's invariants require a non-configurable descriptor to report
      // `configurable: true`; the state object is a plain object, so this is
      // safe and keeps `Object.keys(store)` from throwing.
      return d ? { ...d, configurable: true } : undefined;
    },
  },
);
