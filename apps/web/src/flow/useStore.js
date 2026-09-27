/**
 * A thin adapter over the store's React bindings.
 *
 * `WEB_CONTRACT.md` specifies `import { useBoardStore, useSelector } from
 * '../store/index.js'`, but the store as shipped exports `useElements`,
 * `useView`, `useStyle`, … and no `useSelector`. Rather than edit another
 * agent's file, or hardcode one shape, this resolves the selector at module
 * load: if the store ever grows the contract's `useSelector`, it wins;
 * otherwise `useBoardStore(selector)` — exactly what every narrow hook does —
 * is the fallback.
 *
 * `useShallowSelector` applies the same `useShallow` wrapping the narrow hooks
 * use, so an object/Set/Array result never churns its identity and re-renders
 * the layer on every store write.
 */

import { useShallow } from 'zustand/react/shallow';
import * as storeBindings from '../store/index.js';

const { useBoardStore } = storeBindings;

// Copied into a plain record first: a direct namespace read is resolved
// statically by the bundler, which then warns that the named export is missing
// even though this lookup is deliberately optional and guarded.
const bindings = { ...storeBindings };
const contractUseSelector = bindings.useSelector;

export const useSelector =
  typeof contractUseSelector === 'function' ? contractUseSelector : (selector) => useBoardStore(selector);

/** `useShallow`-wrapped, for object/Set/Array results. */
export const useShallowSelector = (selector) => useBoardStore(useShallow(selector));

export { useBoardStore };
