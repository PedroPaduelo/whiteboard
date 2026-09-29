# Editor contract

The architecture reference for the web editor: the names, shapes and rules
the modules of `apps/web` (and the parts of `@whiteboard/shared` they rely on)
agree on. When code and this document disagree, one of them is a bug; fix the
code or update this document in the same change.

**Goal.** The editor looks and behaves like Excalidraw: a single HTML canvas
with a hand-drawn look (roughjs), smooth freehand (perfect-freehand), the
Virgil handwriting font, Excalidraw's tool island / properties panel / menu
layout and keyboard map. React Flow and dnd-kit are removed. We KEEP our own
element model (`@whiteboard/shared`), the zustand board store and undo, the
op-based realtime sync, and the Fastify API.

**UI language.** All user-facing strings are Brazilian Portuguese and live in
`apps/web/src/ui/strings.js` (one exported object `t`). Code comments stay in
English, matching the codebase.

**Foundation modules** (small, shared by every area below; change them with care):

- `apps/web/src/editor/constants.js` — palettes, `DEFAULT_STYLE`, sizes, fonts, handle sizes, zoom steps. The enums `FILL_STYLES`, `STROKE_STYLES`, `ROUNDNESS`, `ARROWHEADS`, `TEXT_ALIGNS` are RE-EXPORTED from `@whiteboard/shared`, never declared again (a web copy of `FILL_STYLES` once lacked `'zigzag'`).
- `apps/web/src/editor/text.js` — `fontString`, `measureLine`, `measureText`, `wrapText`, `trimTrailingSpaces`, `labelKeyOf`, `textOf`, `labelBox`, `layoutText`, `fitTextElement`, `textColorOf`, `lineHeightPx`.
- `apps/web/src/editor/elements.js` — `newId`, `randomSeed`, `isLinear`, `isFreedraw`, `hasPoints`, `isText`, `isBindable`, `isContainer`, `isRotatable`, `styleKeysFor(type)`, `styleKeysForTool(tool)`, `styleKeysForElement(el, {editing})`, `createElement(type, geom, style, extra)`, `cloneElements(elements, {dx, dy})`.
- `apps/web/src/editor/tools.js` — `TOOLBAR`, `TOOL_BY_ID`, `BOX_TOOLS`, `LINEAR_TOOLS`, `toolForKey(key)`.
- `apps/web/src/editor/handles.js` — `rotateAround`, `elementCorners`, `elementBounds`, `commonBounds`, `selectionFrame(selected, zoom)`, `HANDLE_KEYS`, `transformHandles(frame, zoom, opts)`, `hitHandle(frame, p, zoom, opts)`, `cursorForHandle(key, rotation)`.
- Fonts: `apps/web/public/fonts/Virgil-Regular.woff2`, `apps/web/public/fonts/CascadiaCode-Regular.woff2` (both SIL OFL 1.1, from the Excalidraw distribution).
- Dependencies `roughjs` and `perfect-freehand` are installed in `apps/web`.

The editor used to be a React Flow layer plus a separate pen canvas
(`apps/web/src/flow/`, `dnd/`, `canvas/`). Those were removed in the rewrite;
nothing may import them again.

---

## 1. Element model (`packages/shared`)

All new fields are OPTIONAL, so every existing board stays valid. Add each to
`validateElement` AND to `PATCHABLE` + `sanitisePatch` (otherwise creates keep
them and updates drop them, or the reverse). Export the enums from `types.js`.

| Field | Types | Values |
| --- | --- | --- |
| `seed` | all | integer 0..2^31-1 (roughjs seed) |
| `roughness` | all | number 0..2 (0 architect, 1 artist, 2 cartoonist) |
| `fillStyle` | all | `FILL_STYLES` = `'hachure'\|'cross-hatch'\|'solid'\|'zigzag'` |
| `roundness` | all | `ROUNDNESS` = `'sharp'\|'round'` |
| `fontFamily` | text, sticky, rect, ellipse, diamond, cylinder | `FONT_FAMILY_KEYS` = `'hand'\|'normal'\|'code'` |
| `fontSize` | text (default 24 as today), sticky, rect, ellipse, diamond, cylinder (optional, no default) | 4..512 |
| `align` | text, sticky, rect, ellipse, diamond, cylinder | `'left'\|'center'\|'right'` |
| `label` | rect, ellipse, diamond, cylinder (optional string ≤ MAX_LABEL); sticky (required, as today) | text shown inside the shape |
| `startArrowhead`, `endArrowhead` | arrow, line | `ARROWHEADS` = `'none'\|'arrow'\|'triangle'\|'bar'\|'dot'` |
| `points` on arrow/line | arrow, line | **2..MAX_POINTS points** (was exactly 2) — multi-point connectors |

Nullable in patches (null means "remove the field", exactly like `groupId`
today): `startId`, `endId`, `groupId`. `validateElement` already drops nulls,
so a null patch removes the binding on the server.

Rendering defaults for fields that are absent (legacy elements): `roughness`
1, `fillStyle` `'solid'` (legacy fills were solid), `roundness` `'sharp'`,
`fontFamily` `'hand'`, arrow `endArrowhead` `'arrow'` / `startArrowhead`
`'none'`, line both `'none'`, `seed` = FNV-1a hash of the id.

`groupId` semantics (Excalidraw groups): an opaque group key. Elements with the
same `groupId` select, move and delete together. If an element's own `id`
equals some other element's `groupId` (legacy frames), it is a member of that
group too.

**Connectors** (`geometry.js`): `resolveConnectors` must support ≥2 points.
Only the first and last points are ever moved by binding. A bound end aims:
- 2 points, both ends bound: at the other anchor's centre (as today);
- otherwise: at its adjacent point (`points[1]` for the start,
  `points[n-2]` for the end).
`connectorEndpoint(el, toward, gap = 0)` becomes rotation- and outline-aware:
rect/sticky/text/image/cylinder use the box, ellipse the ellipse, diamond the
diamond polygon, all in the element's unrotated frame (rotate `toward` in,
rotate the result out), then push the point `gap` units outward along the ray.
`resolveConnectors` uses `BIND_GAP = 4` (exported). It must stay idempotent.

`types.js` also exports `TOOLS` with `'image'` added (keep the existing
entries), and `WS_MSG.BOARD = 'board'` (server → client: board metadata
changed, payload `{type:'board', board}`).

## 2. Server behaviour (`apps/api`)

- WS ack and REST op results carry `applied: string[]` (opIds applied) in
  addition to `appliedOps`. The WS ack omits the full `elements` list (REST
  keeps it). Update `OpResult` in `types.js` and add `'missing'` and
  `'error'` to `OP_RESULT`.
- `ws/plugin.js` `onOps`: wrap `store.applyOps` in try/catch and ack
  `{status:'error', message, code}`. Never leave a batch un-acked.
- On `conflict`/`missing`, send `resync` ONLY to the sender, not the room.
- Ops without `baseRev` are last-writer-wins (already true); the web client
  will stop sending `baseRev` on WS ops.
- `PATCH /boards/:id` broadcasts `{type:'board', board}` to the room.
- `DELETE /boards/:id/elements` broadcasts a real `{kind:'clear', opId}` op.
- `server.js`: pass `{peerTtlMs: config.wsPeerTtlMs, cursorRateMs:
  config.wsCursorRateMs}` to `Hub`, pass `opDedupeTtlMs` to `createStore`.
  Declare `fastify-plugin` in `apps/api/package.json`. WS path is
  `${apiPrefix}/ws`.
- Rewrite `DEMO_ELEMENTS` (server.js) in the new model: shapes carry their
  text in `label` (no more separate `*-lbl` text elements), arrows bound with
  `startId`/`endId`, a sticky, a short freehand squiggle, a title text; every
  element has a `seed`, `roughness: 1`, `fillStyle: 'hachure'` where filled,
  `roundness: 'round'` on rects, `fontFamily: 'hand'`. Texts in Portuguese.
- Update `docs/API_CONTRACT.md` to match.

## 3. Store (`apps/web/src/store/boardStore.js`)

Everything in the current store stays. Add / change:

```js
// state
style: { ...DEFAULT_STYLE }          // from editor/constants.js (replaces DEFAULT_PALETTE)
toolLocked: false                    // Excalidraw "keep selected tool active after drawing" (Q)
viewportSize: { w: 0, h: 0 }         // CSS px of the canvas element, set by Canvas on resize
snapEnabled: false                   // grid mode off by default, like Excalidraw
gridSize: 20
connection: 'idle'                   // mirrors realtime status: idle|connecting|connected|offline|disconnected

// actions
setToolLocked(bool), toggleToolLocked()
setViewportSize({w, h})
setConnection(status)
applyRemoteOps(ops)                  // apply a batch, then ONE resolveConnectors pass; no history
```

- `updateElement(s)` / `applyRemoteOp(s)`: a patch value of `null` deletes
  that key from the element (used for `startId`/`endId`/`groupId`).
- `setTool(tool)` clears `editingId`. Choosing any tool other than `select`
  clears the selection (Excalidraw behaviour) — EXCEPT keep selection when the
  tool is `select`/`hand`.
- `commit(label)` is unchanged (coalesces same label within 500 ms). Gesture
  code uses a unique label per gesture (`move:<gestureId>`), property edits use
  one label per control (`style:stroke`) so a slider drag is one undo step.
- `undo()`/`redo()` still go through `replaceAll`, but sync must encode them as
  a normal DIFF (create/update/delete of what changed), never `clear` +
  re-create: that wiped collaborators' work.

## 4. Realtime (`apps/web/src/realtime`, `apps/web/src/api`)

- `RealtimeClient`: exactly one in-flight batch (`inflight`) separate from
  `outbox`; `_flush` is a no-op while something is in flight; an ack with
  `applied`/`duplicate` clears the in-flight batch and flushes the next;
  `error` drops it, reports it (`handlers.onError`) and triggers a resync;
  `conflict` → resync. Never re-send an erroring batch. Do not stamp `baseRev`.
- Resync is real: fetch the snapshot and apply it with
  `withRemote(() => setSnapshot(...))`, then re-apply still-unacked local ops
  on top (so the author keeps seeing their pending edits). `ready` after a
  reconnect does the same. Clearing the outbox on socket failure is removed
  (offline edits survive until reconnect).
- Switching boards clears the outbox and in-flight batch.
- `WS_URL` resolves to an absolute `ws(s)://` URL from `location`.
- Cursor: `realtime.sendCursor({x, y})` in BOARD units — the Canvas calls it
  (throttled by the client to 33 ms). `peer-cursor` envelopes carry `name` and
  `color`; store them in `remoteCursors`.
- Presence name is the nickname (`useNickname()`), not a random guest name;
  send `activity` with the current tool on tool change.
- `board` messages → `store.setBoard(board)`.
- The connection status is pushed to `store.setConnection` (no polling).
- `api/queries.js` `useUpdateBoard(id).mutate({title})` must PATCH
  `/boards/<id>` with `{title}`.

## 5. Module map

| Path | Area |
| --- | --- |
| `packages/shared/**`, `apps/api/**`, `docs/API_CONTRACT.md`, `scripts/seed-showcase.mjs` | **model** |
| `apps/web/src/store/boardStore.js`, `store/index.js`, `store/store.test.js`, `apps/web/src/realtime/**`, `apps/web/src/api/**`, `apps/web/test/realtime.test.js` | **sync** |
| `apps/web/src/editor/render/**`, `apps/web/src/editor/export/**`, `apps/web/src/editor/fonts.js`, `apps/web/test/render.test.js`, `apps/web/test/export.test.js` | **render** |
| `apps/web/src/editor/scene.js`, `editor/hitTest.js`, `editor/interaction.js`, `editor/Canvas.jsx`, `editor/TextEditor.jsx`, `editor/image.js`, `apps/web/test/scene.test.js`, `apps/web/test/hitTest.test.js`, `apps/web/test/interaction.test.js` | **interaction** |
| `apps/web/src/App.jsx`, `main.jsx`, `apps/web/src/ui/**`, `apps/web/src/styles/**`, `apps/web/src/editor/actions.js`, `apps/web/src/store/presets.js`, `apps/web/index.html`, `apps/web/vite.config.js`, `apps/web/package.json`, `apps/web/test/actions.test.js`, `apps/web/test/shortcuts.test.js` | **ui** |
| `apps/web/src/editor/{constants,text,elements,tools,handles}.js`, `apps/web/test/text.test.js`, `apps/web/test/elements.test.js`, `docs/EDITOR_CONTRACT.md`, fonts, `README.md`, `apps/*/README.md`, root `package.json` | **core** (foundation) |

## 6. Rendering (area: render)

The static canvas and the interactive canvas are both sized in DEVICE px
(`canvas.width = cssW * dpr`). Every render function sets its own transform:
`ctx.setTransform(dpr*zoom, 0, 0, dpr*zoom, dpr*panX, dpr*panY)` for board
space, `ctx.setTransform(dpr,0,0,dpr,0,0)` for screen-space overlays. View
convention everywhere: `screen = board * zoom + pan`.

```js
// editor/fonts.js
export function loadFonts(): Promise<void>      // FontFace for Virgil + Cascadia from /fonts/*.woff2; resolves when loaded (or failed)
export function onFontsLoaded(cb): () => void   // subscribe; renderer invalidates text measurements/caches

// editor/render/renderElement.js
export function drawElement(ctx, el, { zoom, imageCache, isEditing }) // ctx in BOARD space; handles rotation, opacity
export function getImage(src, onLoad): HTMLImageElement|null          // cached loader; onLoad triggers a repaint
export function invalidateElementCache(el)                             // optional

// editor/render/renderScene.js
export function renderStatic(ctx, {
  elements, view, width, height, dpr,      // width/height in CSS px
  showGrid, gridSize,
  editingId,                               // text of this element is NOT painted (the textarea shows it)
  erasingIds,                              // Set|null: painted at 30% opacity
  draft,                                   // element being created (not in store yet) or null
  onImageLoad,                             // () => void, schedule a repaint
})
export function renderInteractive(ctx, {
  elements, selection /*Set*/, view, width, height, dpr,
  interaction,                             // reducer state, see §7 (marquee, bindTarget, linearEdit, eraserTrail, mode)
  remoteCursors /*Map peerId -> {x,y,name,color,at}*/, myPeerId,
  hoveredId, editingId,
  peerSelections,                          // optional Map peerId -> {ids:string[], color}
})
```

Look (Excalidraw):
- White canvas; dark mode is applied by the Canvas component as a CSS filter
  `DARK_MODE_FILTER` on both canvases — the renderer always draws light colours.
- Grid (when `showGrid`): light grey lines every `gridSize`, a darker line every
  5th, only when zoom ≥ 0.3.
- Shapes through `rough.generator()` with `{seed, roughness, stroke, strokeWidth,
  fill, fillStyle, hachureGap: strokeWidth*4, fillWeight: strokeWidth/2,
  strokeLineDash (dashed [8,8+sw], dotted [1.5, 6+sw]), preserveVertices for
  roughness 0}`; drawables cached in a WeakMap keyed by the element object (the
  store replaces objects on change, so the cache invalidates itself).
- `roundness: 'round'` rects are drawn as a rounded path (radius
  `min(w,h)*0.25`, max 32); round diamonds with rounded vertices.
- `cylinder`: rough path (top ellipse + sides + bottom arc). `sticky`: a crisp
  filled rounded rect with a soft shadow (not rough), label in the note.
- `arrow`/`line`: rough linear path through all points; `roundness: 'round'`
  with >2 points is a smooth curve (`curve`); arrowheads per
  `startArrowhead`/`endArrowhead` (arrow = two strokes 25° off the tangent,
  length `min(30, 4*sw + 10)` scaled down for short arrows; triangle filled;
  bar; dot).
- `pen`: `getStroke(points, {size: strokeWidth*4.25 (min 4), thinning: 0.6,
  smoothing: 0.5, streamline: 0.5, simulatePressure: true, last: true})`,
  filled as a Path2D, cached per element.
- `text` and labels: `layoutText(el)` from `editor/text.js`, `textBaseline =
  'top'`, colour `textColorOf(el)`.
- `image`: drawImage into the box; a light placeholder rect while loading.
- Interactive layer: selection outline (dashed `SELECTION_COLOR`, frame from
  `selectionFrame`), handles from `transformHandles` (white squares with a
  `SELECTION_COLOR` border, round rotation handle), single selected LINEAR
  element shows its point handles instead of the box handles (`linearEdit`),
  marquee (translucent violet fill + border), bind target highlight (thick
  translucent outline around `interaction.bindTarget`), eraser trail (fading
  grey polyline), remote cursors (pointer arrow + name tag in the peer colour),
  optional peer selection outlines. Locked elements: no handles.

```js
// editor/export/export.js — pure where possible; SVG uses generator.toPaths (no DOM)
export function exportToSvg(elements, { background: true, dark: false, padding: 10, scale: 1 }): string
export async function exportToPngBlob(elements, { background: true, dark: false, padding: 10, scale: 2 }): Promise<Blob>   // renders with drawElement on an offscreen canvas
export function serializeBoard(elements, { board }): string          // JSON: {type:'whiteboard', version: 2, source, board, elements}
export function parseBoardFile(text): { ok: true, elements, board } | { ok: false, error }   // accepts version 1 and 2, validates each element with tryValidateElement, re-ids nothing
export function downloadBlob(blobOrString, filename, mime)
export async function copyBlobToClipboard(blob)                      // PNG to clipboard where supported
```
SVG export must embed the Virgil/Cascadia fonts as `@font-face` with a data URL
only when text is present (fetch `/fonts/…woff2` → base64; in node tests fall
back to the family name).

## 7. Interaction (area: interaction)

```js
// editor/scene.js — pure geometry over elements (no DOM)
export function groupMembers(elements, groupId): object[]
export function expandSelectionToGroups(elements, ids: string[]): string[]
export function moveElements(originals: object[], dx, dy): {id, patch}[]           // polylines move points; boxes move x/y
export function resizeElements(originals, frame, handle, pointer, { keepAspect, fromCenter }): {id, patch}[]  // single rotated element or multi (scales positions and sizes; text scales fontSize; polylines scale points)
export function rotateElements(originals, frame, pointer, { snap15 }): {id, patch}[]
export function resolveBindingPatches(nextElements, changedIds): {id, patch}[]      // re-resolve connectors touching changed elements (shared resolveConnectors), only those whose points changed
export function findBindTarget(elements, point, zoom, excludeIds): object|null     // BIND_DISTANCE screen px, bindable types only, topmost
export function snapToGrid(point, gridSize, enabled): {x,y}

// editor/hitTest.js
export function hitElement(el, p, zoom): boolean          // painted-shape test with HIT_TOLERANCE/zoom (Excalidraw semantics): filled closed shapes hit in the interior; UNFILLED ones hit only on the outline band ±tol, unless they carry a non-empty label (then interior too); text/sticky/image always hit in the box; linear/pen hit near the stroke. Separately, the reducer treats a pointerdown INSIDE the current selection frame as "grab the selection" (so a selected transparent rect can be dragged by its interior).
export function hitTest(elements, p, zoom, { skipLocked = false }): object|null     // topmost
export function hitTestAll(elements, p, zoom): object[]                             // topmost first
export function elementsInMarquee(elements, rect): string[]                         // fully contained (Excalidraw semantics)
export function hitLinearPoint(el, p, zoom): number                                 // index or -1

// editor/interaction.js — pure reducer, unit-tested in node
export function initialInteraction(): InteractionState
export function reduce(state, event, ctx): { state, effects: Effect[] }
```

`event`: `{ type: 'pointerdown'|'pointermove'|'pointerup'|'pointercancel'|'dblclick'|'keydown'|'keyup'|'blur', x, y /* CSS px relative to the canvas */, button, buttons, shiftKey, altKey, mod /* ctrl or meta */, pointerType, pointerId, key, pressure }`

`ctx`: `{ elements, selection /*Set*/, tool, toolLocked, style, view, gridSize, snapEnabled, editingId, now, spaceDown }`

`Effect` (applied in order by Canvas.jsx against the store):
```
{type:'commit', label}
{type:'addElements', elements}
{type:'updateElements', patches}
{type:'removeElements', ids}
{type:'select', ids}                 // replaces the selection
{type:'setTool', tool}
{type:'panBy', dx, dy}               // screen px
{type:'zoomAt', x, y, factor}        // screen px
{type:'startTextEdit', id, element?} // element present when it is a NEW text not yet in the store
{type:'setHovered', id}
{type:'contextMenu', x, y, targetId} // right click; UI opens the menu
```

`InteractionState` (read by the renderer): `{ mode:
'idle'|'panning'|'marquee'|'moving'|'resizing'|'rotating'|'creating'|'freedraw'|'linear'|'editingPoint'|'erasing',
draft, marquee, bindTarget, erasingIds, eraserTrail, linearEdit: {id,
hoverIndex, activeIndex}|null, cursor }` plus any private fields.

Behaviour (Excalidraw):
- select: click selects topmost (group-expanded); Shift-click toggles;
  drag on empty space = marquee (fully contained); drag on element = move
  selection (Alt-drag duplicates); handles resize (Shift keeps aspect, Alt from
  centre), rotation handle rotates (Shift snaps 15°); locked elements can be
  selected by click only when nothing else is under the cursor and never move.
  Double-click text → edit; double-click container → edit its label;
  double-click empty canvas → new text at that point; double-click linear →
  point editing. Moving a shape moves bound arrows live.
- box tools: drag to size (Shift square, Alt from centre); a click without drag
  creates DEFAULT_SHAPE_SIZE centred on the pointer; then selects it and
  returns to `select` unless `toolLocked`. Sticky: click places STICKY_SIZE and
  opens the label editor.
- arrow/line: drag creates a 2-point connector; click-click-click creates a
  multi-point one (Enter/Escape/double-click finishes, clicking the last point
  finishes); ends bind to shapes within BIND_DISTANCE (highlight target).
  Selected linear element: drag its points; dragging an end off a shape
  unbinds it (patch `startId: null`), onto a shape binds it.
- pen: points collected locally (min spacing FREEDRAW_MIN_SPACING / zoom),
  drawn as the draft, added on pointerup (one commit). Stays on pen tool.
- text: click → new text editor at the point (element added on commit only if
  non-empty); clicking an existing text edits it.
- eraser: drag marks every element under the path (all types, group-expanded),
  pointerup removes them in one commit; Alt-drag restores (unmark).
- hand / Space-drag / middle-drag: pan. Wheel: pan; Ctrl/⌘+wheel and pinch:
  zoom at the pointer. Shift+wheel: horizontal pan.
- The live draft (new shape/freehand/linear) is not in the store until
  finished. Moves/resizes/rotations/point drags write to the store every frame
  (`updateElements`) after ONE `commit` at the first real movement, so peers
  see them live; bound connectors are re-resolved in the same patch batch.

```js
// editor/Canvas.jsx
export default function Canvas({ theme, onContextMenu, onRequestImage })
// Owns two <canvas> (static + interactive) filling its parent, a ResizeObserver
// (→ store.setViewportSize), pointer/wheel/touch/keyboard (Space, Escape,
// Enter, arrow keys only while a gesture is active) wiring, a rAF render loop
// driven by store.subscribe (no React re-render per frame), the TextEditor
// overlay, cursor broadcast (realtime.sendCursor, board units), and drop/paste
// of image files (editor/image.js). Sets the CSS cursor from interaction state.

// editor/TextEditor.jsx
export default function TextEditor({ element, isNew, view, theme, onCommit(text), onCancel() })
// A <textarea> positioned and styled with layoutText (same font, size,
// line-height, alignment, rotation, zoom) so the text does not jump between
// editing and painting. Enter inserts a newline; Escape or Ctrl/⌘+Enter or
// blur commits (Escape commits too, like Excalidraw); empty new text is
// discarded; empty existing text element is deleted.
// Labels: the textarea uses `white-space: pre-wrap` and
// `overflow-wrap/word-break: break-word`, and `text.js` `wrapText` follows the
// same rules (checked against Chromium), so both break lines in the same
// places: after spaces and after hyphens/dashes/`?`, never at a no-break
// space; spaces at a soft wrap hang (no extra line, not counted for
// alignment); spaces before a `\n` count for alignment up to the box width;
// a word wider than the box goes to its own line and is broken between
// graphemes. The textarea's height comes from `wrapText`'s line count.

// editor/image.js
export async function fileToImageElement(file, at /*board point*/, style): Promise<object>  // downscale to IMAGE_MAX_SIDE, data URL ≤ IMAGE_MAX_CHARS
export function openImagePicker(): Promise<File|null>
```

## 8. UI (area: ui)

Layout (Excalidraw islands, all floating over the full-screen canvas):
- **Top-left**: hamburger `MainMenu` — Abrir (JSON), Salvar em arquivo,
  Exportar imagem…, Compartilhar (copy link), Limpar quadro (confirm), Meus
  quadros (back to list), Alterar nome, Tema claro/escuro, Grade on/off,
  Ajuda.
- **Left, below the menu**: `PropertiesPanel`, visible when a drawing tool is
  active (keys from `styleKeysForTool`) or the selection is non-empty (union of
  `styleKeysFor` of the selected types, or of `styleKeysForElement` per
  selected element, which leaves font/size/alignment out for a shape without a
  label). `styleKeysForTool(tool)` lists only keys the new element takes from
  the default style, so every control shown changes what gets drawn: the line
  tool shows no arrowheads (new lines have none; a selected line does show
  them), the rect/diamond/ellipse/cylinder tools show no font, size or
  alignment (a new shape has no label; its label is centred). Shape labels
  are aligned with `align` like text and stickies (absent = centre); a new
  sticky takes `style.align`. Sections: Traço (STROKE_COLORS + custom
  colour), Fundo (BACKGROUND_COLORS + custom), Preenchimento (FILL_STYLES, only
  with a background), Espessura (STROKE_WIDTHS), Estilo do traço, Traçado
  (ROUGHNESS), Bordas (ROUNDNESS), Pontas de seta (start/end), Fonte
  (FONT_FAMILIES), Tamanho (FONT_SIZES), Alinhamento, Opacidade (0–100 slider →
  0..1), Camadas (to back / backward / forward / front), Ações (duplicar,
  excluir, agrupar/desagrupar, travar). Edits go through
  `actions.applyStyle(patch)`.
- **Top-centre**: `ToolIsland` from `TOOLBAR` with the lock toggle (Q) first
  and a "more tools" dropdown for `more: true` tools and the library; the digit
  badge bottom-right of each button; image tool opens the file picker.
- **Top-right**: board title (click to rename), peer avatars, Share button with
  connection dot and peer count, Library button (opens `LibraryPanel` sidebar
  with the presets from `store/presets.js`: click places at viewport centre,
  pointer-drag onto the canvas places at the drop point — no dnd-kit).
- **Bottom-left**: zoom out / NN% (click → 100%) / zoom in; undo / redo.
- **Bottom-right**: help `?` button.
- **Centre, empty board only**: `WelcomeScreen` hints (Excalidraw-style
  handwritten hints pointing at the menu, the toolbar and help).
- **Hint line** under the tool island describing the current gesture (e.g.
  "Clique e arraste, solte quando terminar").
- `ContextMenu` on right-click (from Canvas `onContextMenu`): Copiar, Recortar,
  Colar, Duplicar, Excluir, Trazer para frente, Enviar para trás, Agrupar,
  Desagrupar, Travar/Destravar, Selecionar tudo, Ajustar à tela.
- `HelpDialog` (keyboard map), `ExportDialog` (PNG/SVG preview, background,
  dark mode, scale 1×/2×/3×, download / copy PNG), `Toaster`,
  `NicknameGate`, `BoardList`, `ErrorBoundary` keep working, restyled and in
  Portuguese.
- Mobile (≤ 640 px): tool island at the bottom, properties in a collapsible sheet.
- Dark theme: `html[data-theme=dark]` switches UI tokens; the Canvas applies
  `DARK_MODE_FILTER`.

```js
// editor/actions.js — every intent, callable from shortcuts, menus, context menu, panel
export const actions = {
  deleteSelection(), duplicateSelection(), selectAll(), deselect(),
  copy(): Promise<void>, cut(), paste(textOrNull, atBoardPoint?),    // system clipboard JSON {type:'whiteboard/clipboard', elements}; cloneElements for fresh ids
  group(), ungroup(), toggleLock(),
  bringForward(), sendBackward(), bringToFront(), sendToBack(),
  nudge(dx, dy),
  zoomIn(), zoomOut(), resetZoom(), zoomToFit(), zoomToSelection(),   // about the viewport centre, using store.viewportSize
  applyStyle(patch),        // setStyle(patch) + commit('style:<key>') + updateElements on the selection (only keys in styleKeysFor(type); text re-fit with fitTextElement after font changes)
  clearCanvas(),            // commit + removeElements(all)
  importFile(file), saveToFile(), 
}
// Each action reads/writes useBoardStore.getState(); they are plain functions, testable in node.
```

Keyboard (`ui/shortcuts.js`, one table drives the handler and the help
dialog; letters matched by `event.code` so non-Latin layouts work):
tools per `TOOLBAR` (letters + digits), Q lock tool, Mod+Z / Mod+Shift+Z /
Mod+Y, Mod+A, Mod+D, Mod+C / Mod+X / Mod+V (real clipboard events), Delete and
Backspace, arrows nudge (Shift ×10), Mod+G / Mod+Shift+G, Mod+Shift+L lock,
Mod+] / Mod+[ (forward/backward), Mod+Shift+] / Mod+Shift+[ (front/back),
Mod+= / Mod+- zoom, Mod+0 reset zoom, Shift+1 zoom to fit, Shift+2 zoom to
selection, Mod+' grid, Alt+Shift+D theme, Mod+Shift+E export, ? help, Escape
(close overlay → finish text edit → clear selection → select tool), Enter
(edit selected text/label).

## 9. Tests

`npm test` (API) and `npm run test:web` must pass (`npm run test:all` runs
both; `npm run build` is the web production build). Pure modules get node:test
coverage (`node --test`). The web test script runs
`"apps/web/test/*.test.js" "apps/web/src/**/*.test.js"`; the globs are quoted
so node expands them (recursively), not the shell. Tests must not import the
removed legacy modules (`flow/`, `dnd/`, `canvas/`).
