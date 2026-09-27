/**
 * `useFlowSync` — keeps the React Flow layer and the whiteboard canvas in
 * agreement about where an element is, without either one stomping the other.
 *
 * The problem, precisely: both layers can move the same element. The canvas
 * drags it, the store updates, the node re-derives at the new position, React
 * Flow sees its node move under a pointer it thinks it is dragging, emits a
 * `position` change, we write that back — and the element drifts one frame at a
 * time away from the cursor. The fix is an ownership ref: whichever interaction
 * STARTED owns the element until that interaction ENDS, and the other layer
 * only follows.
 *
 * All the decision logic is in `derive.js` (pure, tested). This hook is the
 * React wiring around it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useReactFlow } from 'reactflow';
import { useBoardStore, useShallowSelector, useSelector } from './useStore.js';
import {
  acceptsStoreMove,
  beginInteraction,
  createInteractionOwner,
  deriveFlowNodes,
  endInteraction,
  flowSignature,
  planMovePatches,
} from './derive.js';

export const selectElements = (s) => s.elements;
export const selectSelection = (s) => s.selection;
export const selectView = (s) => s.view;
export const selectGridSize = (s) => s.gridSize;
export const selectSnapEnabled = (s) => s.snapEnabled;

/**
 * @returns {{
 *   nodes: any[],
 *   onNodesChange: (changes:any[])=>void,
 *   onNodeDragStart: (e:any,node:any)=>void,
 *   onNodeDragStop: (e:any,node:any)=>void,
 *   onNodeResizeStart: (e:any,node:any)=>void,
 *   onNodeResizeEnd: (e:any,node:any)=>void,
 *   interactionOwner: {current: 'canvas'|'flow'|null},
 * }}
 */
export function useFlowSync() {
  const elements = useSelector(selectElements);
  // The selection is a Set: unwrapped, its identity changes on every store write
  // and the whole flow layer re-renders on every remote cursor.
  const selection = useShallowSelector(selectSelection);
  const storeView = useShallowSelector(selectView);
  const gridSize = useSelector(selectGridSize);
  const snapEnabled = useSelector(selectSnapEnabled);

  // The store's `useFlowNodes` selector, when the store agent has shipped it.
  // It is the authority on "is this element structural". Read through the store
  // so it participates in subscriptions rather than being sampled once.
  const flowSelector = useSelector((s) => s.useFlowNodes ?? null);

  const commit = useBoardStore((s) => s.commit);
  const updateElement = useBoardStore((s) => s.updateElement);
  const { setViewport, getViewport, fitView } = useReactFlow();

  /** THE ownership ref. `null` = nobody owns; the store is then free to move
   *  the nodes. Deliberately NOT state: it is read and written in the middle of
   *  a drag, and a re-render between "set" and "read" is the race it prevents. */
  const interactionOwner = useRef(createInteractionOwner());

  /** Ids of drags this client started. React Flow sends `dragging: false` at
   *  the end of every drag, including programmatic ones, and we only want the
   *  ones we began. */
  const draggingIds = useRef(new Set());
  /** Where each drag began, so the reported DELTA can be made absolute. */
  const dragStartAt = useRef(new Map());
  /** Live positions of nodes being dragged, so re-derivation does not snap
   *  them back mid-drag. */
  const overrides = useRef(new Map());
  /** Latest elements, for the drag-end commit without a stale closure. */
  const elementsRef = useRef(elements);
  elementsRef.current = elements;

  const [nodes, setNodes] = useState(() => deriveFlowNodes(elements));

  // --- store -> nodes ------------------------------------------------------
  // Re-derive only when a node-rendered field actually changed. Without this,
  // every remote cursor, hover and marquee update in the store would rebuild
  // the entire node array and re-render every node in the layer.
  useEffect(() => {
    // Pass the REF, not ref.current. The helpers in derive.js dereference
    // .current themselves — handing them the value gives them `null` (the
    // owner is unclaimed at mount) and the whole effect throws on
    // "reading 'current' of null", which takes the canvas down with it.
    if (!acceptsStoreMove(interactionOwner)) return; // a flow drag owns it
    const next = deriveFlowNodes(elements, { selector: flowSelector, selection });
    setNodes((prev) => (flowSignature(prev) === flowSignature(next) ? prev : next));
  }, [elements, selection, flowSelector]);

  // --- viewport ------------------------------------------------------------
  // The canvas owns navigation. React Flow is told to stop handling pan/zoom
  // (all its gesture props are off in FlowLayer), but its internal viewport
  // still has to track `view`, otherwise nodes drift out of register with the
  // drawing underneath as soon as the user scrolls.
  useEffect(() => {
    const v = storeView;
    if (!v) return;
    const current = getViewport();
    if (
      Math.abs(current.x - v.panX) < 0.01 &&
      Math.abs(current.y - v.panY) < 0.01 &&
      Math.abs(current.zoom - v.zoom) < 0.0001
    ) {
      return;
    }
    setViewport({ x: v.panX, y: v.panY, zoom: v.zoom });
  }, [storeView, setViewport, getViewport]);

  // --- cleanup -------------------------------------------------------------
  // Leaked subscriptions across a board switch are how these apps end up
  // rendering two boards at once. React Flow's store is module-level and
  // outlives the component, so anything it holds onto has to be released here.
  useEffect(() => {
    const onUnmount = () => {
      endInteraction(interactionOwner, undefined);
      draggingIds.current.clear();
      dragStartAt.current.clear();
      overrides.current.clear();
      setNodes([]);
    };
    return onUnmount;
  }, []);

  // --- resize --------------------------------------------------------------
  // A node resize is also a geometry change, and it must reach the store with
  // the same one-commit-per-gesture discipline as a drag. React Flow already
  // applied it to its internal node; we only need to persist it.
  const resizeStart = useRef(new Map());

  const onNodeResizeStart = useCallback(
    (_e, node) => {
      beginInteraction(interactionOwner, 'flow');
      draggingIds.current.add(node.id);
      const el = elementsRef.current.find((x) => x.id === node.id);
      resizeStart.current.set(node.id, { x: el?.x ?? node.position.x, y: el?.y ?? node.position.y });
    },
    [],
  );

  const onNodeResizeEnd = useCallback(
    (_e, node) => {
      resizeStart.current.delete(node.id);
      draggingIds.current.delete(node.id);
      endInteraction(interactionOwner, 'flow');
      overrides.current.delete(node.id);
      const w = Number.isFinite(node.width) ? node.width : node.measured?.width;
      const h = Number.isFinite(node.height) ? node.height : node.measured?.height;
      if (!Number.isFinite(w) || !Number.isFinite(h)) return;
      commit('resize');
      updateElement(node.id, { w, h });
    },
    [commit, updateElement],
  );

  // --- drag lifecycle ------------------------------------------------------
  const onNodeDragStart = useCallback((_e, node) => {
    beginInteraction(interactionOwner, 'flow');
    draggingIds.current.add(node.id);
    const el = elementsRef.current.find((x) => x.id === node.id);
    const start = {
      x: Number.isFinite(el?.x) ? el.x : node.position.x,
      y: Number.isFinite(el?.y) ? el.y : node.position.y,
    };
    dragStartAt.current.set(node.id, start);
    overrides.current.set(node.id, { x: start.x, y: start.y });
  }, []);

  const onNodeDragStop = useCallback(
    (_e, node) => {
      const start = dragStartAt.current.get(node.id);
      const end = { x: node.position.x, y: node.position.y };
      const final = Number.isFinite(end.x) && Number.isFinite(end.y)
        ? end
        : start ?? { x: node.position.x, y: node.position.y };

      draggingIds.current.delete(node.id);
      dragStartAt.current.delete(node.id);
      overrides.current.delete(node.id);
      endInteraction(interactionOwner, 'flow');

      if (!start) return;
      if (Math.abs(final.x - start.x) < 0.01 && Math.abs(final.y - start.y) < 0.01) return;

      // ONE commit for the whole drag, not one per change event. The store
      // snapshots before mutating; without this a 40-frame drag makes 40
      // undo steps and 40 op batches.
      commit('move');
      updateElement(node.id, { x: final.x, y: final.y });
    },
    [commit, updateElement],
  );

  // --- the hot path --------------------------------------------------------
  const onNodesChange = useCallback(
    (changes) => {
      if (!Array.isArray(changes) || changes.length === 0) return;

      // Live feedback only. While a drag is running the absolute position lives
      // in `overrides` and in React Flow's own state; the store is written ONCE,
      // at drag end, in `onNodeDragStop`. Writing per frame would turn a 40
      // frame drag into 40 undo steps and 40 op batches.
      //
      // `select` is ignored on purpose: the canvas owns selection and React Flow
      // is told `elementsSelectable={false}`. `dimensions` are React Flow's own
      // measurement. `remove` goes through the store's delete.
      const patches = planMovePatches(
        changes,
        (id) => dragStartAt.current.get(id),
        draggingIds.current,
        (id, pos) => overrides.current.set(id, pos),
      );
      if (patches.length === 0) return;

      const byId = new Map(patches.map((p) => [p.id, p]));
      setNodes((prev) =>
        prev.map((n) => {
          const p = byId.get(n.id);
          return p ? { ...n, position: { x: p.x, y: p.y } } : n;
        }),
      );
    },
    [],
  );

  const onNodeResize = useCallback(() => {
    /* React Flow applies the resize internally; we persist at resize end. */
  }, []);

  return useMemo(
    () => ({
      nodes,
      onNodesChange,
      onNodeDragStart,
      onNodeDragStop,
      onNodeResizeStart,
      onNodeResize: onNodeResize,
      onNodeResizeEnd,
      interactionOwner,
      /** Exposed for the shell: "fit the flow layer to content" without
       *  fighting the canvas's own `fitToContent`. */
      fitFlowToContent: () => fitView({ padding: 0.15, duration: 200 }),
    }),
    [
      nodes,
      onNodesChange,
      onNodeDragStart,
      onNodeDragStop,
      onNodeResizeStart,
      onNodeResize,
      onNodeResizeEnd,
      interactionOwner,
      fitView,
      gridSize,
      snapEnabled,
    ],
  );
}

export default useFlowSync;
