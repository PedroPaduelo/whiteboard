/**
 * Pure logic for the React Flow layer.
 *
 * Everything in this file is a plain function over plain data: no JSX, no React,
 * no store, no React Flow. That is deliberate. The rules that keep the flow
 * layer and the canvas from fighting each other are the easiest thing in this
 * app to get subtly wrong, and they are untestable when they are buried in a
 * component. `apps/web/test/flow.test.js` exercises exactly this file.
 */

/**
 * Which flow node component renders an element. Anything not listed here is
 * not a structural element and must not become a node — see `isFlowElement`.
 */
export const NODE_TYPE_BY_ELEMENT = Object.freeze({
  rect: 'box',
  ellipse: 'box',
  diamond: 'box',
  cylinder: 'box',
  sticky: 'sticky',
  text: 'text',
  image: 'box',
});

/**
 * Element flags that promote an element to a flow node.
 *
 * A node is a *structural* view of an element: a container, a frame, a sticky
 * cluster. If every element became a node, the flow layer would be a second
 * canvas fighting the real one over hit-testing, selection and drags. So the
 * default is NO, and an element has to opt in.
 *
 * The authoritative source is the store's `useFlowNodes` selector, which may
 * know about presets and grouping rules we cannot see from here. This predicate
 * is the fallback and the local fast path.
 */
export const FLOW_FLAGS = Object.freeze(['flow', 'container', 'group', 'isContainer']);

/**
 * Is this element a structural element, i.e. does it get a flow node?
 *
 * Exported with the flag list as a second argument so the store's selector can
 * be plugged in without editing this file: pass
 * `(el) => el.type === 'rect' && el.fill === 'none'` and that becomes the rule.
 *
 * @param {any} el
 * @param {(el: any) => boolean} [extraPredicate] store-provided rule
 * @returns {boolean}
 */
export function isFlowElement(el, extraPredicate) {
  if (!el || typeof el !== 'object' || typeof el.id !== 'string') return false;
  if (typeof el.type !== 'string') return false;
  if (typeof extraPredicate === 'function') return extraPredicate(el) === true;
  for (const flag of FLOW_FLAGS) {
    if (el[flag] === true) return true;
  }
  return false;
}

/**
 * Pick the elements that get a node.
 *
 * `selector` is the store's `useFlowNodes`, and its shape is not pinned by the
 * contract: it may be a per-element predicate (`el => boolean`) or a whole-list
 * one (`elements => Element[] | Set`). Both are accepted, because a wrong answer
 * here shows up as a whole class of elements silently vanishing from the
 * structural view — and getting it wrong in the other direction turns the
 * layer into a second canvas.
 *
 * The two are told apart by calling the selector with the real list: a
 * list-shaped selector returns an array/Set, a per-element one returns a
 * boolean (a list has no `.type`, so it answers `false`).
 *
 * @param {any[]} elements
 * @param {Function} [selector]
 * @returns {any[]}
 */
export function selectFlowElements(elements, selector) {
  if (!Array.isArray(elements)) return [];
  if (typeof selector !== 'function') return elements.filter((el) => isFlowElement(el));

  // Flavour A first: it is the one that can be decided once for the whole list.
  try {
    const out = selector(elements);
    if (Array.isArray(out)) {
      const ids = new Set(
        out.filter((e) => e && typeof e === 'object' && typeof e.id === 'string').map((e) => e.id),
      );
      return elements.filter((el) => ids.has(el.id));
    }
    if (out instanceof Set) {
      const ids = new Set(
        [...out].filter((e) => e && typeof e === 'object' && typeof e.id === 'string').map((e) => e.id),
      );
      return elements.filter((el) => ids.has(el.id));
    }
  } catch {
    /* flavour B; fall through */
  }

  // Flavour B: a per-element predicate.
  return elements.filter((el) => {
    try {
      return selector(el) === true;
    } catch {
      return false;
    }
  });
}

/** Glyph name for a flow node type. Shared with the layer panel. */
export const GLYPH_KIND = Object.freeze({
  box: 'box',
  frame: 'frame',
  sticky: 'sticky',
  text: 'text',
});

/** Element type -> flow node type, with a safe default. */
export function nodeTypeFor(el) {
  return NODE_TYPE_BY_ELEMENT[el?.type] ?? 'box';
}

/** A title-ish label for a node/frame, from whatever the element carries. */
export function labelOf(el) {
  if (typeof el?.label === 'string' && el.label) return el.label;
  if (typeof el?.text === 'string' && el.text) return el.text;
  if (typeof el?.title === 'string' && el.title) return el.title;
  return '';
}

/** Hidden is expressed as opacity 0 — never as a deleted element. */
export function isHidden(el) {
  return el?.opacity === 0;
}

/**
 * Build the React Flow node list from the store's elements.
 *
 * `overrides` carries positions for nodes being dragged right now: the drag
 * lives in the DOM, not in the store (the store is only written once, at drag
 * end), so without an override the node would snap back to the stored position
 * on every re-derivation and the drag would fight itself.
 *
 * `selected` comes from the store, never from React Flow: the canvas owns
 * selection, and a second selection state is a second truth.
 *
 * @param {any[]} elements every element on the board, in z-order
 * @param {Object} [opts]
 * @param {Function} [opts.selector] the store's `useFlowNodes`
 * @param {Set<string>|string[]} [opts.selection] store selection
 * @param {Map<string,{x:number,y:number}>} [opts.overrides] live drag positions
 * @returns {any[]} React Flow nodes
 */
export function deriveFlowNodes(elements, opts = {}) {
  const { selector, selection, overrides } = opts;
  const selectedIds =
    selection instanceof Set ? selection : new Set(Array.isArray(selection) ? selection : []);
  const flowElements = selectFlowElements(elements, selector);

  return flowElements.map((el) => {
    const ov = overrides?.get?.(el.id);
    const w = Number.isFinite(el.w) ? Math.max(0, el.w) : 0;
    const h = Number.isFinite(el.h) ? Math.max(0, el.h) : 0;
    return {
      id: el.id,
      type: nodeTypeFor(el),
      position: {
        x: ov ? ov.x : Number.isFinite(el.x) ? el.x : 0,
        y: ov ? ov.y : Number.isFinite(el.y) ? el.y : 0,
      },
      // React Flow reads width/height off the node; without it a container
      // renders as a zero-height sliver and the resizer has nothing to grab.
      width: w,
      height: h,
      style: { width: w, height: h },
      data: {
        elementId: el.id,
        element: el,
        label: labelOf(el),
        hidden: isHidden(el),
        locked: el.locked === true,
        selected: selectedIds.has(el.id),
      },
      // Selection belongs to the canvas; a node that can be selected here would
      // silently deselect on the canvas and vice versa.
      selectable: false,
      connectable: false,
      deletable: false,
      draggable: el.locked !== true,
    };
  });
}

/**
 * A cheap signature of the fields a node actually renders. Deriving nodes is
 * cheap, but re-rendering every node on every store write (remote cursors,
 * hover, marquee, presence…) is not, so the caller re-derives only when this
 * string changes.
 *
 * @param {any[]} nodes nodes from `deriveFlowNodes`
 * @returns {string}
 */
export function flowSignature(nodes) {
  let out = '';
  for (const n of nodes) {
    const d = n.data || {};
    out +=
      `${n.id}|${n.type}|${n.position.x}|${n.position.y}|${n.width}|${n.height}|` +
      `${d.label}|${d.hidden ? 1 : 0}|${d.locked ? 1 : 0}|${d.selected ? 1 : 0}\n`;
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * The two-way ownership rule.
 *
 * The canvas and the flow layer can both move the same element. Whichever
 * interaction STARTED owns it until that interaction ends; the other one only
 * follows. Without this, a canvas drag moves the store, the node re-derives at
 * the new position, React Flow notices its node moved under the pointer and
 * emits a `position` change, we write that back, the node moves again… elements
 * drift away from the cursor one frame at a time.
 * ------------------------------------------------------------------------- */

/** @typedef {'canvas'|'flow'|null} InteractionSource */

/**
 * The owner is a plain ref (not state): it is read and written during a drag,
 * and a re-render between "set" and "read" is exactly the race we are avoiding.
 * @returns {{current: InteractionSource}}
 */
export function createInteractionOwner() {
  return { current: null };
}

/**
 * Claim ownership. Refuses if another source already owns it, so a late
 * `dragStart` from the other layer cannot steal an in-flight interaction.
 * @returns {boolean} true if we now own it
 */
export function beginInteraction(owner, source) {
  if (owner.current && owner.current !== source) return false;
  owner.current = source;
  return true;
}

/** Release ownership, but only if we were the one holding it. */
export function endInteraction(owner, source) {
  if (owner.current === null) return;
  if (source === undefined || owner.current === source) owner.current = null;
}

/** Does `source` currently own the element? */
export function isOwnedBy(owner, source) {
  return owner.current === source;
}

/**
 * May a store-side move update the nodes right now? During a flow drag the
 * answer is no: the drag is the truth until it is committed.
 */
export function acceptsStoreMove(owner) {
  return owner.current === null || owner.current === 'canvas';
}

/**
 * The feedback-loop guard, and the whole reason this file exists.
 *
 * React Flow emits three kinds of `position` change:
 *   - `dragging: true`   — the user is moving the node. Real input, act on it.
 *   - `dragging: false`  — the user let go. Real input, but only for a drag we
 *                          started; otherwise it is a programmatic move.
 *   - `dragging: undefined` — WE moved the node (re-derivation, fitView, a
 *                          peer). Not input. Acting on it is the feedback loop.
 *
 * @param {any} change a React Flow node change
 * @param {Set<string>} draggingIds ids of drags this client started
 * @returns {boolean}
 */
export function shouldApplyPositionChange(change, draggingIds) {
  if (!change || change.type !== 'position' || !change.position) return false;
  if (change.dragging === true) return true;
  if (change.dragging === false) return Boolean(draggingIds?.has?.(change.id));
  return false;
}

/**
 * Apply a React Flow `position` delta to the drag origin.
 *
 * React Flow's `position` change is ALWAYS a delta, never an absolute — this
 * is what `applyNodeChanges` itself does, and a node driven by a different rule
 * than React's is a node that drifts. The drag origin is the base for both
 * kinds of change:
 *   - `dragging: true`  — one frame's movement; it accumulates onto the origin
 *                          frame by frame as the pointer moves,
 *   - `dragging: false` — the total offset from the origin, synthesised by
 *                          React at drag end.
 *
 * @param {{x?:number,y?:number}} delta
 * @param {{x:number,y:number}} origin where the drag began
 * @returns {{x:number,y:number}} absolute board position
 */
export function absoluteFromDelta(delta, origin) {
  const dx = Number.isFinite(delta?.x) ? delta.x : 0;
  const dy = Number.isFinite(delta?.y) ? delta.y : 0;
  return { x: origin.x + dx, y: origin.y + dy };
}

/**
 * Turn a batch of position changes into store patches, one per moved id.
 * Non-position changes (`select`, `dimensions`, `remove`) return nothing:
 * selection is the canvas's, dimensions are ours, and removal is the store's
 * delete path.
 *
 * @param {any[]} changes
 * @param {(id: string) => {x:number,y:number}|undefined} startAt where the drag began
 * @param {Set<string>} draggingIds
 * @param {(id: string, pos: {x:number,y:number}) => void} [advance] called with
 *   every new absolute position, so the caller can track the running value
 * @returns {{id:string,x:number,y:number}[]}
 */
export function planMovePatches(changes, startAt, draggingIds, advance) {
  const out = [];
  const seen = new Set();
  if (!Array.isArray(changes)) return out;
  for (const change of changes) {
    if (!shouldApplyPositionChange(change, draggingIds)) continue;
    if (seen.has(change.id)) continue;
    const origin = startAt(change.id);
    if (!origin) continue;

    // React Flow reports `position` as a DELTA, never as an absolute. The
    // origin is the base for both kinds of change:
    //   - `dragging: true`  — one frame's delta from the previous position, so
    //                          it accumulates onto the origin frame by frame;
    //   - `dragging: false` — the TOTAL offset from the origin, synthesised by
    //                          React, so it is also origin-relative.
    // React's own `applyNodeChanges` uses exactly these two bases, and a node
    // driven by a different rule than React's is a node that drifts.
    const abs = absoluteFromDelta(change.position, origin);
    seen.add(change.id);
    advance?.(change.id, abs);
    out.push({ id: change.id, x: abs.x, y: abs.y });
  }
  return out;
}

/**
 * z-order list rows, newest layer first (index 0 of `elements` is furthest
 * back, and a layer panel reads top-of-stack-first).
 *
 * @param {any[]} elements
 * @returns {any[]}
 */
export function toLayerOrder(elements) {
  if (!Array.isArray(elements)) return [];
  return elements.slice().reverse();
}

/**
 * Move one row and return the exact new id order. Pure — the caller passes the
 * result straight to the store's `reorder(orderedIds)`.
 *
 * @param {string[]} orderedIds
 * @param {number} from index
 * @param {number} to index
 * @returns {string[]}
 */
export function reorderIds(orderedIds, from, to) {
  if (!Array.isArray(orderedIds)) return [];
  const n = orderedIds.length;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return orderedIds.slice();
  if (from < 0 || from >= n || to < 0 || to >= n || from === to) return orderedIds.slice();
  const out = orderedIds.slice();
  const [moved] = out.splice(from, 1);
  out.splice(to, 0, moved);
  return out;
}
