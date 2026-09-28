/**
 * Shared contract between apps/api (Node + Fastify) and apps/web (React + Vite).
 *
 * This module is the single source of truth for the wire format. Both sides
 * import from `@whiteboard/shared`; neither may re-declare these shapes.
 *
 * Scene model
 * -----------
 * A board is a flat, ordered list of elements. Order is significant: index in
 * `elements` IS the z-order (index 0 paints first, i.e. furthest back).
 * Every element carries a client-generated `id`; the server treats ids as
 * opaque and never rewrites them, so optimistic UI and server state agree.
 *
 * Coordinates are "board units" in a right-handed space: x grows right, y
 * grows DOWN (screen convention, matching DOM and canvas). Negative values are
 * legal (the canvas is infinite); there is no origin corner to fight.
 */

/** @typedef {'rect'|'ellipse'|'diamond'|'cylinder'|'sticky'|'text'|'arrow'|'line'|'pen'|'image'} ElementType */
export const ELEMENT_TYPES = Object.freeze([
  'rect',
  'ellipse',
  'diamond',
  'cylinder',
  'sticky',
  'text',
  'arrow',
  'line',
  'pen',
  'image',
]);

/** Line-ending styles, mirroring the reference whiteboard. */
export const STROKE_STYLES = Object.freeze(['solid', 'dashed', 'dotted']);

/*
 * Hand-drawn style enums (the Excalidraw look). Every one of these fields is
 * OPTIONAL on an element, so boards saved before they existed stay valid; the
 * renderer supplies the documented default when a field is absent.
 */

/** roughjs fill patterns. Absent = 'solid' (legacy fills were solid). */
export const FILL_STYLES = Object.freeze(['hachure', 'cross-hatch', 'solid', 'zigzag']);

/** Corner style. Absent = 'sharp'. */
export const ROUNDNESS = Object.freeze(['sharp', 'round']);

/** Font family KEYS stored on the element; the web maps them to CSS stacks.
 *  'hand' is the handwritten Virgil font. Absent = 'hand'. */
export const FONT_FAMILY_KEYS = Object.freeze(['hand', 'normal', 'code']);

/** Horizontal text alignment, for text elements and labels inside shapes. */
export const TEXT_ALIGNS = Object.freeze(['left', 'center', 'right']);

/** Connector end decorations. Absent: arrow = none -> arrow, line = none -> none. */
export const ARROWHEADS = Object.freeze(['none', 'arrow', 'triangle', 'bar', 'dot']);

/** roughjs `roughness` range: 0 architect, 1 artist, 2 cartoonist. Absent = 1. */
export const ROUGHNESS_RANGE = Object.freeze({ min: 0, max: 2 });

/** roughjs `seed` range: a non-negative 31-bit integer. Absent = FNV-1a(id). */
export const SEED_MAX = 2147483647;

/** Shape fills offered by the UI. `none` is a first-class value, not absence. */
export const FILL_PRESETS = Object.freeze([
  'none',
  '#ffffff',
  '#fde68a', // sticky yellow
  '#bbf7d0',
  '#bfdbfe',
  '#fbcfe8',
  '#e9d5ff',
  '#fed7aa',
]);

export const STROKE_PRESETS = Object.freeze([
  '#1f2937',
  '#ef4444',
  '#f97316', // Claude's ink
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#a855f7',
  '#ec4899',
]);

/** Default palette offered on first use, mirrored by the web toolbar. */
export const DEFAULT_PALETTE = Object.freeze({
  stroke: '#1f2937',
  fill: 'none',
  strokeWidth: 2,
  strokeStyle: 'solid',
  stickyFill: '#fde68a',
  claudeInk: '#f97316',
});

/**
 * Point on a freehand pen stroke. Stored flat and terse because pen strokes
 * are by far the most numerous element kind — every byte is paid per point,
 * per element, per sync message.
 * @typedef {{x: number, y: number}} Point
 */

/**
 * Fields every element carries.
 *
 * `x/y/w/h` are the axis-aligned bounding box of the element, always present
 * and always tight, EVEN FOR ROTATED ELEMENTS. Rotation happens at paint time
 * around the box centre, so geometry, hit-testing, snapping and export all have
 * a single rectangular source of truth. `rotation` is in radians.
 *
 * @typedef {Object} ElementBase
 * @property {string} id        Client-generated, opaque, stable forever.
 * @property {ElementType} type
 * @property {number} x         Left edge of the tight bounding box, board units.
 * @property {number} y         Top edge of the tight bounding box.
 * @property {number} w         Width; always >= 0.
 * @property {number} h         Height; always >= 0.
 * @property {number} [rotation] Radians, clockwise, about the box centre.
 * @property {string} [stroke]  CSS colour, or undefined for no outline.
 * @property {string} [fill]    CSS colour, or 'none'.
 * @property {number} [strokeWidth]
 * @property {'solid'|'dashed'|'dotted'} [strokeStyle]
 * @property {number} [opacity] 0..1
 * @property {boolean} [locked]
 * @property {string} [groupId]   Opaque group key; same key = select/move/delete together.
 * @property {number} [seed]      roughjs seed, integer 0..SEED_MAX.
 * @property {number} [roughness] 0..2 (0 architect, 1 artist, 2 cartoonist).
 * @property {'hachure'|'cross-hatch'|'solid'|'zigzag'} [fillStyle]
 * @property {'sharp'|'round'} [roundness]
 * @property {string} [authorId]
 * @property {number} [createdAt] Unix ms.
 * @property {number} [updatedAt] Unix ms.
 */

/**
 * Text styling carried by text elements AND by shapes that show a label.
 * @typedef {Object} TextStyle
 * @property {'hand'|'normal'|'code'} [fontFamily]
 * @property {number} [fontSize]  4..512
 * @property {'left'|'center'|'right'} [align]
 */

/**
 * @typedef {ElementBase & TextStyle & {type:'rect'|'ellipse'|'diamond'|'cylinder', label?: string}} ShapeElement
 *   `cylinder` is a database drum. `label` is the text shown INSIDE the shape
 *   (double-click to edit), laid out with the TextStyle fields; `fontSize` has
 *   no default here, the renderer picks one.
 */

/** @typedef {ElementBase & TextStyle & {type:'sticky', label: string}} StickyElement */
/** @typedef {ElementBase & TextStyle & {type:'text', text: string, fontSize: number}} TextElement */
/** @typedef {ElementBase & {type:'pen', points: Point[]}} PenElement */
/** @typedef {ElementBase & {type:'image', src: string, naturalWidth?: number, naturalHeight?: number}} ImageElement */

/**
 * Connectors. The path lives in `points` (2..LIMITS.MAX_POINTS, ABSOLUTE board
 * coordinates, first = start, last = end) rather than in dedicated fields so
 * both pen and connector code paths share one "polyline" reader. The bounding
 * box is derived from those points, which is why a connector can have `w`/`h`
 * of 0 (a perfectly horizontal line) and why a connector's `x` is NOT
 * necessarily 0.
 *
 * When `startId`/`endId` are set the first/last point follows that element's
 * outline as it moves (see `resolveConnectors`); interior points never move
 * by binding. In an update patch `startId: null` / `endId: null` unbinds.
 *
 * @typedef {ElementBase & {
 *   type:'arrow'|'line',
 *   points: Point[],
 *   startId?: string,
 *   endId?: string,
 *   startArrowhead?: 'none'|'arrow'|'triangle'|'bar'|'dot',
 *   endArrowhead?: 'none'|'arrow'|'triangle'|'bar'|'dot',
 * }} ConnectorElement
 */

/** @typedef {ShapeElement|StickyElement|TextElement|PenElement|ImageElement|ConnectorElement} Element */

/** @typedef {ElementType} Tool
 *   The active drawing tool. `select` and `hand` are modes, not element kinds.
 *   `eraser` deletes on click/drag.
 *   The ten drawing tools map 1:1 onto element types (`image` places a picked
 *   file). The server only records presence `activity` tools listed here.
 */

export const TOOLS = Object.freeze([
  'select',
  'hand',
  'pen',
  'rect',
  'ellipse',
  'diamond',
  'cylinder',
  'sticky',
  'text',
  'arrow',
  'line',
  'eraser',
  'image',
]);

/** Tools that place a new element of their own kind (i.e. not modes). */
export const DRAWING_TOOLS = Object.freeze(
  TOOLS.filter((t) => t !== 'select' && t !== 'hand' && t !== 'eraser'),
);

/** @typedef {'light'|'dark'} Theme */

/**
 * @typedef {Object} Board
 * @property {string} id
 * @property {string} title
 * @property {Theme} theme
 * @property {number} rev          Monotonic; bumps on every accepted mutation.
 * @property {number} [createdAt]  Unix ms.
 * @property {number} [updatedAt]  Unix ms.
 * @property {string|null} [ownerId]
 */

/**
 * The full board payload the client hydrates from: metadata plus the ordered
 * element list. Returned by `GET /api/boards/:id`.
 * @typedef {Object} BoardSnapshot
 * @property {Board} board
 * @property {Element[]} elements  In z-order, index 0 painted first.
 * @property {number} rev
 */

/**
 * The unit of mutation and of replication. Ops are small, ordered, and
 * idempotent-by-id: applying the same op twice is a no-op.
 *
 * `rev` is assigned by the SERVER on persist. `baseRev` is OPTIONAL: an op
 * that carries it is rejected (with the whole batch) if the board moved
 * underneath it; an op without it is last-writer-wins per element, which is
 * safe because an update is a shallow merge of the fields it names. Realtime
 * edits omit it.
 *
 * @typedef {Object} Op
 * @property {string} opId      Client-generated unique id; the server dedupes on it.
 * @property {string} boardId
 * @property {'create'|'update'|'delete'|'reorder'|'clear'} kind
 * @property {string} [elementId]  Required for update/delete.
 * @property {Element} [element]   Required for create.
 * @property {Partial<Element>} [patch]  Shallow-merged onto the element for update.
 * @property {string[]} [order]   Full element-id order for `reorder`.
 * @property {number} [baseRev]   Client's known rev; server 409s on mismatch.
 * @property {string} [actorId]
 * @property {number} [at]        Unix ms.
 */

/** Server's answer to a batch of ops. */
export const OP_RESULT = Object.freeze({
  /** The batch was persisted (rev bumped once). */
  APPLIED: 'applied',
  /** Every opId had already been applied: a harmless retry, rev unchanged. */
  DUPLICATE: 'duplicate',
  /** An op carried a stale `baseRev`; nothing changed. Resync. */
  CONFLICT: 'conflict',
  /** The board does not exist (deleted under you). */
  MISSING: 'missing',
  /** The batch was rejected (invalid op, duplicate id, limit, server fault);
   *  nothing changed. WebSocket acks only — REST answers with an HTTP error. */
  ERROR: 'error',
});

/**
 * The answer to one op batch: the `result` of a WS `ack`, and the body of
 * `POST /boards/:id/ops` (REST adds `elements`).
 *
 * @typedef {Object} OpResult
 * @property {'applied'|'duplicate'|'conflict'|'missing'|'error'} status  One of OP_RESULT.
 * @property {number} [rev]         The board's rev AFTER the batch (current rev on conflict).
 * @property {string[]} [applied]   opIds of this batch the server now holds — applied
 *   by this batch OR by an earlier delivery of the same opId. Present on
 *   'applied' and 'duplicate'; a client drops exactly these from its outbox.
 * @property {Op[]} [appliedOps]    The ops that took effect in THIS batch (validated,
 *   `actorId` filled in); [] on duplicate/conflict/missing.
 * @property {Element[]} [elements] REST only: the board's full element list after
 *   the batch. The WS ack omits it (it would cost O(board) per drag frame).
 * @property {string} [message]     Human-readable reason, for conflict/missing/error.
 * @property {string} [code]        Machine-readable reason, for 'error'
 *   ('VALIDATION_FAILED', 'DUPLICATE_ELEMENT', 'TOO_MANY_ELEMENTS', 'INVALID_OP', 'INTERNAL').
 */

/** Real-time protocol. Envelope shared by server and client. */
export const WS_MSG = Object.freeze({
  /** client -> server: join a board room. */
  JOIN: 'join',
  /** server -> client: board state + your peer id. */
  READY: 'ready',
  /** client -> server: a batch of ops to persist and fan out. */
  OPS: 'ops',
  /** server -> client: ops from another peer (your own are never echoed over
   *  WS; ops written over REST reach every socket in the room). */
  OP_BROADCAST: 'op',
  /** server -> client: result of your own batch. */
  OP_ACK: 'ack',
  /** client -> server: pointer moved. Throttled, never persisted. */
  CURSOR: 'cursor',
  /** server -> client: someone else's pointer. */
  CURSOR_BROADCAST: 'peer-cursor',
  /** client -> server: I am typing/dragging (temporary lock-ish signal). */
  ACTIVITY: 'activity',
  /** server -> client: the peer roster changed. */
  PRESENCE: 'presence',
  /** client -> server: I am alive. Server drops peers silent past a TTL. */
  PING: 'ping',
  /** server -> client: your batch conflicted or the board is gone; resync via
   *  GET. Sent ONLY to the peer whose batch failed, never to the room. */
  RESYNC: 'resync',
  /** server -> client: board metadata changed (title/theme/owner), payload
   *  `{type:'board', boardId, board}`. */
  BOARD: 'board',
  /** server -> client: a protocol-level failure, `{type:'error', text, code?}`. */
  ERROR: 'error',
  /** either way: the connection is going away. */
  BYE: 'bye',
});

/**
 * @typedef {Object} Peer
 * @property {string} id
 * @property {string} name
 * @property {string} color     Stable per-peer colour, assigned by the server.
 * @property {number} [lastSeen] Unix ms.
 * @property {string} [tool]     Current tool, shown in the roster.
 */

/**
 * @typedef {Object} WSEnvelope
 * @property {string} type       One of WS_MSG.
 * @property {string} [boardId]
 * @property {string} [peerId]
 * @property {Op[]} [ops]
 * @property {OpResult} [result]
 * @property {{x:number,y:number}} [cursor]   Board units, not screen pixels.
 * @property {Peer[]} [peers]
 * @property {Board} [board]      `ready` and `board` messages.
 * @property {number} [rev]
 * @property {string} [text]
 * @property {number} [at]
 */

/** Viewport transform: screen = board * zoom + pan. */
export const IDENTITY_VIEW = Object.freeze({ zoom: 1, panX: 0, panY: 0 });

/** Default and minimum grid spacing, in board units. */
export const GRID = Object.freeze({ defaultSize: 20, min: 4, max: 200 });

/** Zoom clamps. */
export const ZOOM_LIMITS = Object.freeze({ min: 0.05, max: 8 });

/** Request/response bodies that cross the wire as JSON. */
export const API = Object.freeze({
  HEALTH: '/api/health',
  BOARDS: '/api/boards',
  BOARD: (id) => `/api/boards/${id}`,
  BOARD_OPS: (id) => `/api/boards/${id}/ops`,
  BOARD_SNAPSHOT: (id) => `/api/boards/${id}/snapshot`,
  WS: '/api/ws',
});
