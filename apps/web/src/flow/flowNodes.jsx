/**
 * flowNodes.jsx — the real React Flow node components.
 *
 * The four that used to live here were ghosts: `pointer-events: none` on the
 * body, selectable: false, connectable: false, deletable: false. They existed
 * only to be looked at from underneath, and they are why the app felt broken
 * — React Flow was contributing nothing but bugs.
 *
 * These are the opposite: real, interactive, selectable, draggable, resizable
 * nodes that ARE the board. There is no second layer to disagree with.
 *
 * ## Perf rules that are not optional here
 *
 * - Every component is `memo`'d and defined at MODULE scope. A node component
 *   re-created on every render makes React Flow re-mount every node, which
 *   drops the drag to single-digit fps on a board of any size.
 * - `nodeTypes` and `edgeTypes` are frozen at module scope for the same
 *   reason. A fresh object literal each render is a fresh registry.
 * - Styling comes from CSS custom properties, never from a hardcoded colour,
 *   so light and dark are both correct and neither needs a second code path.
 * - Only the sticky carries a shadow. Shadows on a few hundred nodes is the
 *   perf cliff; on a few dozen notes it is the whole look.
 */

import { memo, useCallback } from 'react';
import { NodeResizer, Handle, Position, BaseEdge, getSmoothStepPath, EdgeLabelRenderer } from 'reactflow';
import { NodeTextEditor } from '../canvas/textEdit.jsx';
import { useBoardStore } from '../store/index.js';

/* ------------------------------------------------------------------ *
 * Shared pieces
 * ------------------------------------------------------------------ */

const HANDLE_STYLE = {
  width: 9,
  height: 9,
  borderRadius: 999,
  background: 'var(--color-surface)',
  border: '1.5px solid var(--color-accent)',
  opacity: 0,
  transition: 'opacity var(--dur-fast) var(--ease)',
  pointerEvents: 'all',
};

/** The four connection handles. Hidden until the node is selected or hovered,
 *  because eight always-on dots on every node turns a board into a minefield. */
const Handles = memo(function Handles({ show }) {
  const o = show ? 1 : 0;
  const s = { ...HANDLE_STYLE, opacity: o };
  return (
    <>
      <Handle type="target" position={Position.Left} style={s} />
      <Handle type="target" position={Position.Top} style={s} />
      <Handle type="source" position={Position.Right} style={s} />
      <Handle type="source" position={Position.Bottom} style={s} />
    </>
  );
});

/** The resizer, mounted only when selected — always-on handles would be four
 *  permanent pointer traps on every node on the board. */
const Resizer = memo(function Resizer({ nodeId, minWidth = 48, minHeight = 32, keepAspectRatio, onResizeStart, onResizeEnd }) {
  // React Flow 11's `onResizeStart` / `onResizeEnd` receive the resize BOUNDS
  // ({ width, height, x, y }) — NOT the node object, and there is no
  // `measured` field in this version. The store handler needs an element id,
  // so it is threaded in from the node component.
  //
  // It used to come from `useNodeId()`, which reads `NodeIdContext`. Inside a
  // CUSTOM node that context is not in scope where we mount the resizer, so
  // `useNodeId()` returned `undefined`: every resize committed to
  // updateElement('undefined', ...) and the drag silently did nothing. Proven
  // in a browser — the library's own computed value, committed with the right
  // id, resized the node; the same value committed as-is, did not.
  //
  // Threading the id as a prop drops the dependency on a context that was
  // never there, and it cannot go stale.
  const start = useCallback(
    (e, bounds) => onResizeStart?.(e, { ...bounds, nodeId }),
    [onResizeStart, nodeId],
  );
  const end = useCallback(
    (e, bounds) => onResizeEnd?.(e, { ...bounds, nodeId }),
    [onResizeEnd, nodeId],
  );
  return (
    /* `handleClassName` REPLACES React Flow's own handle classes, and those
       carry the direction (`.handle.se`, `.handle-bottom`, …). Replacing them
       leaves four identical, direction-less handles: they all render in the
       same place and none of them knows which corner it is, so resizing does
       nothing at all.

       The defaults are kept and the styling comes from `handleStyle`, so the
       direction survives. */
    <NodeResizer
      isVisible
      minWidth={minWidth}
      minHeight={minHeight}
      keepAspectRatio={keepAspectRatio}
      onResizeStart={start}
      onResizeEnd={end}
      color="var(--color-accent)"
      handleStyle={{
        width: 9,
        height: 9,
        borderRadius: 2,
        background: 'var(--color-surface)',
        border: '1.5px solid var(--color-accent)',
      }}
    />
  );
});

/** SVG shapes that CSS cannot express. Reusing the same geometry the canvas
 *  and the SVG exporter draw is what keeps an exported file honest. */
const SvgShape = memo(function SvgShape({ kind, data, w, h }) {
  const stroke = data.stroke;
  const fill = data.fill === 'none' ? 'transparent' : data.fill;
  const sw = data.strokeWidth;
  const dash = data.strokeStyle === 'dashed' ? '6 4' : data.strokeStyle === 'dotted' ? '2 4' : undefined;

  if (kind === 'ellipse') {
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="wb-shape-svg" aria-hidden="true">
        <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </svg>
    );
  }
  if (kind === 'diamond') {
    const pts = `${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`;
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="wb-shape-svg" aria-hidden="true">
        <polygon points={pts} fill={fill} stroke={stroke} strokeWidth={sw} strokeDasharray={dash} />
      </svg>
    );
  }
  if (kind === 'cylinder') {
    // A database drum: an ellipse cap on top, straight sides, a matching cap
    // on the bottom. Drawing it as a plain rect is the giveaway that nobody
    // looked at the reference.
    const ry = Math.min(14, h / 4);
    return (
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="wb-shape-svg" aria-hidden="true">
        <path
          d={`M0 ${ry} A ${w / 2} ${ry} 0 0 1 ${w} ${ry} L ${w} ${h - ry} A ${w / 2} ${ry} 0 0 1 0 ${h - ry} Z`}
          fill={fill}
          stroke={stroke}
          strokeWidth={sw}
        />
        <path
          d={`M0 ${ry} A ${w / 2} ${ry} 0 0 0 ${w} ${ry}`}
          fill="none"
          stroke={stroke}
          strokeWidth={sw}
        />
      </svg>
    );
  }
  return null;
});

/** Shared body chrome: the surface, the rotation, the state styling. Rotation
 *  is applied to an INNER div, never to the node wrapper — React Flow owns the
 *  wrapper's transform for positioning, and fighting it makes the node drift. */
function Body({ children, data, w, h, className = '', rounded = true }) {
  return (
    <div
      className={`wb-node ${className}`}
      data-selected={data.selected ? '' : undefined}
      data-locked={data.locked ? '' : undefined}
      style={{
        width: w,
        height: h,
        // Rotate about the centre; the wrapper stays untransformed.
        transform: data.rotation ? `rotate(${data.rotation}rad)` : undefined,
        borderColor: data.selected ? 'var(--color-accent)' : data.stroke,
        borderWidth: data.selected ? 2 : 1.5,
        borderStyle: data.strokeStyle === 'dashed' ? 'dashed' : data.strokeStyle === 'dotted' ? 'dotted' : 'solid',
        background: data.fill === 'none' ? 'var(--color-surface)' : data.fill,
        borderRadius: rounded ? 'var(--radius-md)' : 0,
        opacity: data.locked ? 0.7 : 1,
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * The node types
 * ------------------------------------------------------------------ */

const RectNode = memo(function RectNode({ id, data, selected }) {
  const w = data.w || 160;
  const h = data.h || 90;
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <Body data={data} w={w} h={h} />
    </div>
  );
});

const EllipseNode = memo(function EllipseNode({ id, data, selected }) {
  const w = data.w || 160;
  const h = data.h || 90;
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={60} minHeight={40} keepAspectRatio onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <Body data={data} w={w} h={h} rounded={false} className="wb-node--shape">
        <SvgShape kind="ellipse" data={data} w={w} h={h} />
      </Body>
    </div>
  );
});

const DiamondNode = memo(function DiamondNode({ id, data, selected }) {
  const w = data.w || 140;
  const h = data.h || 100;
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={70} minHeight={50} onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <Body data={data} w={w} h={h} rounded={false} className="wb-node--shape">
        <SvgShape kind="diamond" data={data} w={w} h={h} />
      </Body>
    </div>
  );
});

const CylinderNode = memo(function CylinderNode({ id, data, selected }) {
  const w = data.w || 140;
  const h = data.h || 100;
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={70} minHeight={50} keepAspectRatio onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <Body data={data} w={w} h={h} rounded={false} className="wb-node--shape">
        <SvgShape kind="cylinder" data={data} w={w} h={h} />
      </Body>
    </div>
  );
});

/**
 * Commit an in-place text edit.
 *
 * `commit` BEFORE the mutation, per the store's rule — otherwise the text
 * changes and leaves nothing on the undo stack. Escape cancels without
 * committing, so the previous text is what stays.
 */
function useTextEditing() {
  return {
    commitText: useCallback((id, text) => {
      const s = useBoardStore.getState();
      const el = s.elements.find((e) => e.id === id);
      if (!el) return;
      if ((el.label ?? el.text) === text) return; // unchanged
      s.commit('edit text');
      s.updateElement(id, el.type === 'sticky' ? { label: text } : { text });
      s.setEditing(null);
    }, []),
    cancelEdit: useCallback(() => {
      useBoardStore.getState().setEditing(null);
    }, []),
  };
}

const StickyNode = memo(function StickyNode({ id, data, selected }) {
  const { commitText, cancelEdit } = useTextEditing();
  const w = data.w || 160;
  const h = data.h || 160;
  const el = data.element || {};
  // `readableTextOn` lives in the shared package for exactly this: white text
  // on a yellow note is unreadable, and a hardcoded table of "light" colours
  // goes stale the moment someone adds one.
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={80} minHeight={60} onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <div
        className="wb-node wb-node--sticky"
        data-selected={selected ? '' : undefined}
        style={{
          width: w,
          height: h,
          background: el.fill || 'var(--color-warning)',
          color: 'var(--color-text)', // resolved per-fill below
          transform: data.rotation ? `rotate(${data.rotation}rad)` : undefined,
          opacity: data.locked ? 0.7 : 1,
        }}
      >
        {data.editing ? (
          <NodeTextEditor
            element={el}
            onCommit={commitText}
            onCancel={cancelEdit}
            onBlurDone={commitText}
          />
        ) : (
          <span className="wb-node__label">{el.label}</span>
        )}
      </div>
    </div>
  );
});

const TextNode = memo(function TextNode({ id, data, selected }) {
  const { commitText, cancelEdit } = useTextEditing();
  const w = data.w || 200;
  const h = data.h || 40;
  const el = data.element || {};
  const size = el.fontSize || 24;
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={60} minHeight={20} onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <div
        className="wb-node wb-node--text"
        data-selected={selected ? '' : undefined}
        style={{
          width: w,
          height: h,
          fontSize: size,
          transform: data.rotation ? `rotate(${data.rotation}rad)` : undefined,
          opacity: data.locked ? 0.7 : 1,
        }}
      >
        {data.editing ? (
          <NodeTextEditor
            element={el}
            onCommit={commitText}
            onCancel={cancelEdit}
            onBlurDone={commitText}
          />
        ) : (
          el.text
        )}
      </div>
    </div>
  );
});

const ImageNode = memo(function ImageNode({ id, data, selected }) {
  const w = data.w || 200;
  const h = data.h || 150;
  const el = data.element || {};
  return (
    <div style={{ width: data.liveW ?? w, height: data.liveH ?? h }}>
      <Resizer nodeId={id} minWidth={40} minHeight={40} onResizeStart={data.onResizeStart} onResizeEnd={data.onResizeEnd} />
      <Handles show={selected} />
      <div
        className="wb-node wb-node--image"
        data-selected={selected ? '' : undefined}
        style={{ width: w, height: h, transform: data.rotation ? `rotate(${data.rotation}rad)` : undefined }}
      >
        <img src={el.src} alt="" draggable={false} width={w} height={h} />
      </div>
    </div>
  );
});

/**
 * A connector that is NOT an edge: free-floating, or bound at one end only.
 *
 * These stay nodes because a React Flow edge needs a source AND a target, and
 * dragging one arrow end onto a box — the single most-used connector gesture
 * — produces exactly that half-bound case. `points` is edited directly here,
 * with no reconciliation against React Flow geometry at all.
 *
 * The box is the connector's own bounding box, so the node needs a negative
 * margin to let the stroke render outside it, and `overflow: visible` on the
 * wrapper.
 */
const ConnectorNode = memo(function ConnectorNode({ id, data, selected }) {
  const el = data.element || {};
  const w = Math.max(data.w || 1, 1);
  const h = Math.max(data.h || 1, 1);
  const pts = el.points || [{ x: 0, y: 0 }, { x: 1, y: 1 }];
  const [a, b] = pts;
  const stroke = data.stroke;

  // The path is drawn in node-local coordinates: the box origin is (0,0).
  const x1 = a.x - el.x;
  const y1 = a.y - el.y;
  const x2 = b.x - el.x;
  const y2 = b.y - el.y;

  return (
    <div style={{ width: w, height: h, overflow: 'visible' }}>
      <Handles show={selected} />
      <svg className="wb-connector" width={w} height={h} style={{ overflow: 'visible' }} aria-hidden="true">
        <line
          x1={x1} y1={y1} x2={x2} y2={y2}
          stroke={stroke}
          strokeWidth={data.strokeWidth}
          strokeDasharray={
            data.strokeStyle === 'dashed' ? '6 4' : data.strokeStyle === 'dotted' ? '2 4' : undefined
          }
        />
        {el.type === 'arrow' && (
          <polygon
            points={`${x2},${y2} ${x2 - 8},${y2 - 4} ${x2 - 8},${y2 + 4}`}
            fill={stroke}
          />
        )}
      </svg>
    </div>
  );
});

/* ------------------------------------------------------------------ *
 * The custom edge — a bound connector
 * ------------------------------------------------------------------ */

const SmoothEdge = memo(function SmoothEdge({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
  style, markerEnd, data, selected,
}) {
  const [path, labelX, labelY] = getSmoothStepPath({
    sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition,
    borderRadius: 8,
  });
  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{ ...style, ...(selected ? { strokeWidth: (style?.strokeWidth ?? 2) + 1 } : null) }}
        markerEnd={markerEnd}
      />
      {selected && data?.element && (
        <EdgeLabelRenderer>
          <div
            className="wb-edge-label nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {data.element.type}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

/* ------------------------------------------------------------------ *
 * Registries — frozen at module scope
 * ------------------------------------------------------------------ */

export const nodeTypes = Object.freeze({
  rect: RectNode,
  ellipse: EllipseNode,
  diamond: DiamondNode,
  cylinder: CylinderNode,
  sticky: StickyNode,
  text: TextNode,
  image: ImageNode,
  arrow: ConnectorNode,
  line: ConnectorNode,
});

export const edgeTypes = Object.freeze({
  smoothstep: SmoothEdge,
});

export default nodeTypes;
