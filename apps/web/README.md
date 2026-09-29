# apps/web — collaborative whiteboard frontend

React 18 + Vite 5, plain JSX (no TypeScript), plain CSS with custom properties
(no Tailwind, no CSS-in-JS). The editor looks and behaves like Excalidraw: one
full-screen HTML canvas, hand-drawn shapes from roughjs, a freehand pen from
perfect-freehand, the Virgil handwriting font, and Excalidraw's floating
islands. State lives in a zustand store with undo; REST goes through TanStack
Query; collaboration is op-based over a WebSocket. Every user-facing string is
Brazilian Portuguese, in `src/ui/strings.js`.

Read `docs/EDITOR_CONTRACT.md` at the repo root before changing the editor:
the element model fields, the store and its undo/sync rules, the realtime
client, the module map, the rendering, interaction and UI APIs, the properties
panel and the keyboard map. `docs/API_CONTRACT.md` is the server side.

## Run it

```bash
# from the repo root — the API must be on :3001
npm install
npm run dev:web     # http://localhost:5173  (npm run dev starts the API too)
```

The dev server proxies `/api` (HTTP **and** WebSocket) to
`http://localhost:3001`. Override with `VITE_API_PROXY_TARGET`.

```bash
npm run build                        # -> apps/web/dist
npm run preview -w @whiteboard/web   # serve the build on :4173
npm run test:web                     # node:test suites, no browser needed
```

In development builds `window.__wb` exposes the board store
(`__wb.getState()`, `__wb.subscribe()`) for debugging and browser checks. It
is not in production builds.

## Environment

Copy `.env.example` to `.env.local`. Only `VITE_`-prefixed values reach the
browser, and Vite inlines them at build time — never put a secret here.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_URL` | `/api` (same origin) | HTTP API base |
| `VITE_WS_URL` | derived from `VITE_API_URL`: `ws(s)://<page host>/api/ws` | WebSocket endpoint |
| `VITE_API_PROXY_TARGET` | `http://localhost:3001` | dev server only: where `/api` is proxied |

Leave `VITE_API_URL` / `VITE_WS_URL` unset for the normal deployment, where
nginx serves the app and proxies `/api` on the same origin. Set them only when
the API is on another host, and never to a `localhost` value outside local
development: the browser resolves `localhost` to the visitor's own machine.

## Layout

```
apps/web/
├── index.html              # Vite entry document (lang pt-BR, color-scheme meta)
├── vite.config.js          # dev proxy (with ws:true), vendor chunks, preview
├── nginx.conf              # SPA fallback, /api proxy (REST + WebSocket), caching, CSP
├── Dockerfile              # node:22-slim -> nginx:alpine, non-root, :8080
├── public/fonts/           # Virgil + Cascadia Code woff2 (SIL OFL 1.1)
├── test/                   # node:test suites (npm run test:web)
└── src/
    ├── main.jsx            # entry: styles, fonts, theme, QueryClientProvider, ErrorBoundary
    ├── App.jsx             # page shell: nickname gate, board list, board (no router)
    ├── styles/             # tokens, global, editor, dialogs, screens (.css)
    ├── editor/             # the canvas editor
    │   ├── Canvas.jsx      #   two canvases, pointer/keyboard wiring, render loop
    │   ├── TextEditor.jsx  #   in-place textarea for text and labels
    │   ├── interaction.js  #   pure pointer/keyboard reducer -> effects
    │   ├── scene.js, hitTest.js, handles.js   # geometry over elements
    │   ├── elements.js     #   createElement, style keys per type/tool
    │   ├── text.js         #   the one text measurement and layout
    │   ├── constants.js, tools.js, fonts.js, image.js
    │   ├── actions.js      #   every user intent (menus, shortcuts, panel)
    │   ├── render/         #   roughjs / perfect-freehand painting
    │   └── export/         #   PNG, SVG and JSON
    ├── ui/                 # islands, properties panel, library, menus, dialogs, shortcuts, strings, theme
    ├── store/              # zustand board store + history; library presets
    ├── realtime/           # WebSocket client, op outbox, store bridge, presence
    └── api/                # fetch client + TanStack Query hooks
```

## Styles

Five stylesheets, imported in this order by `src/main.jsx`:

1. `tokens.css` — must come first; everything else resolves its custom
   properties from it.
2. `global.css` — reset, document chrome, shared controls (buttons, fields,
   key caps, the island) and utilities.
3. `editor.css` — the board screen: the canvas host and the islands floating
   over it.
4. `dialogs.css` — the modal shell and the dialogs (help, export, confirm,
   change name).
5. `screens.css` — the full-page screens: nickname gate, board list, crash
   screen.

### Tokens

Never hardcode a colour, radius or shadow in the chrome. Read it from
`src/styles/tokens.css`:

- **Type** — `--ui-font`, `--font-hand` (Virgil), `--font-mono` (Cascadia Code)
- **Surfaces** — `--canvas-bg`, `--screen-bg`, `--island-bg`,
  `--island-shadow`, `--island-shadow-strong`, `--field-bg`, `--option-bg`,
  `--kbd-bg`, `--backdrop`, `--welcome`
- **Text and lines** — `--text`, `--text-muted`, `--text-faint`, `--icon`,
  `--border`, `--divider`, `--swatch-border`
- **Accent and states** — `--accent`, `--accent-on`, `--accent-soft`,
  `--accent-strong`, `--accent-strong-hover`, `--active-bg`, `--hover`,
  `--danger`, `--warning`, `--success`
- **Shape and motion** — `--radius-sm`, `--radius`, `--radius-lg`, `--ease`,
  `--dur`
- **Layout** — `--island-h`, `--touch`, `--gutter`
- **Stacking** — `--z-ui`, `--z-panel`, `--z-menu`, `--z-context`,
  `--z-dialog`, `--z-drag`, `--z-toast`

Element colours on the canvas are not tokens: they are stored on the
elements, and the palettes live in `src/editor/constants.js`.

### Theming

Dark mode is `html[data-theme='dark']` in `tokens.css`. `src/ui/theme.js`
decides the value: an explicit user choice (menu or Alt+Shift+D, stored under
`whiteboard:theme`) wins; otherwise the OS preference, read in JS through
`matchMedia`, and a board's own `theme` act as defaults. `main.jsx` applies it
before the first paint. The canvas is not themed by CSS tokens: it always
paints light colours and `Canvas.jsx` applies `DARK_MODE_FILTER` (invert +
hue-rotate, like Excalidraw). `<meta name="color-scheme" content="light dark">`
in `index.html` keeps native form controls and scrollbars in step.

### Pointer events

The UI layer over the canvas ignores the pointer, and each island opts back in,
so every gesture that misses an island reaches the canvas. A closed panel must
use `display: none` (or be unmounted) — never `visibility: hidden` or
`opacity: 0` on something that opted back in — or it silently swallows canvas
gestures. `.canvas-host` (`editor.css`) carries `touch-action: none`, and the
canvas wrapper in `Canvas.jsx` also disables text selection; the text editor
opts back in.

### Shared class names

`global.css` defines the reusable pieces: `.sr-only`, `.island`, `.btn` +
`.btn--primary|danger|sm|xs|grow`, `.icon-btn` (+ `__badge`, `--danger`),
`.link-btn`, `.field`, `.field-label`, `.field-help`, `.search-field`, `.kbd`,
`.keycaps`, `.range`, `.form-actions`. Component classes (`.tool-island`,
`.tool-btn`, `.props-panel`, `.library-panel`, `.context-menu`, `.toast`,
`.dialog`, …) live next to their screen in `editor.css`, `dialogs.css` and
`screens.css`.

## Production

```bash
# build context is the repo root (it needs packages/shared)
docker build -f apps/web/Dockerfile -t whiteboard-web .
docker run --rm -p 8080:8080 whiteboard-web
```

The image is multi-stage (node:22-slim builds, nginx:alpine serves) and runs
as the non-root `nginx` user on port 8080. `nginx.conf` provides the SPA
fallback, immutable caching for hashed `/assets/`, `no-cache` for
`index.html`, gzip, a strict CSP, and proxies `/api` (REST and WebSocket) to
`$api_upstream` (the compose service `api:3001` by default), so the default
build talks to the API on its own origin.

For a split deployment (API on another host), pass `VITE_API_URL` /
`VITE_WS_URL` as build args, add that origin to `$api_origin` in `nginx.conf`
(otherwise the CSP's `connect-src` blocks it), and set the API's
`CORS_ORIGIN` to the web origin.
