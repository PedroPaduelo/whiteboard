/**
 * store.js — the one place the UI reads the board store.
 *
 * Everything else in `src/ui/**` imports from here rather than from
 * `../store/index.js`, for two reasons:
 *
 *  1. One subscription shape. `useStore(selector)` always subscribes with a
 *     selector, so a component can never accidentally re-render on every
 *     store write (which is how "the whole app re-renders on every mousemove"
 *     bugs start).
 *  2. One imperative shape. `getStoreApi()` returns a proxy that forwards
 *     property reads to the live state and binds actions to it, so
 *     `store.undo()` and `store.getState().elements` both work regardless of
 *     how the store agent wired zustand up. Shortcut handlers and event
 *     handlers use this because they live outside React's render cycle.
 *
 * If the store agent named things slightly differently, this file is the
 * single line to fix.
 */

import { useCallback, useSyncExternalStore } from 'react';
import { useBoardStore } from '../store/index.js';

const identity = (s) => s;

/** Subscribe to a slice. The selector should return a primitive or stable ref. */
export function useStore(selector = identity) {
  return useBoardStore(selector);
}

/**
 * Select several slices at once with a shallow comparison, so a component can
 * read `tool` and `style` in one subscription without re-rendering when an
 * unrelated slice (elements, peers) changes.
 */
export function useShallowStore(selector) {
  const subscribe = useCallback((onChange) => useBoardStore.subscribe(onChange), []);
  const getSnapshot = useCallback(() => selector(useBoardStore.getState()), [selector]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * Live store facade for code outside the render cycle (keyboard handlers,
 * pointer handlers, dialogs). Property reads are delegated to the current
 * state on every access, so it never goes stale.
 */
export function getStoreApi() {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        const state = useBoardStore.getState();
        const value = state[prop];
        return typeof value === 'function' ? value.bind(state) : value;
      },
      has(_target, prop) {
        return prop in useBoardStore.getState();
      },
      ownKeys() {
        return Reflect.ownKeys(useBoardStore.getState());
      },
      getOwnPropertyDescriptor() {
        return { configurable: true, enumerable: true, value: undefined };
      },
    },
  );
}

/** Read the whole state without subscribing. Safe in event handlers. */
export function readStore() {
  return useBoardStore.getState();
}
