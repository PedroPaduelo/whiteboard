/**
 * Memo-friendly derived data.
 *
 * Every selector here is PURE and CHEAP. They are used inside `useShallow`
 * wrappers in `index.js`, which means the returned value is compared one
 * level deep on every store change — a selector that walks the whole element
 * list on every pointer move is a selector that re-renders the board on
 * every pointer move. Where a scan is unavoidable it is done with a single
 * pass and a cheap equality result (an id list, a count, a box) rather than
 * a new object graph.
 *
 * All of them take the store state as their argument, so they can be used
 * outside React too (`store.getState().elements`, tests, the SVG export).
 */

import { boundsOfRectList } from '@whiteboard/shared';

/** Element by id, or null. */
export const selectById = (id) => (s) => (id ? s.elements.find((el) => el.id === id) ?? null : null);

/**
 * Just the boxes, for `fitView`. Strips the payload so the comparison is 4
 * numbers per element rather than the whole element (text, points, styles).
 * @returns {{id:string,x:number,y:number,w:number,h:number}[]}
 */
export const selectBoxes = (s) => s.elements.map((el) => ({ id: el.id, x: el.x, y: el.y, w: el.w, h: el.h }));

/** The selected elements, in z-order. */
export const selectSelectedElements = (s) => s.elements.filter((el) => s.selection.has(el.id));

/** Ids of the selected elements, in z-order. Cheap to compare. */
export const selectSelectedIds = (s) => s.elements.filter((el) => s.selection.has(el.id)).map((el) => el.id);

export const selectCanUndo = (s) => s.canUndo;
export const selectCanRedo = (s) => s.canRedo;

/** The selection as a plain sorted array — safe to put in a dependency list. */
export const selectSelectionArray = (s) => Array.from(s.selection).sort();

/**
 * Connectors anchored to an element — what to draw as "attached" when
 * hovering, and what has to follow when it moves. Returns both directions so
 * a caller does not need to know which end is which.
 */
export const selectConnectedTo = (id) => (s) => {
  if (!id) return [];
  return s.elements.filter(
    (el) => (el.type === 'arrow' || el.type === 'line') && (el.startId === id || el.endId === id),
  );
};

/** Ids only, for the rare caller that just needs the count. */
export const selectConnectedIdsTo = (id) => (s) => {
  if (!id) return [];
  return s.elements
    .filter((el) => (el.type === 'arrow' || el.type === 'line') && (el.startId === id || el.endId === id))
    .map((el) => el.id);
};

export const selectElementCount = (s) => s.elements.length;

/** Ids in z-order — the drag-and-drop layer list reads this. */
export const selectElementIds = (s) => s.elements.map((el) => el.id);

/** The board has anything worth exporting. */
export const selectIsEmpty = (s) => s.elements.length === 0;

/**
 * Union box of every element, or null on an empty board. `fitView` needs a
 * single box, not a list.
 */
export const selectBounds = (s) => {
  if (s.elements.length === 0) return null;
  return boundsOfRectList(s.elements);
};

/** Union box of the selection only, or null when nothing is selected. */
export const selectSelectionBounds = (s) => {
  const chosen = s.elements.filter((el) => s.selection.has(el.id));
  if (chosen.length === 0) return null;
  return boundsOfRectList(chosen);
};

/** Remote cursors excluding your own — you never draw your own cursor. */
export const selectRemoteCursorList = (s) => {
  if (s.remoteCursors.size === 0) return [];
  const out = [];
  for (const [id, cur] of s.remoteCursors) if (id !== s.myPeerId) out.push({ id, ...cur });
  return out;
};

/** Everyone's cursor, yours included, keyed by peer id. */
export const selectCursorMap = (s) => s.remoteCursors;

/** Other peers, for a roster that excludes you. */
export const selectOtherPeers = (s) => s.peers.filter((p) => p.id !== s.myPeerId);

/** Connection state for the status bar. */
export const selectStatusLine = (s) => ({
  status: s.status,
  rev: s.rev,
  error: s.error,
  connected: s.myPeerId !== null,
});

/** A lookup map for the canvas hot path, rebuilt only when elements change. */
export const selectElementMap = (s) => {
  const m = new Map();
  for (const el of s.elements) m.set(el.id, el);
  return m;
};

/** True when a connector endpoint is bound to an element rather than free. */
export const selectHasAnchors = (s) =>
  s.elements.some((el) => (el.type === 'arrow' || el.type === 'line') && (el.startId || el.endId));
