# Whiteboard

Collaborative infinite whiteboard. Two apps that build and ship to different
places, sharing one source of truth for the wire format.

```
whiteboard/
├── packages/shared/     the contract — types, geometry, validation, colour
├── apps/api/            Node 22 + Fastify 5 + node:sqlite + WebSocket
├── apps/web/            React 18 + Vite 5 + one <canvas> (roughjs, perfect-freehand) + zustand + TanStack Query
├── docs/                the API and editor contracts
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
npm test             # API: store, routes, ws, validation, geometry
npm run test:web     # web: editor, render/export, store, realtime, UI actions (node:test, no browser)
npm run test:all     # both
npm run build        # web production build -> apps/web/dist
docker compose up --build
```

## What it does

**Editor** — looks and behaves like Excalidraw: one full-screen HTML canvas,
hand-drawn shapes from roughjs (each element stores its `seed`, so every peer,
reload and export draws the same wobble), a freehand pen from
perfect-freehand, the Virgil handwriting font, Excalidraw's floating islands
(tool island, properties panel, main menu, zoom and undo) and its keyboard
map. The UI is in Brazilian Portuguese. Ten element types: rect, diamond,
ellipse, cylinder, sticky note, text, arrow, line, pen and image. Shapes hold
a label typed into them; arrows and lines take several points and bind to
shapes, following them as they move. Shift constrains, Alt resizes about the
centre, 8-way resize and rotation, marquee select, groups, lock, multi-drag,
and undo/redo with drag coalescing.

**Library** — a sidebar of ready-made presets
(`apps/web/src/store/presets.js`), each a group of elements placed in one
undo step: click to drop it in the middle of the view, or drag it onto the
canvas.

**Realtime** — op-based and CRDT-lite. Clients apply their edits right away
and send ops over a WebSocket, one batch in flight at a time. The server
dedupes by `opId`, bumps a monotonic `rev` per batch and acks each batch. WS
ops carry no `baseRev`, so concurrent edits are last-writer-wins in server
arrival order. A client that misses something resyncs from the snapshot and
re-applies its own unacked ops on top. Bound connectors are re-resolved
server-side after every geometry change, so a server render and a client
render agree. Peers see each other's cursors and names (the nickname).

**Import/export** — PNG and SVG (with background, dark mode and scale
options) and a JSON board file. The SVG exporter uses the renderer's own
roughjs drawables and text layout, so an exported file matches the screen.

## Contracts

Read these before changing anything. They exist so the two apps, and the
parts of the editor, can be built against each other without a running
integration.

- [`docs/API_CONTRACT.md`](docs/API_CONTRACT.md) — REST surface, the `Store`
  interface, the exact `applyOps` semantics, the WebSocket protocol, config.
- [`docs/EDITOR_CONTRACT.md`](docs/EDITOR_CONTRACT.md) — the web editor: the
  element model fields, the store additions and the undo/sync rules, the
  realtime client, the module map, the rendering, interaction and UI APIs, the
  properties panel and the keyboard map.

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
| `OP_DEDUPE_TTL_MS` | `86400000` | how long a seen `opId` suppresses a retry |
| `LOG_LEVEL` | `info` | pino level |
| `TRUST_PROXY` | `false` | only behind a proxy you control |
| `SEED_DEMO_BOARD` | `true` outside production | |

**Web** — a static build served by nginx, which also proxies `/api` (REST and
the WebSocket) to the API (`$api_upstream` in `apps/web/nginx.conf`, the
compose service `api:3001` by default). The app defaults to the same-origin
`/api` and `/api/ws`, so the usual deployment needs no configuration and no
CORS.

```bash
docker build -f apps/web/Dockerfile -t whiteboard-web .
```

Only when the API lives on another host: build with `VITE_API_URL` /
`VITE_WS_URL` (build args — Vite inlines them, so changing them means a
rebuild), add that origin to `$api_origin` in `nginx.conf` (the CSP's
`connect-src`), and set the API's `CORS_ORIGIN` to the web origin. Never point
them at `localhost` for a real deployment: the browser resolves it to the
visitor's own machine. `nginx.conf` also serves the SPA with immutable asset
caching, a restrictive CSP and `nosniff`.

## Notes for maintainers

- **The board is one document.** Elements live as a single JSON array per
  board, not a row per element. Every real read wants all of them; row-per-
  element buys joins and N+1s on the one query that matters.
- **Rev conflicts are not errors to retry.** `baseRev` is optional (the web
  client never sends it). A batch that does carry a stale one gets a 409 or a
  `conflict` ack; the client resyncs and replays. It must not re-send the same
  `baseRev`, and the server must not bump the rev on a rejected batch, or
  every retry conflicts too.
- **Echo suppression is load-bearing.** The WS layer does not echo your ops
  back to you. A client that renders both its optimistic update and the echo
  draws everything twice.
- **`resolveConnectors` + `detachMissingConnectors` after every geometry
  batch.** Otherwise arrows point at where a box used to be, or at nothing.
- **Hit-test tolerance is divided by zoom.** Otherwise selection feels broken
  when zoomed out and hair-triggered when zoomed in.
- **Text has one layout.** The renderer, the in-place textarea, hit-testing
  and the SVG export all ask `apps/web/src/editor/text.js` where each line
  goes. Its `wrapText` follows the textarea's CSS line breaking, so a label
  does not reflow when editing starts or ends.
