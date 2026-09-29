# API contract — apps/api

Authoritative for the backend. The element model and wire constants live in
`@whiteboard/shared` (`packages/shared/src`); this document describes how the
API stores, validates and fans them out. Do not change an interface without
changing it here first. The web editor's side of the contract is
`docs/EDITOR_CONTRACT.md`.

All routes are prefixed with the app's own prefix from `config.js`
(`API_PREFIX`, default `/api`). `@whiteboard/shared` is imported by path
(`@whiteboard/shared` resolves via the npm workspace).

## Modules

| File | Purpose |
| --- | --- |
| `src/config.js` | env parsing (plus `apps/api/.env` when present), single source of runtime config (frozen) |
| `src/store/index.js` | `createStore({storage, sqlitePath, opDedupeTtlMs})` picks a driver |
| `src/store/sqlite.js` | `node:sqlite` driver + schema |
| `src/store/memory.js` | in-memory driver, same interface (tests/dev) |
| `src/store/ops.js` | `applyOpBatch`: the batch rules, shared by both drivers |
| `src/routes/boards.js` | REST: boards CRUD + snapshot, `board` broadcast on PATCH, room eviction on DELETE |
| `src/routes/ops.js` | REST: op batch apply, board-wide clear |
| `src/ws/hub.js` | presence, rooms, fan-out (framework-free) |
| `src/ws/plugin.js` | `@fastify/websocket` wiring (registered unencapsulated via `fastify-plugin`) |
| `src/plugins/*.js` | cors, error handler, health |
| `src/server.js` | `storeOptions`/`hubOptions` from config, demo seed, listen, graceful shutdown |
| `test/*.test.js` | `node --test` (validate, geometry, store ×2 drivers, ws, routes, server) |

Every bare package the API imports is declared in `apps/api/package.json`
(`test/server.test.js` enforces it), so a production `npm install
--omit=dev` never depends on workspace hoisting.

## Element model (summary of `@whiteboard/shared`)

A board is an ordered element list; index = z-order (0 paints first). Types:
`rect ellipse diamond cylinder sticky text arrow line pen image`. Required on
every element: `id` (1..40 chars), `type`, finite `x y w h` (the UNROTATED
box; `rotation` is radians about its centre). `validateElement` rejects bad
values and STRIPS unknown fields (and fields a type does not use).

**Bounds.** Every stored coordinate lies within ±`LIMITS.MAX_COORD` (1e7, the
same bound the WS cursor is clamped to): `x`, `y`, the far edges `x + w` and
`y + h` of a box, and every point of a pen/connector (whose box is derived
from its points, so a stale client `x/y/w/h` there is ignored rather than
rejected). `naturalWidth`/`naturalHeight` are 0..1e7. A finite-but-absurd
value (1.7e308) is rejected with the field's path instead of overflowing to
Infinity/NaN downstream. A rect/ellipse/diamond/cylinder (the roughjs-filled
shapes, whose hachure/cross-hatch cost grows with their area) is at most
`LIMITS.MAX_SHAPE_SIZE` (200,000) units a side — more than an 8K screen shows
at the minimum zoom; a 2e7-unit cross-hatch rect froze every visitor's tab
for 40 s.

**Whole-board caps** (checked by the store after a batch): at most
`LIMITS.MAX_BOARD_IMAGE_CHARS` (40,000,000) characters of image `src` and
`LIMITS.MAX_BOARD_POINTS` (2,000,000) points across the board, besides
`MAX_ELS` (5000). Only a batch that GROWS a board past a cap is refused
(`BOARD_TOO_LARGE`); a board already over one can still be edited and shrunk.

| Field | Types | Values |
| --- | --- | --- |
| `stroke`, `fill` | all | CSS colour; `fill: 'none'` = no fill |
| `strokeWidth` | all | 0..200 |
| `strokeStyle` | all | `solid` `dashed` `dotted` |
| `opacity` | all | 0..1 |
| `locked` | all | boolean |
| `groupId` | all | opaque group key (id) |
| `seed` | all | integer 0..2^31-1 (roughjs seed) |
| `roughness` | all | 0..2 |
| `fillStyle` | all | `FILL_STYLES`: `hachure` `cross-hatch` `solid` `zigzag` |
| `roundness` | all | `ROUNDNESS`: `sharp` `round` |
| `label` | rect, ellipse, diamond, cylinder (optional); sticky (required) | string ≤ 500 |
| `fontFamily` | text, sticky, rect, ellipse, diamond, cylinder | `FONT_FAMILY_KEYS`: `hand` `normal` `code` |
| `fontSize` | text (default 24); sticky + shapes (optional, no default) | 4..512 |
| `align` | text, sticky, rect, ellipse, diamond, cylinder | `left` `center` `right` |
| `text` | text | string ≤ 4000 |
| `points` | pen (1..20000), arrow/line (**2**..20000) | absolute `{x, y}`; the box is re-derived from them |
| `startId`, `endId` | arrow, line | id of the element the first/last point is bound to |
| `startFixedPoint`, `endFixedPoint` | arrow, line | `{x, y}`, each 0..1: where on the anchor's UNROTATED box the bound end is pinned (see Connectors) |
| `startArrowhead`, `endArrowhead` | arrow, line | `ARROWHEADS`: `none` `arrow` `triangle` `bar` `dot` |
| `src`, `naturalWidth`, `naturalHeight` | image | https URL or base64 `data:image/*` ≤ 2,000,000 chars |

All hand-drawn fields are optional; absent means the renderer default
(roughness 1, fillStyle `solid`, roundness `sharp`, fontFamily `hand`, arrow
arrowheads none→arrow, line none→none, seed = FNV-1a of the id).

**View constants** (used by the web only; the view is never stored):
`ZOOM_LIMITS` = 0.1..30 (10%..3000%, Excalidraw's range; `zoomAt`, `fitView`
and `clampZoom` default to it), `ZOOM_STEP` = 0.1, the additive step of the
zoom buttons (`stepZoom(zoom, ±1)`: 100% → 110% → 120%).

**Update patches** (`validateOps` → `sanitisePatch`) accept exactly the
fields above except `id`/`type` (a patch naming either is rejected), and
type-check EVERY key they keep (including `x`, `y`, `naturalWidth`,
`naturalHeight`, `updatedAt`, all bounded as above). A patch value of `null`
REMOVES the field for `startId`, `endId`, `groupId`, `label`,
`startFixedPoint` and `endFixedPoint` (`NULLABLE_PATCH_KEYS`: unbinding or
un-pinning a connector end, leaving a group, clearing a shape label); for every other
field `null` is rejected (`null is only allowed for …`). The store merges the
patch and then re-validates the MERGED element, so a patch can never produce
an invalid element. The op the store reports in `appliedOps` carries the
patch AS IT TOOK EFFECT: each key with the value the stored element now has,
a `null` for a removal, and no key the element's type does not store (a
`text` sent to a rect, a pen's `x/w`, which are re-derived from its points),
so peers applying the broadcast end up with exactly the server's element.

**Connectors** (`resolveConnectors`, run by the store after every batch that
creates, updates, deletes or clears): only the first and last point of a
bound connector are ever moved. A bound end lands `bindGap(anchor,
connector)` units outside its anchor's OUTLINE as it is drawn — the box for
rect/sticky/text/image/cylinder, the ellipse for `ellipse`, the rhombus for
`diamond`; a `roundness: 'round'` rect or diamond uses its rounded corners
(`cornerRadius(size)` = 25% of the side, at most 32, the renderer's own
curves) — all honouring the anchor's `rotation`, on the ray from the anchor
centre toward its aim. `bindGap` is `BIND_GAP` (4) for default 2-unit strokes
and grows by half a unit per extra unit of stroke on each side (the anchor's
own stroke counts only for outlined types: rect, ellipse, diamond, cylinder),
so the visible air between arrowhead and outline is the same at every width.
The aim:

- an end with a fixed point (`startFixedPoint` / `endFixedPoint`) is PINNED:
  it aims at that point of its anchor's box, so it stays on the spot of the
  outline it was dropped on as the anchor moves, rotates or resizes. The
  editor takes it with `bindingFixedPoint(anchor, dropPoint)`, which gives
  the outline point on the ray from the centre through the drop, as `{x, y}`
  fractions of the unrotated box (`{x: 0.5, y: 0}` = middle of the top edge),
  or `null` for a drop closer to the centre than half the way to the outline
  (`FIXED_POINT_MIN_RATIO`): that end is not pinned;
- otherwise, 2 points with both ends bound: where the other end is pinned,
  or else the other anchor's centre;
- otherwise: the adjacent point (`points[1]` for the start, `points[n-2]` for
  the end).

Every aim point is something the resolver never moves (a pin depends only on
its own anchor), so the function is idempotent (a second pass returns the
same objects). A fixed point without its `startId`/`endId` is kept but inert;
a client that binds an end to another element sets that end's fixed point
(or `null`) in the same patch. Bindings to a missing id are dropped first
(`detachMissingConnectors`, which keeps the fixed points); bindings to
another connector are ignored, and a 2-point connector bound at both ends to
the same element resolves only its pinned ends (an unpinned one is left as
stored).

## Store interface

`createStore()` returns an object implementing exactly this. Both drivers
(`sqlite.js`, `memory.js`) export `createStore`. Everything is async.

```js
/**
 * @typedef {Object} Store
 * @property {(opts?: {limit?: number, offset?: number, search?: string, owner?: string}) => Promise<{boards: BoardSummary[], total: number}>} listBoards
 * @property {(id: string) => Promise<Board|null>} getBoard
 * @property {(input: {title?: string, theme?: 'light'|'dark', ownerId?: string|null, id?: string}) => Promise<Board>} createBoard
 * @property {(id: string, patch: {title?: string, theme?: 'light'|'dark', ownerId?: string|null}) => Promise<Board|null>} updateBoard
 * @property {(id: string) => Promise<boolean>} deleteBoard   // true if it existed
 * @property {(id: string) => Promise<Element[]>} listElements  // in z-order, index 0 first
 * @property {(id: string) => Promise<{board: Board, elements: Element[], rev: number}|null>} getSnapshot
 * @property {(id: string, ops: Op[], actorId?: string) => Promise<OpApplyResult>} applyOps
 * @property {(id: string) => Promise<number>} clearBoard  // removes all elements, bumps rev (REST uses a clear OP instead)
 * @property {(boardId: string, opId: string) => Promise<boolean>} hasOp
 * @property {() => Promise<void>} close
 */

/**
 * The atomic result of applying a batch (`OpResult` in @whiteboard/shared).
 * The store applies the whole batch or none of it.
 *
 * @typedef {Object} OpApplyResult
 * @property {'applied'|'duplicate'|'conflict'|'missing'} status
 * @property {number} rev            board rev after the batch (current rev on conflict, 0 when missing)
 * @property {string[]} applied      opIds of this batch the server now holds: applied by this batch OR
 *                                   by an earlier delivery of the same opId. Every opId of the batch on
 *                                   'applied'/'duplicate'; [] on 'conflict'/'missing'.
 * @property {Op[]} appliedOps       ops that took effect THIS time, in order (validated, actorId filled); [] otherwise
 * @property {Element[]} [elements]  the full element list after the batch, when 'applied'
 * @property {string} [message]      human-readable reason, for 'conflict'/'missing'
 */
```

`listBoards({owner})` returns that owner's boards PLUS every unowned board
(deliberate: an unowned board is claimable with `PATCH {ownerId}`).

### `applyOps` semantics — this is the part that must be exact

1. **Atomic.** One SQLite `BEGIN IMMEDIATE` transaction. Any failure →
   rollback, throw. Thrown errors carry `code`: `DUPLICATE_ELEMENT`,
   `TOO_MANY_ELEMENTS`, `INVALID_OP`, or `name === 'InvalidElement'` for a
   create/merged update that fails validation. Messages name the op by its
   index in the batch AS SENT (`ops[2].element.w: expected a finite number`).
2. **Dedupe.** If every op's `opId` is already recorded, return
   `{status:'duplicate', rev, applied: [...opIds], appliedOps: []}` — the retry
   path; it must not bump `rev`. In a partially seen batch the seen ops are
   skipped and the rest apply.
3. **Conflict.** If any fresh op carries `baseRev` and `baseRev !==
   currentRev`, return `{status:'conflict', rev: currentRev, applied: [],
   appliedOps: [], message:'board moved; resync'}` and change nothing (no rev
   bump). `baseRev` is OPTIONAL: ops without it are last-writer-wins per
   element (an update is a shallow merge of the fields it names), which is
   what realtime clients send.
4. **Missing board** → `{status:'missing', rev: 0, applied: [], appliedOps: []}`.
5. **Per-kind:**
   - `create` — validate, append to the end (top of z-order). Throw if the id
     exists or the board would exceed `LIMITS.MAX_ELS` (5000). The box of
     pen/connectors is re-derived from `points`.
   - `update` — shallow-merge `op.patch` onto the stored element (`null`
     removes a nullable key), then `validateElement` the merged result. A
     missing element is skipped (a delete that raced an update is normal).
   - `delete` — remove by id; missing is a no-op.
   - `reorder` — listed ids first in the given order; unknown ids ignored;
     unlisted ids keep their relative order at the end.
   - `clear` — delete all elements.
   After any create/update/delete/clear: drop dangling bindings (like
   `detachMissingConnectors`, without mutating), then `resolveConnectors`
   (see above); every connector either step changed is re-validated (a
   resolved end pushed off the board is a `VALIDATION_FAILED`, never a stored
   NaN) and the resolved points are persisted. Then the whole-board caps are
   checked (`BOARD_TOO_LARGE`).
6. **Rev.** Bump by 1 per applied batch (not per op).
7. **Record opIds** in `seen_ops` with a TTL (`OP_DEDUPE_TTL_MS`).

An EMPTY batch is refused (`INVALID_OP`, "expected at least one op") before
anything is read: it writes nothing and does not bump the rev. Both edges
refuse it first (REST 400, WS error ack `VALIDATION_FAILED`).

**Cost.** A batch costs O(elements) of pointer work plus O(what it changed)
of serialising and writing, never O(board bytes): element objects are never
modified in place (each change makes a new object, and everything a batch
created or changed is deep-frozen before `save`), `save(next, prev)` receives
the list before the batch so a driver can write only what changed, and the
sqlite driver keeps recently used boards parsed (keyed by rev) instead of
parsing the board on every drag frame. Results and snapshots handed to
callers never alias mutable stored state.

## REST surface

All bodies are JSON. Errors are `{statusCode, code, error, message}` (plus
`path` for validation failures and `rev` on 409). Codes: `VALIDATION_FAILED`
(400; the message names the op index and field path), `NOT_FOUND` (404
unknown board), `ROUTE_NOT_FOUND`, `REV_CONFLICT` (409), `PAYLOAD_TOO_LARGE`
(413), `INTERNAL` (500), `STORE_UNAVAILABLE` (503 from `/health`).

| Method | Path | Body / query | 200 response | Broadcast to the room |
| --- | --- | --- | --- | --- |
| GET | `/health` | — | `{ok, uptime, version, boards, store}` | — |
| GET | `/boards` | `?limit(1..200)&offset&search&owner` | `{boards: BoardSummary[], total}` | — |
| POST | `/boards` | `{title?, theme?, ownerId?}` | `BoardSnapshot` (201 + `Location`) | — |
| GET | `/boards/:id` | — | `BoardSnapshot` | — |
| GET | `/boards/:id/snapshot` | — | `BoardSnapshot` | — |
| PATCH | `/boards/:id` | `{title?, theme?, ownerId?}` (at least one) | `Board` | `{type:'board', boardId, board}` |
| DELETE | `/boards/:id` | — | `{deleted: true}` | every socket on the board gets `{type:'error', text:'board deleted', code:'BOARD_NOT_FOUND', boardId}` and is closed with 1008 |
| POST | `/boards/:id/ops` | `{ops: Op[] (1..200), actorId?}` | `{status, rev, applied, appliedOps, elements}` | `{type:'op', boardId, ops: appliedOps, rev}` when applied |
| DELETE | `/boards/:id/elements` | — | `{status:'applied', rev, applied:[opId], appliedOps:[clearOp], elements: []}` | `{type:'op', boardId, ops:[{opId, kind:'clear', at}], rev}` |
| GET | `/ws` | websocket upgrade | see below | |

`BoardSnapshot` = `{board, elements, rev}`. `Board` = `{id, title, theme, rev,
ownerId, createdAt, updatedAt}`; `BoardSummary` adds `elementCount`.
`POST /boards` always assigns the id itself (a UUID; an `id` in the body is
ignored like any other unknown field) and defaults `title` to
`'Untitled board'` and `theme` to `'light'`. `GET /boards` pages: read
`total` and step `offset` by `limit` to see every board.
`duplicate` is a 200 (a harmless retry) and is not re-broadcast.

The board-wide clear goes through `applyOps` as a real
`{opId:'clear-<32 hex>', kind:'clear'}` op, so it is recorded for dedupe and
peers receive an op they apply. REST broadcasts go to EVERY socket in the room
(`except = null`): the HTTP caller is not tied to a socket, so a client that
also holds one sees its own ops again and must treat them idempotently.

## WebSocket

Plain `ws` via `@fastify/websocket` on `GET ${API_PREFIX}/ws` (`/api/ws` by
default; `/ws` for an empty prefix). Messages are JSON envelopes whose `type`
is one of `WS_MSG` from `@whiteboard/shared`. Binary and non-JSON frames are
dropped; a handler error is logged and never closes the connection. An
upgrade to any other path is answered 404 (or closed, on a REST route).

Client → server:

- `{type:'join', boardId, peer:{name}}` → `ready` to the joiner:
  `{type:'ready', peerId, board, elements, rev, peers}` (the peer id is
  SERVER-assigned; its colour is `colorForPeer(peerId)`), and `presence` to
  the others. Unknown board → `{type:'error', text, code:'BOARD_NOT_FOUND',
  boardId}` and close 1008. No join within 10 s → `bye` and close.
- `{type:'ops', ops}` → EXACTLY ONE `{type:'ack', result}` to the sender:
  - `applied` / `duplicate`: `result = {status, rev, applied, appliedOps}` —
    the store result WITHOUT `elements` (the sender already holds its state;
    the whole board per drag frame would be O(board) bandwidth). On
    `applied`, `{type:'op', boardId, peerId, ops: appliedOps, rev}` goes to
    every OTHER peer (the sender's echo is suppressed).
  - `conflict` / `missing`: `result = {status, rev, applied: [], appliedOps:
    [], message}`, then `{type:'resync', boardId, rev}` to the SENDER ONLY
    (never the room — other peers keep their outboxes).
  - `error`: `result = {status:'error', message, code, applied: []}` when
    `validateOps` rejects the batch or it is empty (`code:
    'VALIDATION_FAILED'`), or the store throws (`DUPLICATE_ELEMENT`,
    `TOO_MANY_ELEMENTS`, `BOARD_TOO_LARGE`, `INVALID_OP`, `VALIDATION_FAILED`
    for an invalid merged element or resolved connector, `INTERNAL`
    otherwise). Nothing was applied; the client must drop the batch, not
    re-send it.
- `{type:'cursor', x, y}` (or `{cursor:{x,y}}`), board units → `peer-cursor
  {boardId, peerId, cursor, name, color}` to the others; never persisted;
  clamped to ±1e7; rate-limited per peer (`WS_CURSOR_RATE_MS`) with a
  trailing send of the latest position.
- `{type:'activity', text: tool}` → `presence` to the room when the tool
  changed and is in shared `TOOLS` (which includes `image`).
- `{type:'ping'}` → refresh `lastSeen`; no reply.

Server → client, unprompted: `presence {boardId, peers:[{id, name, color,
lastSeen, tool}]}` after any roster change; `op` (above, and from REST
writes); `board {boardId, board}` after `PATCH /boards/:id`; `bye`.

The sweeper drops a peer silent for `WS_PEER_TTL_MS` (default 30 s),
re-broadcasts `presence`, and CLOSES that peer's socket with code 4000
(`CLOSE_IDLE`, reason `idle timeout`): a silent peer is often only asleep (a
closed laptop, a throttled background tab), and without the close it stayed
out of every room while its own acks kept it looking connected. The client
treats the close like any dropped connection: reconnect, re-join, resync. A
socket that still talks after the hub has forgotten it (a ping, ops, cursor or
activity from a pruned peer) is closed the same way and its batch is NOT
applied (the client re-sends it after the re-join; opIds make that safe).

A socket is parked in the `_pending` room from open until it joins. Parking
rooms are never broadcast to: an unjoined socket receives nothing but the
answers to its own messages (`ready`, `error`, `bye`).

The hub is a plain class (`add`, `seat`, `remove`,
`broadcast(boardId, envelope, exceptPeerId)`, `peersOf`, `presence`,
`touch`, `prune`, `closeRoom(boardId, {envelope, code, reason})`, `send`,
`close`); it must not import Fastify, which is what makes it testable with a
fake socket and an injected clock.

## Config (`src/config.js`)

Read once, export a frozen object. Every value overridable by env, with a
sensible default so `node src/server.js` works with no env at all. Before
reading, `config.js` loads `apps/api/.env` when it exists (located next to the
package, not the working directory, via `process.loadEnvFile`); a variable
already set in the real environment always wins over the file.

`PORT` (3001), `HOST` (0.0.0.0), `API_PREFIX` (/api), `CORS_ORIGIN` (`*`, or a
comma-separated allowlist), `STORAGE` (`sqlite`|`memory`), `SQLITE_PATH`
(`./data/whiteboard.db`), `BODY_LIMIT` (8MB), `LOG_LEVEL` (info),
`WS_PEER_TTL_MS` (30000), `WS_CURSOR_RATE_MS` (33), `OP_DEDUPE_TTL_MS` (86400000),
`TRUST_PROXY` (false), `SEED_DEMO_BOARD` (true in non-production).

`server.js` maps them onto the constructors' own option names:
`createStore(storeOptions(config))` → `{storage, sqlitePath, opDedupeTtlMs}`,
`new Hub(hubOptions(config))` → `{peerTtlMs, cursorRateMs}`.

## Demo board

With `SEED_DEMO_BOARD` and an EMPTY store, `seedDemoBoard` creates the board
"Demonstração" in one batch (opIds `demo-seed-<i>`, actor `seed`): a title
text, a freehand squiggle, `Navegador → API (Fastify) → SQLite` (rect, rect,
cylinder) with bound arrows, a diamond `Op válida?` bound from the API, an
ellipse `Outras abas` reached by a bound 3-point arrow, and a sticky note.
Shapes carry their text in `label`; every element has a fixed `seed`,
`roughness: 1`, `fontFamily: 'hand'` where it has text, `fillStyle: 'hachure'`
on filled shapes, `roundness: 'round'` on rects. `scripts/seed-showcase.mjs`
(`API_URL` overridable) creates a similar showcase board over REST.

## Persistence notes

`node:sqlite` is built into Node 22.5+ behind `--experimental-sqlite`. The
`start` script must pass that flag. Elements are stored one JSON document per
ROW (one row per element, ordered by `pos`), so new optional element fields
still need only a shared-validator change, never a migration, while a
one-field update rewrites one row instead of the whole board. (They used to
be one JSON blob per board: every op batch — one per 50 ms of dragging —
parsed, re-serialised and rewrote the entire board, inline images included,
blocking the event loop for 100-600 ms on a board with a few photos.)
Schema:

```sql
CREATE TABLE boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'light',
  rev INTEGER NOT NULL DEFAULT 0, owner_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE element_rows (
  board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  pos INTEGER NOT NULL,        -- z-order; strictly increasing, gaps allowed
  data TEXT NOT NULL,          -- the element, as JSON
  PRIMARY KEY (board_id, id)
);
CREATE INDEX idx_element_rows_pos ON element_rows(board_id, pos);
CREATE TABLE seen_ops (
  board_id TEXT NOT NULL, op_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, op_id)
);
CREATE INDEX idx_seen_ops_at ON seen_ops(seen_at);
CREATE INDEX idx_boards_owner ON boards(owner_id);
```

A database written by the old schema (`elements(board_id, data)` blobs) is
migrated on open, in one transaction: each blob becomes rows in its z-order
and the old table is dropped. Positions are only renumbered where a batch
actually changed the order, so appends and deletes touch no other row.

`listBoards` pages in SQL (`LIMIT/OFFSET`, `total` from `COUNT(*)`) and takes
`elementCount` from the `element_rows` key index, so listing never parses an
element. `search` is a literal, Unicode-aware, case-insensitive substring of
the title, evaluated with JavaScript's `toLowerCase().includes()` on both
drivers (SQLite's `LOWER`/`LIKE` fold ASCII only, so 'área' did not find
'Área de testes' on sqlite while memory found it).

`memory.js` mirrors this with `Map`s so the test suite needs no disk.
