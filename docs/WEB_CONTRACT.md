# Web contract — apps/web

Authoritative for the frontend. Plain JSX (no TypeScript), React 18, Vite 5.

**Rule for every agent on this app: you own your files exclusively. If you
need something from another agent's file, import it by the name in this
document. If it does not exist yet, code against the contract and move on —
do not create the other agent's file, and do not edit files you do not own.**

## Module map and ownership

| Path | Owner | Contents |
| --- | --- | --- |
| `package.json`, `vite.config.js`, `index.html`, `.env.example`, `Dockerfile`, `nginx.conf`, `src/main.jsx`, `src/styles/**` | **scaffold** | build config, entry, CSS tokens |
| `src/store/**`, `src/api/**`, `src/realtime/**` | **store** | state, query layer, WS client |
| `src/canvas/**` | **canvas** | renderer, hit-test, pointer state machine |
| `src/flow/**`, `src/dnd/**` | **flow** | React Flow layer, dnd-kit palette |
| `src/ui/**`, `src/App.jsx` | **ui** | toolbar, panels, dialogs, page shell |

## Dependency versions (scaffold pins these in package.json)

`react@^18.3`, `react-dom@^18.3`, `reactflow@^11.11`, `@tanstack/react-query@^5`,
`zustand@^4.5`, `@dnd-kit/core@^6.1`, `@dnd-kit/sortable@^8`, `nanoid@^5`.
Dev: `vite@^5.4`, `@vitejs/plugin-react@^4.3`.

## The store — everything else codes against this

`src/store/boardStore.js` exports a zustand store. `src/store/index.js`
exports the React bindings. **Read `src/store/boardStore.js` for the real
shape; the shape below is what the canvas, flow and ui agents code against.**

```js
import { useBoardStore, useSelector } from '../store/index.js';
```

State:
```js
{
  boardId: string|null,
  board: Board|null,
  elements: Element[],          // z-order, index 0 = furthest back
  rev: number,
  status: 'idle'|'loading'|'ready'|'error',
  error: string|null,

  // interaction
  tool: Tool,                   // from TOOLS in @whiteboard/shared
  style: { stroke, fill, strokeWidth, strokeStyle, stickyFill },
  view: { zoom, panX, panY },
  gridSize: number,             // 0 = snapping off
  snapEnabled: boolean,

  selection: Set<string>,       // element ids
  hoveredId: string|null,
  editingId: string|null,       // element being edited in place
  marquee: Rect|null,           // live drag-select rect, board units

  // collaborators
  peers: Peer[],                // includes YOU (id === myPeerId)
  myPeerId: string|null,
  remoteCursors: Map<string, {x, y, name, color, at}>,

  // history
  canUndo: boolean, canRedo: boolean,
  pastDepth: number, futureDepth: number,
}
```

Actions (all synchronous unless noted):
```js
// board lifecycle
setBoardId(id), setBoard(board), setSnapshot({board, elements, rev}),
setStatus(s), setError(e)

// elements — the ONLY way elements change
addElement(el),                 // push, re-indexes z-order
addElements(els),               // batch, one history entry
updateElement(id, patch),       // shallow merge + rebox
updateElements(patches[]),      // batched drag
removeElements(ids[]),          // set-based; also detaches connectors
reorder(orderedIds),            // full z-order set
replaceAll(els),                // clear + set (used by undo/redo and resync)

// selection
select(ids, {additive}), toggleSelect(id), clearSelection(),
setHovered(id), setEditing(id), setMarquee(rect)

// tool & style
setTool(t), setStyle(patch), setGridSize(n), toggleSnap()

// view
setView(v), setZoom(z), setPan(x, y), panBy(dx, dy),
zoomAtScreen(screenPt, factor), fitToContent(), resetView()

// history
commit(label),                 // snapshot before a mutation; call BEFORE mutating
undo(), redo(),

// peers
setMyPeerId(id), setPeers(peers), upsertCursor(peerId, cur), pruneCursors(now)
```

### Two rules that make undo and sync work

1. **History**: call `commit(label)` *before* mutating elements. The store
   keeps a bounded stack (50) of element snapshots. `undo`/`redo` call
   `replaceAll`.
2. **Sync**: mutations are optimistic and go through the realtime client's
   outbox (see below). `store` owns `addElement` et al.; `realtime` observes
   them via a subscription and ships the corresponding ops. Nobody else calls
   the network.

## API + query layer (`src/api/`)

```js
import { api } from '../api/client.js';
import { useBoardSnapshot, useBoards, useCreateBoard, useApplyOps, useUpdateBoard, useDeleteBoard } from '../api/queries.js';
```

`client.js` exports `api` with `{get, post, patch, del}` against
`import.meta.env.VITE_API_URL` (default `http://localhost:3001/api`), plus
`ApiError` carrying `status` and `code`. It reads `localStorage.whiteboard:peer:{boardId}`
to attach a stable `actorId`, so the same browser is recognisable across
reconnects.

`queries.js` wraps these in TanStack Query. Query keys are
`['board', id]`, `['snapshot', id]`, `['boards']`. On a 409 from `applyOps`,
invalidate `['snapshot', id]` and drop the outbox — that is the resync path.
`QueryClient` defaults: `staleTime: 5_000`, `retry: 1`.

## Realtime (`src/realtime/`)

```js
import { useRealtime, realtime } from '../realtime/useRealtime.js';
```

`useRealtime(boardId)` opens the WS, sends `join`, and wires:
- `ready` → `store.setSnapshot(...)`, `store.setMyPeerId(...)`
- `op` → apply remote ops to the store WITHOUT re-broadcasting
- `peer-cursor` / `presence` → `store.upsertCursor` / `store.setPeers`
- `resync` → invalidate the snapshot query

`realtime` is a module-level singleton (so the outbox survives remounts) with
`connect(boardId)`, `disconnect()`, `sendOps(ops)`, `sendCursor(p)`, and
`outbox` — ops queued while offline and flushed in order on reconnect. The
store subscription that turns element mutations into ops lives in
`src/realtime/sync.js`; it must not re-enter on its own writes (compare
`peerId`/a local mutation token).

## Canvas (`src/canvas/`)

`<Canvas />` is a single `<canvas>` plus an absolutely-positioned overlay
`<div>` for in-place text editing. It owns no global state — it reads the store
and dispatches to it.

- `renderer.js` — `draw(ctx, {elements, view, ...})`. Draws in z-order, then
  grid, then selection/marquee, then remote cursors. Uses
  `screenToBoard`/`boardToScreen` from `@whiteboard/shared`.
- `shapes.js` — one `draw<Type>` per element type. Shared with the SVG export,
  so it must be a pure function of `(ctx, el, view)` with no store access.
- `hitTest.js` — `hitTest(elements, boardPoint, tolerance)` → topmost id.
  Diamond uses `pointInPolygon`; pen/connectors use `distToSegmentSq`; shapes
  test the outline and the interior.
- `interaction.js` — a pure reducer:
  `reduceInteraction(state, event, ctx) → {state, effects}` where `effects` are
  `{commit, addElement, updateElement, removeElements, select, setView}`. This
  is so the pointer state machine is testable without a DOM.
- `textEdit.js` — a positioned `<textarea>` over the canvas for `text` and
  `sticky`, auto-sized, committing on blur/Escape/Ctrl+Enter.

Pointer capture via `setPointerCapture`; `touch-action: none` on the canvas.

## React Flow layer (`src/flow/`)

`FlowLayer.jsx` renders a `<ReactFlow>` *underneath* the whiteboard canvas
(lower z-index, pointer-events pass through except on nodes). Its job is the
structural view: containers and grouped regions.

- Every element that has a `flow` flag (containers, sticky clusters) becomes
  a node: `position: {x: el.x, y: el.y}`, `data: {elementId}`, `draggable: true`.
- `onNodesChange` → `commit()` + `updateElements` with new x/y (React Flow
  reports `position` deltas; apply them absolutely).
- A flow node marked `container: true` renders as a dashed frame with a title
  and does not paint its own contents on the canvas.
- `useFlowSync` keeps the two layers consistent when an element is dragged on
  the canvas while it is also a flow node, and vice versa — one direction wins
  per interaction (the one that started it), tracked in a ref.
- `MiniMap` and `Controls` off by default; they fight the whiteboard's own
  navigation.

## DnD palette (`src/dnd/`)

dnd-kit `DndContext` over the whole app with the preset palette as draggables
and the canvas as a droppable. `data: {preset: PresetShape}`. On drop, the
canvas's `interaction` reducer receives a `drop` effect with the board point
and creates the element from the preset. Use `@dnd-kit/sortable` for the
reorderable layer list inside the flow layer.

## UI (`src/ui/`)

Components read the store; none of them mutate element arrays directly
except `Toolbar`/`Presets`, which call the documented actions.

`Toolbar` — tool buttons (one per `TOOLS`, with keyboard hints), style
controls (stroke colour, fill, width, dash), grid size, snap toggle, undo/redo.
`TopBar` — board title (inline-editable), board switcher, theme toggle, share
link, presence roster, export button.
`StatusBar` — zoom %, cursor position in board units, element count, connection
state, last error.
`HelpOverlay` — shortcut sheet, from a single table in `src/ui/shortcuts.js`.
`ExportDialog` — SVG / PNG / JSON, built on `src/canvas/export.js`.
`BoardList` — create, open, duplicate, delete boards (TanStack Query).
`PeerRoster` — avatars coloured by `colorForPeer`, showing each peer's tool.

## Keyboard (single source of truth: `src/ui/shortcuts.js`)

`1-9` tools, `0`/`Esc` select, `Space` (held) pan, `V` select, `H` hand,
`P` pen, `R` rect, `O` ellipse, `D` diamond, `C` cylinder, `S` sticky,
`T` text, `A` arrow, `L` line, `E` eraser, `Ctrl+Z` undo, `Ctrl+Shift+Z` redo,
`Ctrl+A` select all, `Delete` delete, `Ctrl+D` duplicate, `Ctrl+C/V/X`,
`Ctrl+0` reset zoom, `Ctrl+1` zoom to fit, `+`/`-` zoom, `Shift+drag`
multi-select, `?` help, `G` toggle grid, `K` toggle snap.

## Env

`VITE_API_URL` (default `http://localhost:3001/api`),
`VITE_WS_URL` (default derived from `VITE_API_URL`, `/api` → `/api/ws`).
Vite `define` must not inline `import.meta.env` in the API.

## Definition of done (every agent)

- `npm run build -w @whiteboard/web` passes with no errors.
- No `console.log` left behind.
- No file outside your ownership list is modified.
