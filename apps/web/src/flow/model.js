/**
 * model.js — the pure mapping between board elements and React Flow objects.
 *
 * This module is the ONLY place that decides what a React Flow node is and
 * what a React Flow edge is. Nothing here imports React, touches the DOM, or
 * reads the store, which is what makes the whole migration testable in node
 * without a browser.
 *
 * ## Why arrows are split across two representations
 *
 * `validateElement` (packages/shared) RECOMPUTES `x/y/w/h` from `points` on
 * every write and every read, and requires `points.length === 2`. `points` is
 * not a cache — it is the source of truth, and anything that reads the board
 * back gets the box re-derived from it.
 *
 * A React Flow edge cannot honour that: an edge names a `source` and a
 * `target` node and lets React Flow compute the path from handle positions.
 * There is no way to hand it arbitrary `points`. Worse, an edge needs BOTH
 * ends, and the most common connector gesture — dragging one arrow end onto a
 * box — produces a HALF-bound connector that no edge can represent.
 *
 * So: a connector with both ends bound to live elements becomes an edge; a
 * free or half-bound connector stays a NODE whose `points` are edited
 * directly, with no reconciliation at all. `isEdgeElement` is the predicate
 * that decides, and it is the only such predicate in the codebase.
 *
 * ## The feedback-loop guard
 *
 * `points` stays authoritative for edges by being derived ONCE, at the end of
 * a gesture, not per frame. During a node drag React Flow redraws the edge
 * from its own geometry and we write nothing. `planGestureEndPatches` then
 * computes, in the same batch as the node's own move, which attached
 * connectors actually changed — so dragging a box with three inbound arrows
 * sends three updates, not thirty, and dragging it with none attached sends
 * one.
 */

/** Element types that become React Flow nodes. `pen` is deliberately absent:
 *  a freehand stroke is not a node — it has no fixed box to lay out. */
export const NODE_ELEMENT_TYPES = Object.freeze([
  'rect',
  'ellipse',
  'diamond',
  'cylinder',
  'sticky',
  'text',
  'image',
  'arrow',
  'line',
]);

/** `type` on a node, which is the element type verbatim. Kept as an explicit
 *  map so a future element type is one line, and so the node components can
 *  assert the map is exhaustive. */
export const NODE_TYPE_BY_ELEMENT = Object.freeze(
  Object.fromEntries(NODE_ELEMENT_TYPES.map((t) => [t, t])),
);

/** How far a connector endpoint may drift before we bother syncing it, in
 *  board units. Sub-unit jitter is invisible and would produce a network op
 *  per frame for a user who is merely nudging a box. */
export const POINTS_EPSILON = 0.5;

const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

/**
 * Is this a label sitting on top of a shape?
 *
 * A label is decoration: the thing a user grabs is the shape underneath.
 * React Flow hit-tests its node list in order, so an interactive label on top
 * of a box wins the drag — the box does not move and the label flies off,
 * which reads as "the drag landed on the wrong thing".
 *
 * The fix has to be the node's own flags, not CSS. React Flow writes
 * `pointer-events: all` inline on every node, and an inline style beats any
 * stylesheet, so a `pointer-events: none` rule is silently ignored — three CSS
 * attempts confirmed that before the inline style was actually checked.
 *
 * @param {object} el
 * @returns {boolean}
 */
export function isLabelElement(el) {
  return Boolean(el?.id && String(el.id).endsWith('-lbl'));
}

/**
 * The stacking order for a node.
 *
 * Bands rather than a running counter, so a board of any size orders without
 * renumbering: shapes 10, labels 20 (above the shape they annotate), selected
 * 100 (above everything, so a selection is always grabbable).
 *
 * @param {object} el
 * @param {boolean} selected
 * @returns {number}
 */
export function zIndexFor(el, selected) {
  if (selected) return 100;
  if (isLabelElement(el)) return 20;
  if (el?.type === 'text') return 20; // free text is decoration over a shape
  return 10;
}

/**
 * Should this connector be rendered as a React Flow EDGE?
 *
 * True only when both ends are bound AND both anchors are still live. A
 * dangling `startId` (the box was deleted) makes it a node instead, because
 * an edge pointing at a non-existent node is an error React Flow throws on.
 *
 * @param {object} el  the element
 * @param {Set<string>|Map<string,unknown>} liveIds  ids of live elements
 * @returns {boolean}
 */
export function isEdgeElement(el, liveIds) {
  if (!el || (el.type !== 'arrow' && el.type !== 'line')) return false;
  if (!el.startId || !el.endId) return false;
  const has = (id) =>
    liveIds instanceof Set ? liveIds.has(id) : liveIds instanceof Map ? liveIds.has(id) : false;
  return has(el.startId) && has(el.endId);
}

/** Every live element id — the `liveIds` both `isEdgeElement` and
 *  `toFlowNodes` want. One pass, not one per element. */
export function liveIdSet(elements) {
  const s = new Set();
  for (const el of elements) if (el && el.id) s.add(el.id);
  return s;
}

/**
 * The minimap colour for an element, decided ONCE here rather than in the
 * MiniMap callback.
 *
 * The minimap renders every node regardless of `onlyRenderVisibleElements`,
 * so its per-node callback runs for all of them on every frame. Reading one
 * precomputed property is the difference between a minimap that is free and
 * one that re-derives the whole board to paint 200 tiny squares.
 *
 * @returns {string} a CSS colour
 */
export function minimapColorFor(el) {
  if (!el) return 'var(--color-border-strong)';
  // A filled shape is identifiable by its fill; an unfilled one only has its
  // outline, so the outline colour is the honest answer.
  if (el.type === 'sticky') return el.fill || 'var(--color-warning)';
  if (el.type === 'text') return 'var(--color-text-muted)';
  if (el.type === 'arrow' || el.type === 'line') return el.stroke || 'var(--draw-default-stroke)';
  if (el.fill && el.fill !== 'none') return el.fill;
  return 'var(--color-border-strong)';
}

/**
 * All React Flow nodes for a board.
 *
 * Excludes `pen` (not a node) and bound connectors (those are edges). Node ids
 * ARE element ids, unchanged — which is what makes the round-trip
 * element -> node -> element lossless and lets `sync.js` keep diffing the flat
 * element array it already understands.
 *
 * @param {object[]} elements
 * @param {object} [opts]
 * @param {Set<string>|string[]} [opts.selection]
 * @param {Map<string,{x:number,y:number}>} [opts.overrides] live drag positions
 * @param {string} [opts.editingId] element whose text editor is open
 * @returns {object[]} nodes, in z-order
 */
export function toFlowNodes(elements, opts = {}) {
  const { selection, overrides, editingId, resizingId, onResizeStart, onResizeEnd, liveSize } = opts;
  const resizeOf = resizingId ?? null;
  const selectedIds =
    selection instanceof Set ? selection : new Set(Array.isArray(selection) ? selection : []);
  const live = liveIdSet(elements);

  // Boxes of anything that can be a parent, so a grouped child can convert its
  // absolute position into the relative one React Flow wants.
  const parentBoxes = new Map();
  for (const el of elements) {
    if (el && el.id) parentBoxes.set(el.id, { x: num(el.x), y: num(el.y), w: num(el.w), h: num(el.h) });
  }

  const nodes = [];
  for (const el of elements) {
    if (!el || !NODE_TYPE_BY_ELEMENT[el.type]) continue; // pen and unknown types
    if (isEdgeElement(el, live)) continue; // rendered as an edge

    const ov = overrides?.get?.(el.id);
    const w = Math.max(0, num(el.w));
    const h = Math.max(0, num(el.h));
    const nodeType = NODE_TYPE_BY_ELEMENT[el.type];
    /* React Flow's per-frame measurement for this node, while a resize runs.
       In a CONTROLLED flow it is delivered as a `dimensions` change that
       nothing applies, so the node component has to be handed it explicitly
       — without it the wrapper keeps the stored size and the box never
       visibly grows even though the drag computed a new one.

       Only the node actually being resized honours it. The ResizeObserver
       emits a `dimensions` change for every node whose measured size differs
       at all, and honouring those would pin a node to its measured box and
       let it drift away from the stored w/h the backend persists. */
    const liveBox = resizeOf === el.id ? liveSize?.get?.(el.id) || null : null;

    // A grouped child stores ABSOLUTE coordinates like every other element,
    // but React Flow expects a grouped node's position to be RELATIVE to its
    // parent. The conversion is done here, once, in the only place that maps
    // elements to nodes — and undone on the way back. The alternative,
    // storing relative coordinates in the element, would mean moving a group
    // rewrites every child's stored position: a write per child on every drag,
    // and a resync for every peer watching.
    let px = ov ? num(ov.x) : num(el.x);
    let py = ov ? num(ov.y) : num(el.y);
    if (el.groupId) {
      const parent = parentBoxes.get(el.groupId);
      if (parent) {
        px -= parent.x;
        py -= parent.y;
      }
    }

    nodes.push({
      id: el.id,
      type: nodeType,
      position: { x: px, y: py },
      // BOTH `width/height` and `style` are set deliberately. React Flow
      // measures a node from the DOM, and a node sized only by its content
      // will not match the store's w/h — a sticky with a long label wraps
      // differently in a div than it did on the canvas, and w/h is what the
      // backend stores and what `export.js` draws.
      width: w,
      height: h,
      /* `width`/`height` are the STORED size; `style` tracks the LIVE one.
         Dropping the style while a resize runs does not work, and the reason
         is worth keeping: the node component sizes its OWN inner wrapper from
         `data.w/h`, and that div is what `offsetWidth` measures. React Flow
         pushes a new size onto the wrapper's style, but the inner div is
         still pinned to the stored size, so the box cannot grow no matter what
         React Flow asks for. The pin has to MOVE, not disappear — and the
         measurement has to be handed down to the node component too. */
      style: { width: liveBox ? liveBox.w : w, height: liveBox ? liveBox.h : h },
      data: {
        elementId: el.id,
        element: el,
        minimapColor: minimapColorFor(el),
        editing: editingId != null && editingId === el.id,
        // Cached rather than computed in the node, so hot paths stay cheap.
        w,
        h,
        // React Flow's per-frame measurement, non-null only mid-resize.
        liveW: liveBox ? liveBox.w : undefined,
        liveH: liveBox ? liveBox.h : undefined,
        rotation: num(el.rotation),
        stroke: el.stroke || 'var(--draw-default-stroke)',
        fill: el.fill || 'none',
        strokeWidth: num(el.strokeWidth, 2),
        strokeStyle: el.strokeStyle || 'solid',
        locked: el.locked === true,
        selected: selectedIds.has(el.id),
        onResizeStart,
        onResizeEnd,
      },
      // `selected` is a TOP-LEVEL React Flow field, not something it reads out
      // of `data`. Without it here the marquee has no idea what it caught, the
      // selection styling never appears, and a drag selects nothing — the
      // symptom is a marquee that draws a rectangle and selects nothing.
      selected: selectedIds.has(el.id),
      // Z-order, set HERE rather than in CSS: React Flow writes `z-index: 0`
      // inline on every node, and an inline style beats any stylesheet, so a
      // CSS rule for it is silently ignored.
      //
      // A label sitting on top of a shape is the common case, and without this
      // the LABEL is what a drag picks up: the shape stays put and the label
      // flies off, which reads as "the drag landed on the wrong thing".
      zIndex: zIndexFor(el, selectedIds.has(el.id)),
      // Group membership, as React Flow's own nesting. `parentId` makes the
      // node a CHILD in flow coordinates, so the child stores its position
      // relative to the parent, and `extent: 'parent'` keeps it inside the
      // frame. Both only apply when the parent is itself a node on the board.
      parentId: el.groupId || undefined,
      extent: el.groupId ? 'parent' : undefined,
      expandParent: false,
      draggable: el.locked !== true && !isLabelElement(el),
      selectable: !isLabelElement(el),
      connectable: !isLabelElement(el),
      deletable: !isLabelElement(el),
    });
  }
  return nodes;
}

/**
 * All React Flow edges for a board.
 *
 * `markerEnd` is present if and only if the element is an `arrow`, so the
 * `line` vs `arrow` distinction survives the round trip. `data.element`
 * carries the whole element; `data` is React Flow's own field and never
 * reaches the wire, so this adds nothing to the stored shape.
 *
 * @param {object[]} elements
 * @returns {object[]}
 */
export function toFlowEdges(elements) {
  const live = liveIdSet(elements);
  const edges = [];
  for (const el of elements) {
    if (!isEdgeElement(el, live)) continue;
    edges.push({
      // Prefixed so an edge id can never collide with a node id — React Flow
      // keeps nodes and edges in one map keyed by id.
      id: `edge:${el.id}`,
      source: el.startId,
      target: el.endId,
      // `smoothstep` matches the orthogonal dogleg heritage already in
      // `routeOrthogonal` (shared/geometry.js): a flowchart that routes in
      // right angles rather than spaghetti.
      type: 'smoothstep',
      markerEnd: el.type === 'arrow' ? { type: 'arrowclosed' } : undefined,
      style: {
        stroke: el.stroke || 'var(--draw-default-stroke)',
        strokeWidth: num(el.strokeWidth, 2),
        strokeDasharray:
          el.strokeStyle === 'dashed' ? '6 4' : el.strokeStyle === 'dotted' ? '2 4' : undefined,
      },
      data: { elementId: el.id, element: el },
      selectable: true,
      deletable: true,
    });
  }
  return edges;
}

/**
 * A cheap signature of everything a node or edge actually RENDERS.
 *
 * This gate is not optional. The store writes on every remote cursor, hover,
 * marquee tick and presence change, so re-deriving without comparing would
 * re-render the whole node tree on each peer's mouse move.
 *
 * The old signature (derive.js) covered label/hidden/locked/selected but not
 * type, dimensions or minimap colour — which is exactly the case of two
 * boards that differ in only those fields reporting "unchanged".
 *
 * @param {object[]} nodes
 * @param {object[]} [edges]
 * @returns {string}
 */
export function boardSignature(nodes, edges = []) {
  let out = '';
  for (const n of nodes) {
    const d = n.data || {};
    out +=
      `N${n.id}|${n.type}|${n.position.x},${n.position.y}|${n.width}x${n.height}|${n.zIndex}|` +
      `${d.liveW ?? ''}x${d.liveH ?? ''}|` +
      `${n.selected ? 1 : 0}${d.editing ? 1 : 0}${d.locked ? 1 : 0}|` +
      `${d.fill}|${d.stroke}|${d.strokeWidth}|${d.strokeStyle}|${d.rotation}|${d.minimapColor}|${n.parentId ?? ''}\n`;
  }
  for (const e of edges) {
    out += `E${e.id}|${e.source}>${e.target}|${e.type}|${e.markerEnd ? 1 : 0}\n`;
  }
  return out;
}

/** Do two polylines differ by more than the epsilon? */
function pointsDiffer(a, b, eps = POINTS_EPSILON) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return true;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(num(a[i]?.x) - num(b[i]?.x)) > eps) return true;
    if (Math.abs(num(a[i]?.y) - num(b[i]?.y)) > eps) return true;
  }
  return false;
}

/**
 * The patches to write when a node drag ENDS.
 *
 * Called once, from `onNodeDragStop`, in the same batch as the node's own
 * move. Two things happen here:
 *
 *  1. One patch per moved node, `{x, y}` absolute — NOT the React Flow delta.
 *     A `position` change is a delta from the drag origin; applying it as
 *     absolute makes the node drift one frame further from the cursor on
 *     every move.
 *  2. One patch per ATTACHED CONNECTOR whose endpoints actually moved,
 *     recomputed by `resolveConnectors` from shared/geometry.js — the same
 *     function the server uses, so client and server agree on where an arrow
 *     points. Connectors whose anchors did not move produce nothing, which is
 *     what keeps a three-arrow box at three ops instead of thirty.
 *
 * @param {Array<{id:string, position:{x:number,y:number}}>} movedNodes
 * @param {object[]} elements  the current board elements
 * @param {(els:object[]) => object[]} [resolveConnectors] injectable for tests
 * @returns {Array<{id:string, patch:object}>} patches, nodes first
 */
export function planGestureEndPatches(movedNodes, elements, resolveConnectors) {
  const patches = [];
  if (!Array.isArray(movedNodes) || movedNodes.length === 0) return patches;

  const byId = new Map((elements || []).map((el) => [el.id, el]));

  // 1. The nodes themselves, in ABSOLUTE board units.
  //
  // React Flow reports a grouped node's position RELATIVE to its parent, but
  // the element stores absolute — so the parent's position is added back here.
  // Forgetting this writes a child at (50,50) instead of (150,150) the moment
  // it is dragged, and it only shows up for grouped elements, so it survives a
  // long time before anyone notices.
  const parents = new Map();
  for (const el of elements || []) {
    if (el && el.id) parents.set(el.id, { x: num(el.x), y: num(el.y) });
  }
  for (const n of movedNodes) {
    if (!n || !n.id) continue;
    const el = byId.get(n.id);
    const parent = el?.groupId ? parents.get(el.groupId) : null;
    patches.push({
      id: n.id,
      patch: {
        x: num(n.position?.x) + (parent?.x ?? 0),
        y: num(n.position?.y) + (parent?.y ?? 0),
      },
    });
  }

  if (typeof resolveConnectors !== 'function') return patches;

  // 2. Apply the moves to a copy, then let resolveConnectors re-derive every
  //    attached connector. Comparing against the STORED points afterwards is
  //    what filters out the connectors that did not actually change.
  const movedIds = new Set(movedNodes.map((n) => n?.id).filter(Boolean));
  const next = elements.map((el) => {
    const m = movedIds.has(el.id) ? movedNodes.find((n) => n.id === el.id) : null;
    return m ? { ...el, x: num(m.position?.x), y: num(m.position?.y) } : el;
  });

  const resolved = resolveConnectors(next) || next;
  for (const after of resolved) {
    if (after.type !== 'arrow' && after.type !== 'line') continue;
    const before = byId.get(after.id);
    if (!before) continue;
    if (!pointsDiffer(before.points, after.points)) continue; // did not move
    patches.push({ id: after.id, patch: { points: after.points } });
  }

  return patches;
}
