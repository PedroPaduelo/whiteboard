# API contract — apps/api

Authoritative for the backend. **Owners**: `store` agent implements the Store
interface; `routes`, `ws`, `bootstrap` agents consume it. Do not change an
interface without changing it here first.

All routes are prefixed with the app's own prefix from `config.js`
(`API_PREFIX`, default `/api`). `@whiteboard/shared` is imported by path
(`@whiteboard/shared` resolves via the npm workspace).

## Modules and who owns what

| File | Owner agent | Purpose |
| --- | --- | --- |
| `src/config.js` | bootstrap | env parsing, single source of runtime config |
| `src/store/index.js` | store | persistence: the Store interface below |
| `src/store/sqlite.js` | store | `node:sqlite` driver + migrations |
| `src/store/memory.js` | store | in-memory driver, same interface (tests/dev) |
| `src/routes/boards.js` | routes | REST: boards CRUD + snapshot |
| `src/routes/ops.js` | routes | REST: op batch apply |
| `src/ws/hub.js` | ws | presence, rooms, fan-out |
| `src/ws/plugin.js` | ws | `@fastify/websocket` wiring |
| `src/plugins/*.js` | bootstrap | cors, error handler, health |
| `src/server.js` | bootstrap | build + listen + graceful shutdown |
| `test/*.test.js` | store + routes | `node --test` |

## Store interface

`createStore()` returns an object implementing exactly this. Both drivers
(`sqlite.js`, `memory.js`) export `createStore`. Everything is async except
`close`.

```js
/**
 * @typedef {Object} Store
 * @property {(opts?: {limit?: number, offset?: number}) => Promise<{boards: BoardSummary[], total: number}>} listBoards
 * @property {(id: string) => Promise<Board|null>} getBoard
 * @property {(input: {title?: string, theme?: 'light'|'dark', ownerId?: string|null, id?: string}) => Promise<Board>} createBoard
 * @property {(id: string, patch: {title?: string, theme?: 'light'|'dark'}) => Promise<Board|null>} updateBoard
 * @property {(id: string) => Promise<boolean>} deleteBoard   // true if it existed
 * @property {(id: string) => Promise<Element[]>} listElements  // in z-order, index 0 first
 * @property {(id: string) => Promise<{board: Board, elements: Element[], rev: number}|null>} getSnapshot
 * @property {(id: string, ops: Op[], actorId?: string) => Promise<OpApplyResult>} applyOps
 * @property {(id: string) => Promise<number>} clearBoard  // removes all elements, bumps rev
 * @property {(boardId: string, opId: string) => Promise<boolean>} hasOp
 * @property {() => Promise<void>} close
 */

/**
 * The atomic result of applying a batch. The store MUST apply the whole batch
 * or none of it: a partially applied batch is unrecoverable for a client that
 * assumed atomicity.
 *
 * @typedef {Object} OpApplyResult
 * @property {'applied'|'duplicate'|'conflict'|'missing'} status
 * @property {number} rev            board rev after the batch (or current, on conflict)
 * @property {Op[]} appliedOps      ops that took effect, in order (empty otherwise)
 * @property {Element[]} elements   the board's full element list after the batch, when 'applied'
 * @property {string} [message]     human-readable reason, for 'conflict'/'missing'
 */
```

### `applyOps` semantics — this is the part that must be exact

1. **Atomic.** Wrap in one SQLite transaction. Any failure → rollback, throw.
2. **Dedupe.** If every op's `opId` is already recorded, return
   `{status:'duplicate', rev, appliedOps:[]}` — this is the retry path, and it
   must not bump `rev`.
3. **Conflict.** If any op carries `baseRev` and `baseRev !== currentRev`,
   return `{status:'conflict', rev: currentRev, appliedOps: [],
   message:'board moved; resync'}` and change nothing. The client then GETs
   the snapshot and replays. Bumping the rev on a rejected batch would make
   every subsequent retry conflict too.
4. **Missing board** → `{status:'missing', rev: 0}`.
5. **Per-kind:**
   - `create` — append `op.element` to the end (top of z-order). Reject the
     op (throw) if `element.id` already exists, or if the board would exceed
     `LIMITS.MAX_ELS`. Re-derive the element's box from its points via
     `validateElement` — never trust client `x/y/w/h` for pen/connectors.
   - `update` — shallow-merge `op.patch` onto the stored element, then re-run
     `validateElement` on the merged result. If the element is gone, skip the
     op (do not throw — a delete that raced an update is normal).
   - `delete` — remove by id; missing is a no-op.
   - `reorder` — set the order to `op.order`; ids not present are ignored,
     ids not in `order` keep their relative position at the end.
   - `clear` — delete all elements.
   After any geometry change, run `resolveConnectors(elements)` so attached
   arrows follow their boxes.
6. **Rev.** Bump by 1 per successful batch (not per op).
7. **Record opIds** in a `seen_ops` table with a TTL, so a client that retries
   after a network timeout does not double-apply.

## REST surface

All bodies are JSON. Errors are Fastify's `{statusCode, error, message}`
plus a `code` string the client can branch on.

| Method | Path | Body / query | 200 response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok, uptime, version, boards, store}` |
| GET | `/boards` | `?limit&offset&search` | `{boards: BoardSummary[], total}` |
| POST | `/boards` | `{title?, theme?, ownerId?}` | `BoardSnapshot` (201) |
| GET | `/boards/:id` | — | `BoardSnapshot` |
| PATCH | `/boards/:id` | `{title?, theme?}` | `Board` |
| DELETE | `/boards/:id` | — | `{deleted: true}` |
| GET | `/boards/:id/snapshot` | — | `BoardSnapshot` |
| POST | `/boards/:id/ops` | `{ops: Op[], actorId?}` | `OpApplyResult` |
| DELETE | `/boards/:id/elements` | — | `OpApplyResult` (clear) |
| GET | `/ws` | (websocket upgrade) | see below |

`BoardSummary` = `Board` plus `{elementCount}`. Status codes: 404 unknown
board, 400 validation failure (message names the offending op index and
field path), 409 conflict (client should resync), 413 body over
`BODY_LIMIT`.

## WebSocket

Plain `ws` via `@fastify/websocket` on `GET {API_PREFIX}/ws`. Messages are
`WSEnvelope` JSON objects from `@whiteboard/shared` (`WS_MSG`).

Client sends `join` with `{type:'join', boardId, peer:{name}}`. The server
replies `ready` with `{type:'ready', peerId, board, elements, rev, peers}`,
then broadcasts `presence` to the room.

- `ops` → validate with `validateOps`, `store.applyOps`, reply `ack` with the
  `OpResult`, and broadcast `op` (the accepted ops, plus `rev`) to every OTHER
  peer in the room. Echo to the sender is suppressed — the sender already has
  the optimistic state, and an echo is what makes naive clients double-draw.
- `cursor` → broadcast `peer-cursor`, never persisted, rate-limited to ~30/s
  per peer with a trailing send.
- `ping` → update the peer's `lastSeen`; reply nothing.
- Drop a peer that has not pinged in `WS_PEER_TTL_MS` (default 30s). Send a
  `presence` after any roster change.

The hub is a plain class with `add(peer)`, `remove(peer)`, `broadcast(boardId,
envelope, exceptPeerId)`, `peersOf(boardId)`. It must not import Fastify —
that is what makes it testable with a fake socket.

## Config (`src/config.js`)

Read once, export a frozen object. Every value overridable by env, with a
sensible default so `node src/server.js` works with no env at all.

`PORT` (3001), `HOST` (0.0.0.0), `API_PREFIX` (/api), `CORS_ORIGIN` (`*`, or a
comma-separated allowlist), `STORAGE` (`sqlite`|`memory`), `SQLITE_PATH`
(`./data/whiteboard.db`), `BODY_LIMIT` (8MB), `LOG_LEVEL` (info),
`WS_PEER_TTL_MS` (30000), `WS_CURSOR_RATE_MS` (33), `OP_DEDUPE_TTL_MS` (86400000),
`TRUST_PROXY` (false), `SEED_DEMO_BOARD` (true in non-production).

## Persistence notes

`node:sqlite` is built into Node 22.5+ behind `--experimental-sqlite`. The
`start` script must pass that flag. Schema:

```sql
CREATE TABLE boards (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, theme TEXT NOT NULL DEFAULT 'light',
  rev INTEGER NOT NULL DEFAULT 0, owner_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
-- Elements as one JSON blob per board: the whole board is one document, and
-- every read wants all of it. Rows-per-element would only add joins and
-- N+1s on the one query that matters.
CREATE TABLE elements (
  board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE CASCADE,
  data TEXT NOT NULL          -- JSON array, in z-order
);
CREATE TABLE seen_ops (
  board_id TEXT NOT NULL, op_id TEXT NOT NULL, seen_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, op_id)
);
CREATE INDEX idx_seen_ops_at ON seen_ops(seen_at);
```

`memory.js` mirrors this with `Map`s so the test suite needs no disk.
