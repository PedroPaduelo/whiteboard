/**
 * FlowLayer.jsx — THE board.
 *
 * This component used to be an invisible layer: every navigation prop off,
 * `pointer-events: none`, `selectable: false`, sitting above the canvas. It
 * contributed nothing but bugs — the runaway pan, the selection, the delete and
 * the missing minimap were all downstream of React Flow being switched off
 * while still being mounted.
 *
 * Now it is the single source of truth for everything that is a node. There is
 * no second layer to disagree with, which is what fixes the pan speed (React
 * Flow's viewport is absolute, not summed per frame), the selection, the
 * delete, and the minimap all at once.
 *
 * ## The interaction-ownership rule
 *
 * React Flow reports a node's `position` change as a DELTA from the drag
 * origin, not an absolute. Writing that delta as an absolute position makes
 * the node drift further from the cursor on every frame. So during a drag we
 * write NOTHING to the store — a local ref holds the live position, and the
 * store is written once, on `onNodeDragStop`, in a single batch together with
 * any connectors that followed. One gesture, one commit, one Ctrl+Z.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import ReactFlow, {
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  SelectionMode,
  ReactFlowProvider,
  useReactFlow,
} from 'reactflow';
import { resolveConnectors, ZOOM_LIMITS } from '@whiteboard/shared';
import { useBoardStore } from '../store/index.js';
import { toFlowNodes, toFlowEdges, boardSignature, planGestureEndPatches } from './model.js';
import { nodeTypes, edgeTypes } from './flowNodes.jsx';
import './flowLayer.css';

const store = () => useBoardStore.getState();

/* ------------------------------------------------------------------ *
 * The component
 * ------------------------------------------------------------------ */

function BoardFlow() {
  const elements = useBoardStore((s) => s.elements);
  const selection = useBoardStore((s) => s.selection);
  const editingId = useBoardStore((s) => s.editingId);
  // Which node is mid-resize, if any. React Flow owns the live measurement;
  // the store only knows the id, and the node model drops the pinned style for
  // it so the measurement is what paints.
  const resizingId = useBoardStore((s) => s.resizingId);
  const gridSize = useBoardStore((s) => s.gridSize);
  const tool = useBoardStore((s) => s.tool);
  const snapEnabled = useBoardStore((s) => s.snapEnabled);

  const flow = useReactFlow();

  const [nodes, setNodes] = useState(() => toFlowNodes(store().elements));
  const [edges, setEdges] = useState(() => toFlowEdges(store().elements));

  // Live drag positions, in a ref and not in state: they change on every
  // pointermove, and React state would re-render the tree at mouse rate.
  const overrides = useRef(new Map());
  const sigRef = useRef('');
  const nodesRef = useRef(nodes);
  const draggingId = useRef(null);

  const onNodeResizeStart = useCallback((_e, node) => {
    store().setResizing(node.id);
  }, []);

  const onNodeResizeEnd = useCallback((_e, node) => {
    const s = store();
    // React Flow 11 reports the resized box on `node.measured`; some builds
    // put it on the node itself. Read whichever is present rather than
    // assuming — guessing wrong here writes a 0x0 element.
    const w = node.measured?.width ?? node.width ?? node.data?.w;
    const h = node.measured?.height ?? node.height ?? node.data?.h;
    if (!Number.isFinite(w) || !Number.isFinite(h)) return;
    s.setResizing(null);
    if (w === node.data?.w && h === node.data?.h) return; // no actual change
    s.commit('resize');
    s.updateElement(node.id, { w, h });
  }, []);

  /** Double-click opens the in-place editor on a text or a sticky. Anything
   *  else has nothing to type into, so the gesture is ignored rather than
   *  swallowed by a no-op. */
  const onNodeDoubleClick = useCallback((_e, node) => {
    const el = node.data?.element;
    if (!el) return;
    if (el.type !== 'text' && el.type !== 'sticky') return;
    const s = store();
    s.select([el.id]);
    s.setEditing(el.id);
  }, []);

  // --- the one continuous path: store -> flow -------------------------
  useEffect(() => {
    const next = toFlowNodes(elements, {
      selection,
      overrides: overrides.current,
      editingId,
      resizingId,
      // The resize callbacks ride on the node's data because
      // `onResizeStart` / `onResizeEnd` are NOT props of <ReactFlow> — they
      // belong to <NodeResizer>, and passing them to the flow is silently
      // ignored, which leaves the handles rendered and completely inert.
      onResizeStart: onNodeResizeStart,
      onResizeEnd: onNodeResizeEnd,
    });
    // See the note above: the hand tool must not be fought by a draggable
    // node sitting under the cursor.
    if (tool === 'hand') for (const n of next) n.draggable = false;
    const nextEdges = toFlowEdges(elements);
    const sig = boardSignature(next, nextEdges);
    // The gate is not optional. The store writes on every remote cursor,
    // hover and marquee tick, so re-deriving without comparing re-renders the
    // whole tree on each peer's mouse move.
    if (sig === sigRef.current) return;
    sigRef.current = sig;
    setNodes(next);
    setEdges(nextEdges);
    nodesRef.current = next;
  }, [elements, selection, editingId, resizingId, tool, onNodeResizeStart, onNodeResizeEnd]);

  // --- the viewport is store-owned, so the StatusBar and the shortcuts agree
  useEffect(() => {
    return useBoardStore.subscribe((s, prev) => {
      if (s.view === prev.view) return;
      const v = s.view;
      const cur = flow.getViewport();
      if (
        Math.abs(cur.zoom - v.zoom) < 1e-4 &&
        Math.abs(cur.x - v.panX) < 0.5 &&
        Math.abs(cur.y - v.panY) < 0.5
      ) {
        return;
      }
      flow.setViewport({ x: v.panX, y: v.panY, zoom: v.zoom });
    });
  }, [flow]);

  // --- live drag: the ref only, no store write -------------------------
  // `draggable: false` is forced while the hand tool is active. React Flow
  // gives a draggable node precedence over the pane, so with the hand tool a
  // drag starting on a shape moves the SHAPE and never pans the board — the
  // hand tool feels broken exactly where the user needs it most, on top of
  // the thing they are trying to get past. Disabling the nodes for the
  // duration hands every gesture to the pane.
  const onNodesChange = useCallback(
    (changes) => {
      const removes = changes.filter((c) => c.type === 'remove');
      if (removes.length) {
        // `deleteKeyCode` is null, so this only fires from an explicit UI
        // action. Kept correct in case that ever changes.
        const s = store();
        s.commit('delete');
        s.removeElements(removes.map((c) => c.id));
        return;
      }
      // Selection has to flow BACK to the store. React Flow owns the hit
      // testing now, so a click produces a `select` change and nothing else —
      // without reading it here the click selects a node that the store still
      // believes is unselected, and Delete then has nothing to act on. That is
      // the shape of the "I click it and nothing gets selected" bug.
      const selects = changes.filter((c) => c.type === 'select');
      if (selects.length) {
        // React Flow has already decided the outcome and encoded it on the
        // node itself. Read the resulting state back off the nodes rather than
        // re-deriving it from the change list: the change list says WHICH
        // nodes were touched, not what the final selection is after a
        // shift-click, and reconstructing that here is how "shift-click
        // cleared my selection" bugs happen.
        const s = store();
        // Read from `flow.getNodes()`, not from the `nodes` prop or a ref.
        // React Flow has already applied the change to its own store by the
        // time this fires, and that store is the authority; a ref captured at
        // the last render still holds the PREVIOUS selection, so the store
        // never hears about a click.
        const ids = flow.getNodes().filter((n) => n.selected).map((n) => n.id);
        if (ids.length === s.selection.size && ids.every((id) => s.selection.has(id))) {
          return; // already in sync
        }
        s.select(ids);
        return;
      }

      let moved = false;
      for (const ch of changes) {
        if (ch.type === 'position' && ch.dragging) {
          overrides.current.set(ch.id, { x: ch.position.x, y: ch.position.y });
          moved = true;
        }
      }
      if (moved) {
        // Re-read from the store so the override and the element list cannot
        // drift apart, and let the signature gate decide whether to re-render.
        const s = store();
        const next = toFlowNodes(s.elements, {
          selection: s.selection,
          overrides: overrides.current,
          editingId: s.editingId,
        });
        const sig = boardSignature(next, toFlowEdges(s.elements));
        if (sig !== sigRef.current) {
          sigRef.current = sig;
          nodesRef.current = next;
          setNodes(next);
        }
      }
    },
    [flow],
  );

  /**
   * The viewport flows BACK to the store.
   *
   * `onMoveEnd` rather than `onMove`: this fires once per gesture, not per
   * frame. The store is what the StatusBar reads, what the zoom shortcuts act
   * on, and what a peer joining later is told — a viewport that only lives
   * inside React Flow makes all three disagree.
   */
  const onMoveEnd = useCallback((_e, viewport) => {
    store().setView({ zoom: viewport.zoom, panX: viewport.x, panY: viewport.y });
  }, []);

  /**
   * The drag that actually started.
   *
   * `onNodeDragStart` is the reliable signal: it fires once, with the node the
   * user grabbed. `onNodeDragStop` cannot be trusted on its own — when a shape
   * is dragged out from under the cursor and a label stacked on top of it
   * slides beneath the pointer, the stop reports the LABEL. Committing from
   * there moves the label and leaves the shape where it was, which is exactly
   * the "I drag it and it does not move" symptom.
   */
  const onNodeDragStart = useCallback((_e, node) => {
    draggingId.current = node.id;
  }, []);

  // --- the end of a drag: ONE commit, ONE batch -----------------------
  const onNodeDragStop = useCallback((_e, node) => {
    const s = store();
    // Prefer the node we saw dragging. When a shape is dragged out from under
    // the cursor and a label stacked on it slides beneath the pointer, the
    // callback reports the LABEL, and committing from here would move the
    // label while the shape stayed put — the "I drag it and it doesn't move"
    // symptom, with the label flying off on its own.
    const id = draggingId.current ?? node.id;
    const dragged = id === node.id ? node : { id, position: overrides.current.get(id) };
    draggingId.current = null;
    overrides.current.delete(id);
    if (!dragged?.position) return;

    const patches = planGestureEndPatches([{ id: dragged.id, position: dragged.position }], s.elements, resolveConnectors);
    if (patches.length === 0) return;
    s.commit('move');
    s.updateElements(patches);
  }, []);

  const onConnect = useCallback(
    (conn) => {
      // A connection from a handle produces a real ELEMENT, not an edge React
      // Flow invented: the board is the store, and the store is what syncs.
      const s = store();
      const src = flow.getNode(conn.source);
      const tgt = flow.getNode(conn.target);
      if (!src || !tgt) return;
      const centre = (n) => ({
        x: n.position.x + (n.measured?.width ?? n.width ?? 0) / 2,
        y: n.position.y + (n.measured?.height ?? n.height ?? 0) / 2,
      });
      const a = centre(src);
      const b = centre(tgt);
      s.commit('connect');
      s.addElement({
        id: `el_${Math.random().toString(36).slice(2, 12)}`,
        type: 'arrow',
        x: Math.min(a.x, b.x),
        y: Math.min(a.y, b.y),
        w: Math.abs(b.x - a.x),
        h: Math.abs(b.y - a.y),
        points: [a, b],
        startId: conn.source,
        endId: conn.target,
        stroke: '#1f2937',
        strokeWidth: 2,
        strokeStyle: 'solid',
      });
    },
    [flow],
  );

  // --- pane: alt-click cycles through overlapping elements -------------
  const onPaneClick = useCallback(
    (e) => {
      if (!e.altKey) return; // a plain click is React Flow's selection
      const s = store();
      if (s.selection.size === 0) return;
      const here = flow.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const hits = s.elements.filter(
        (el) =>
          el.type !== 'pen' &&
          here.x >= el.x && here.x <= el.x + el.w &&
          here.y >= el.y && here.y <= el.y + el.h,
      );
      if (hits.length < 2) return;
      const i = hits.findIndex((el) => s.selection.has(el.id));
      s.select([hits[(i + 1) % hits.length].id]);
    },
    [flow],
  );

  // --- the wheel: plain wheel pans, ctrl+wheel zooms, and it is CLAMPED -
  // A single fast wheel event can carry |deltaY| of several hundred. Unclamped,
  // `Math.exp(-deltaY * 0.01)` turns one event into a 20x jump — the
  // "insanely fast" zoom the hand-rolled canvas had. `zoomTo` is bounded by
  // minZoom/maxZoom, and the exponent is gentler than the old one.
  const onWheel = useCallback(
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      flow.zoomTo(flow.getZoom() * Math.exp(-e.deltaY * 0.002));
    },
    [flow],
  );

  // `select` gets a marquee on left-drag, which is the Excalidraw behaviour;
  // the hand tool pans with any button. Drawing tools leave the pane free.
  const panOnDrag = tool === 'hand' ? true : [1, 2];
  const selectionOnDrag = tool === 'select';

  return (
    <div className="flow-host" data-tool={tool} onWheel={onWheel} onClick={onPaneClick}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={onNodesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onConnect={onConnect}
        onNodeDoubleClick={onNodeDoubleClick}
        onMoveEnd={onMoveEnd}
        defaultViewport={{ x: 0, y: 0, zoom: 1 }}
        minZoom={ZOOM_LIMITS.min}
        maxZoom={ZOOM_LIMITS.max}
        panOnDrag={panOnDrag}
        /* React Flow marks every node with `nopan` and then refuses to pan a
           gesture that started inside one — read straight from its source:
           `if (isWrappedWithClass(event, noPanClassName)) return false`.
           That is right for a modal handle and wrong for the hand tool, whose
           whole job is panning from wherever the cursor happens to be,
           including on top of a shape.

           So the class is renamed to something the library does not recognise
           while the hand is active. Any value other than the default works. */
        noPanClassName={tool === 'hand' ? 'wb-pans-under-hand' : 'nopan'}
        selectionOnDrag={selectionOnDrag}
        selectionMode={SelectionMode.Partial}
        panOnScroll
        zoomOnScroll={false}
        zoomOnPinch
        panActivationKeyCode="Space"
        deleteKeyCode={null}
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        snapToGrid={snapEnabled && gridSize > 0}
        snapGrid={[gridSize || 20, gridSize || 20]}
        defaultEdgeOptions={{ type: 'smoothstep' }}
      >
        {/* The grid comes from React Flow rather than a hand-drawn loop, so
            the dot density thins correctly at every zoom. The token is read
            from CSS, which is what finally makes the dark theme work here:
            the old canvas painted its own light background over it. */}
        <Background
          variant={gridSize > 0 ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={gridSize || 20}
          size={1}
          color="var(--canvas-grid)"
        />
        <MiniMap
          pannable
          zoomable
          position="bottom-right"
          nodeStrokeWidth={0}
          nodeColor={(n) => n.data?.minimapColor || 'var(--color-border-strong)'}
          maskColor="var(--scrim)"
          style={{ width: 200, height: 140 }}
        />
        <Controls position="bottom-left" showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export default function FlowLayer() {
  return (
    <ReactFlowProvider>
      <BoardFlow />
    </ReactFlowProvider>
  );
}
