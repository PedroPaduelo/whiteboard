# apps/api — Whiteboard API

Fastify 5 + `node:sqlite`. REST for boards and op batches, a websocket for
live collaboration. Storage is swappable (`sqlite` or in-memory `memory`); the
wire contract is defined in [`docs/API_CONTRACT.md`](../../docs/API_CONTRACT.md)
and the element/op shapes in `@whiteboard/shared`.

## Requirements

Node **22.5+** — `node:sqlite` is built in but still behind
`--experimental-sqlite`, which every script below already passes.

## Run

From the repo root (npm workspaces resolve `@whiteboard/shared` for you):

```bash
npm install
npm run dev:api          # watch mode on :3001
# or
npm run start:api        # single run
```

The API prints its bound URL on boot in non-production. With an empty store it
also seeds a small **Demonstração** board, so the first visitor sees a working canvas
rather than a blank one.

From inside this directory instead:

```bash
npm install
npm start
```

### In-memory mode (no disk, no migrations)

```bash
STORAGE=memory PORT=3001 node --experimental-sqlite src/server.js
```

## Configuration

Every key is read once by `src/config.js`; the frozen config is the only thing
the rest of the app reads. Copy `.env.example` to `.env` to override. All
values below are the defaults — **no env is required to boot**.

| Key | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` (`production` implied) | `production` disables the demo seed and per-request logging |
| `PORT` | `3001` | TCP port. `0` asks the OS for a free port |
| `HOST` | `0.0.0.0` | bind interface |
| `API_PREFIX` | `/api` | prefix for every route, including `/ws` |
| `CORS_ORIGIN` | `*` | `*`, or a comma-separated exact-match allowlist |
| `BODY_LIMIT` | `8388608` (8 MB) | max request body; larger gets `413` |
| `LOG_LEVEL` | `info` | pino level |
| `TRUST_PROXY` | `false` | honour `X-Forwarded-*` — **only** behind a proxy you control |
| `STORAGE` | `sqlite` | `sqlite` or `memory` |
| `SQLITE_PATH` | `./data/whiteboard.db` | database file; parent dir is created on boot |
| `WS_PEER_TTL_MS` | `30000` | drop a peer silent this long |
| `WS_CURSOR_RATE_MS` | `33` | min gap between cursor broadcasts (~30/s) |
| `OP_DEDUPE_TTL_MS` | `86400000` | how long an `opId` suppresses a retry |
| `SEED_DEMO_BOARD` | `true` outside production | seed a starter board when the store is empty |

## Deploy

**The build context is the repo root, not `apps/api`.** The API imports
`@whiteboard/shared` from `packages/shared`, so the context must contain both:

```bash
docker build -f apps/api/Dockerfile -t whiteboard-api .
docker run --rm -p 3001:3001 -v whiteboard-data:/app/data whiteboard-api
```

`-v whiteboard-data:/app/data` is what keeps boards across restarts — the
sqlite file lives there. Dropping that volume resets the store to empty (and
reseeds the demo board, if seeding is on).

The image is multi-stage on `node:22-slim`, installs prod deps only, runs as
the non-root `node` user, and ships a `HEALTHCHECK` against
`{API_PREFIX}/health`.

## API

All paths are relative to `API_PREFIX` (default `/api`).

| Method | Path | Body / query | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ok, uptime, version, boards, store}` |
| GET | `/boards` | `?limit&offset&search` | `{boards, total}` |
| POST | `/boards` | `{title?, theme?, ownerId?}` | `BoardSnapshot` (201) |
| GET | `/boards/:id` | — | `BoardSnapshot` |
| PATCH | `/boards/:id` | `{title?, theme?}` | `Board` |
| DELETE | `/boards/:id` | — | `{deleted: true}` |
| GET | `/boards/:id/snapshot` | — | `BoardSnapshot` |
| POST | `/boards/:id/ops` | `{ops, actorId?}` | `OpApplyResult` |
| DELETE | `/boards/:id/elements` | — | `OpApplyResult` (clear) |
| GET | `/ws` | websocket upgrade | see the contract |

### Errors

Every failure has the same shape, so a client branches on `code` and never on
prose:

```json
{
  "statusCode": 400,
  "code": "VALIDATION_FAILED",
  "error": "Bad Request",
  "message": "ops[3].element.w: expected a finite number"
}
```

`message` from `@whiteboard/shared` is passed through verbatim — it names the
op index and the field, which is the fastest possible path to the bug. Stack
traces never appear in a response; they go to the logger.

## Examples

Create a board (note the demo seed already made one, so this is a second):

```bash
curl -sS -X POST http://localhost:3001/api/boards \
  -H 'content-type: application/json' \
  -d '{"title":"Sprint 42","theme":"light"}'
```

```json
{ "board": { "id": "b_7f3a…", "title": "Sprint 42", "theme": "light", "rev": 0 },
  "elements": [], "rev": 0 }
```

Post a batch of ops. The batch is atomic and the whole board moves in one rev:

```bash
curl -sS -X POST http://localhost:3001/api/boards/$BOARD/ops \
  -H 'content-type: application/json' \
  -d '{
    "actorId": "peer-1",
    "ops": [
      { "opId": "op-1", "boardId": "'$BOARD'", "kind": "create",
        "element": { "id": "el-1", "type": "rect", "x": 80, "y": 200,
                     "w": 180, "h": 96, "stroke": "#1f2937", "fill": "#bfdbfe" } },
      { "opId": "op-2", "boardId": "'$BOARD'", "kind": "create",
        "element": { "id": "el-2", "type": "sticky", "x": 300, "y": 200,
                     "w": 200, "h": 150, "label": "Ship it" } }
    ]
  }'
```

```json
{ "status": "applied", "rev": 1, "appliedOps": ["op-1", "op-2"],
  "elements": [ … ] }
```

Re-post the identical batch and you get `{"status":"duplicate","rev":1}` with
no rev bump — that is the retry path after a network timeout.

Send `baseRev` in an op to opt into optimistic concurrency. If the board moved
underneath you the batch is rejected untouched, with `409 CONFLICT` and
`"board moved; resync"`; re-`GET` the snapshot and replay.

```bash
curl -sS -X POST http://localhost:3001/api/boards/$BOARD/ops \
  -H 'content-type: application/json' \
  -d '{"ops":[{"opId":"op-3","boardId":"'$BOARD'","kind":"delete",
               "elementId":"el-1","baseRev":1}]}'
```

## Tests

```bash
npm test          # from the repo root, or:
node --experimental-sqlite --test test/*.test.js
```

## Layout

```
src/
  config.js          env -> frozen config (read once)
  app.js             buildApp({store,hub,config}) — never listens
  server.js          store -> hub -> app -> listen -> signals
  plugins/
    cors.js          * or exact-match allowlist
    errors.js        one {statusCode, code, error, message} shape
    health.js        /health
  routes/            REST (see the contract)
  store/             sqlite + memory drivers
  ws/                hub + @fastify/websocket wiring
```

`app.js` builds and `server.js` listens, on purpose: tests use
`buildApp()` with `app.inject()` and never bind a port.
