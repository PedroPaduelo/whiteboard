# Whiteboard

Collaborative infinite whiteboard. Two apps that build and ship to different
places, sharing one source of truth for the wire format.

```
whiteboard/
├── packages/shared/     the contract — types, geometry, validation, colour
├── apps/api/            Node 22 + Fastify 5 + node:sqlite + WebSocket
├── apps/web/            React 18 + Vite 5 + React Flow + TanStack Query
├── docs/                the two contracts that let the apps be built apart
└── docker-compose.yml   local dev topology
```

`packages/shared` is plain ESM with zero dependencies. The API imports it
straight from source; the web build resolves it through the npm workspace. That
is what lets the two apps be deployed independently and still agree on the
protocol.

## Quick start

```bash
npm install
npm run dev          # api on :3001, web on :5173
```

The API seeds a demo board on first boot when `SEED_DEMO_BOARD` is on (the
default outside production), so a first-time visitor lands on a board with
something on it rather than an empty canvas.

```bash
npm test             # API store, routes, ws, validation, geometry
npm run build        # web production build
docker compose up --build
```

## What it does

**Canvas** — infinite board, pan/zoom, ten element types (rect, ellipse,
diamond, cylinder, sticky, text, arrow, line, freehand pen, image). Freehand
is smoothed with quadratic midpoints. Arrows snap to a shape's edge and follow
it as it moves. Shift constrains, Alt resizes about the centre, 8-way resize
and rotation, marquee select, multi-drag, undo/redo with drag coalescing.

**Realtime** — op-based CRDT-lite. Clients apply optimistically and ship ops;
the server dedupes by `opId`, bumps a monotonic `rev`, and 409s a client that
is behind so it resyncs instead of clobbering. Attached connectors are
re-resolved server-side after every geometry change, so a server render and a
client render agree.

**Structure** — a React Flow layer under the canvas for containers and grouped
regions, with a two-way sync rule so dragging on one layer does not make the
other one jitter. A dnd-kit palette of ~12 presets, each a multi-element group
placed in one undo step.

**Import/export** — SVG, PNG and JSON. The SVG exporter reuses the renderer's
own geometry helpers, so an exported file matches the screen.

## Contracts

Read these before changing anything. They exist so the two apps can be built
against each other without a running integration.

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — REST surface, the `Store`
  interface, the exact `applyOps` semantics, the WebSocket protocol, config.
- [`docs/WEB_CONTRACT.md`](docs/WEB_CONTRACT.md) — the zustand store shape and
  the two rules that make undo and sync work, the module map, the keyboard map.

## Deploying the two apps separately

**API** — Node 22.5+ required; `node:sqlite` is behind `--experimental-sqlite`
and the `start` script passes it.

```bash
docker build -f apps/api/Dockerfile -t whiteboard-api .   # context = repo root
```

Build context is the **repo root** for both Dockerfiles, because both need
`packages/shared`.

Config (all optional, all read from the environment — see
`apps/api/.env.example`):

| Var | Default | Notes |
| --- | --- | --- |
| `PORT` / `HOST` | `3001` / `0.0.0.0` | |
| `API_PREFIX` | `/api` | |
| `CORS_ORIGIN` | `*` | or a comma-separated allowlist |
| `STORAGE` | `sqlite` | or `memory` (tests, ephemeral) |
| `SQLITE_PATH` | `./data/whiteboard.db` | parent dir is created |
| `BODY_LIMIT` | `8388608` | must match the WS max payload |
| `WS_PEER_TTL_MS` | `30000` | silent peers are dropped |
| `WS_CURSOR_RATE_MS` | `33` | ~30 cursor messages/s per peer |
| `SEED_DEMO_BOARD` | `true` outside production | |

**Web** — a static build. `VITE_API_URL` and `VITE_WS_URL` are baked in at
build time, so the image must be rebuilt when the API hostname changes.

```bash
docker build -f apps/web/Dockerfile -t whiteboard-web .
```

`nginx.conf` serves the SPA with immutable asset caching, a restrictive CSP
(`connect-src` plus `ws:`/`wss:`), and `nosniff`.

## Notes for maintainers

- **The board is one document.** Elements live as a single JSON array per
  board, not a row per element. Every real read wants all of them; row-per-
  element buys joins and N+1s on the one query that matters.
- **Rev conflicts are not errors to retry.** On a 409 the client resyncs and
  replays; it must not re-send the same baseRev, and the server must not bump
  the rev on a rejected batch, or every retry conflicts too.
- **Echo suppression is load-bearing.** The WS layer does not echo your ops
  back to you. A client that renders both its optimistic update and the echo
  draws everything twice.
- **`resolveConnectors` + `detachMissingConnectors` after every geometry
  batch.** Otherwise arrows point at where a box used to be, or at nothing.
- **Hit-test tolerance is divided by zoom.** Otherwise selection feels broken
  when zoomed out and hair-triggered when zoomed in.
