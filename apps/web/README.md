# apps/web — collaborative whiteboard frontend

React 18 + Vite 5, plain JSX (no TypeScript), plain CSS with custom properties
(no Tailwind, no CSS-in-JS). Real-time collaboration over a WebSocket.

See `docs/WEB_CONTRACT.md` at the repo root for the module map, the store
shape, the API surface and the keyboard map.

## Run it

```bash
# from the repo root — the API must be on :3001
npm install
npm run dev:web     # http://localhost:5173
```

The dev server proxies `/api` (HTTP **and** WebSocket) to
`http://localhost:3001`. Override with `VITE_API_PROXY_TARGET`.

```bash
npm run build:web   # -> apps/web/dist
npm run preview -w @whiteboard/web   # serve the build on :4173
```

## Environment

Copy `.env.example` to `.env.local`. Only `VITE_`-prefixed values reach the
browser, and Vite inlines them at build time — never put a secret here.

| Variable | Default | Meaning |
| --- | --- | --- |
| `VITE_API_URL` | `http://localhost:3001/api` | HTTP API base |
| `VITE_WS_URL` | derived from `VITE_API_URL` | WebSocket endpoint |

## Layout

```
apps/web/
├── index.html              # Vite entry document
├── vite.config.js          # dev proxy (with ws:true), build, preview
├── nginx.conf              # SPA fallback, caching, CSP
├── Dockerfile              # node:22-slim -> nginx:alpine, non-root, :8080
└── src/
    ├── main.jsx            # entry: styles, QueryClientProvider, ErrorBoundary
    ├── styles/
    │   ├── tokens.css      # design tokens, light + dark
    │   ├── global.css      # reset, canvas surface, utilities
    │   ├── toolbar.css     # left tool rail
    │   └── panels.css      # top bar, status bar, dialogs, toasts
    ├── store/              # zustand state + history
    ├── api/                # fetch client + TanStack Query hooks
    ├── realtime/           # WebSocket client, outbox, presence
    ├── canvas/             # 2D renderer, hit-test, pointer state machine
    ├── flow/               # React Flow structural layer
    ├── dnd/                # dnd-kit palette
    ├── ui/                 # toolbar, panels, dialogs
    └── App.jsx             # page shell
```

## Styles

Four stylesheets, imported in this order by `src/main.jsx`:

1. `tokens.css` — must come first; everything else resolves its custom
   properties from it.
2. `reactflow/dist/style.css` — a side effect of the library. Omit it and the
   React Flow layer renders unstyled.
3. `global.css`, `toolbar.css`, `panels.css`.

### Tokens

Never hardcode a colour, spacing value or shadow. Read it from
`src/styles/tokens.css`:

- **Colour** — `--color-bg`, `--color-surface`, `--color-surface-hover`,
  `--color-surface-sunken`, `--color-border`, `--color-border-strong`,
  `--color-text`, `--color-text-muted`, `--color-text-inverse`, `--color-accent`,
  `--color-accent-hover`, `--color-accent-soft`, `--color-accent-contrast`,
  `--color-danger` (+`-soft`), `--color-warning` (+`-soft`), `--color-success`
  (+`-soft`)
- **Canvas** — `--canvas-bg`, `--canvas-grid`, `--canvas-grid-strong`,
  `--canvas-selection`, `--canvas-marquee-fill`, `--canvas-marquee-stroke`,
  `--draw-default-stroke`, `--draw-default-fill`
- **Chrome** — `--panel-bg`, `--panel-bg-solid`, `--panel-border`,
  `--panel-blur`, `--scrim`
- **Spacing** — `--sp-0` … `--sp-8` (4px base)
- **Radii** — `--radius-xs` `sm` `md` `lg` `pill`
- **Shadows** — `--shadow-1` `2` `3`, plus `--ring`
- **Type** — `--font-sans`, `--font-mono`; `--fs-xs|sm|md|lg|xl|2xl` each
  paired with `--lh-xs|sm|md|lg|xl|2xl`; `--fw-normal|medium|semibold`
- **Motion** — `--ease`, `--dur-fast`, `--dur-mid`
- **Layout/z-index** — `--toolbar-width`, `--touch-target`, `--topbar-height`,
  `--statusbar-height`, `--z-canvas|flow|toolbar|panels|dialog|toast`

### Theming

Dark mode is fully defined, not a partial override. The ui agent's theme
toggle sets `document.documentElement.dataset.theme = 'dark' | 'light'`.
Until then, the OS preference wins via `@media (prefers-color-scheme: dark)`
keyed on `:root:not([data-theme='light'])`, so an explicit choice always beats
the OS. `<meta name="color-scheme" content="light dark">` in `index.html`
keeps native form controls and scrollbars in step.

### Pointer events

A closed panel must use `display: none` (or be unmounted) — never
`visibility: hidden` or `opacity: 0` — or it silently swallows canvas
gestures. The canvas itself carries `touch-action: none` and `user-select: none`
(`global.css`, `.canvas-host`).

### Shared class names

`global.css` / `toolbar.css` / `panels.css` define these for reuse:
`.sr-only`, `.mono`, `.app-shell`, `.canvas-host`, `.flow-host`, `.btn` +
`.btn--primary|ghost|danger|icon`, `.panel` + `.panel__title|body|footer`,
`.field`, `.divider`, `.toolbar` / `.toolbar__group` / `.tool-btn` /
`.tool-btn__icon` / `.tool-btn__key`, `.swatch-grid` / `.swatch`, `.segmented`,
`.size-slider`, `.top-bar`, `.status-bar` + `.conn-dot[data-state]`, `.roster`,
`.board-list`, `.backdrop` / `.dialog`, `.help-overlay` / `.shortcut-grid` /
`.shortcut-row`, `.export-option`, `.toast-area` / `.toast`, `.live-region`.

## Production

```bash
# build context is the repo root (it needs packages/shared)
docker build -f apps/web/Dockerfile -t whiteboard-web .
docker run --rm -p 8080:8080 whiteboard-web
```

The image is multi-stage (node:22-slim builds, nginx:alpine serves) and runs
as the non-root `nginx` user on port 8080. `nginx.conf` provides the SPA
fallback, immutable caching for hashed `/assets/`, `no-cache` for
`index.html`, gzip, and a CSP whose `connect-src` covers the API and
`ws:`/`wss:`.

Set `VITE_API_URL` / `VITE_WS_URL` at build time and match `$api_origin` in
`nginx.conf` to the deployed API origin, otherwise the browser's CSP blocks
the WebSocket.
