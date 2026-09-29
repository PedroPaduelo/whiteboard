#!/usr/bin/env node
/**
 * Creates the showcase board the user opens from the preview link.
 *
 * Idempotent by TITLE, not by id: an id pasted into a link goes stale the
 * moment the database is recreated, which is exactly what happened — a board id
 * I handed over earlier 404'd. The script prints the id it just made, and
 * callers must use THAT.
 */
// Override with API_URL=http://host:port/api to seed another instance, and
// WEB_URL=https://your.host to print a link to the web app that serves it.
// OWNER_ID=<id> makes the board that person's (default: unowned, listed for
// everyone).
const BASE = (process.env.API_URL || 'http://localhost:3001/api').replace(/\/+$/, '');
const WEB = (process.env.WEB_URL || 'http://localhost:5173').replace(/\/+$/, '');
const OWNER_ID = process.env.OWNER_ID || null;
const TITLE = 'Whiteboard — demonstração';

/* Excalidraw palette (apps/web/src/editor/constants.js). */
const SKETCH = { roughness: 1, strokeWidth: 2, strokeStyle: 'solid', opacity: 1 };
const LABEL = { fontFamily: 'hand', fontSize: 20, align: 'center' };
const shape = (stroke, fill, extra = {}) => ({ ...SKETCH, stroke, fill, fillStyle: 'hachure', ...LABEL, ...extra });
const arrow = (stroke, extra = {}) => ({
  ...SKETCH, stroke, fill: 'none', roundness: 'round', startArrowhead: 'none', endArrowhead: 'arrow', ...extra,
});

// The model since the Excalidraw-style editor: text lives INSIDE shapes as
// `label` (no separate text elements laid over them), arrows are bound with
// startId/endId (the server puts their ends on the shapes' outlines), and
// every element carries a fixed roughjs `seed` so it always draws the same.
const ELEMENTS = [
  { id: 'title', type: 'text', x: 60, y: 40, w: 422, h: 45, text: 'Como o quadro funciona', fontFamily: 'hand', fontSize: 36, align: 'left', stroke: '#1e1e1e', fill: 'none', seed: 101, roughness: 1 },

  { id: 'c1', type: 'rect', x: 60, y: 130, w: 190, h: 100, ...shape('#1971c2', '#a5d8ff', { roundness: 'round' }), label: 'Desenhe', seed: 201 },
  { id: 'c2', type: 'rect', x: 330, y: 130, w: 190, h: 100, ...shape('#6741d9', '#d0bfff', { roundness: 'round' }), label: 'Conecte', seed: 202 },
  { id: 'c3', type: 'cylinder', x: 600, y: 124, w: 190, h: 112, ...shape('#2f9e44', '#b2f2bb', { roundness: 'sharp' }), label: 'Persista', seed: 203 },

  { id: 'd1', type: 'diamond', x: 140, y: 320, w: 220, h: 140, ...shape('#f08c00', '#ffec99', { roundness: 'round' }), label: 'Salvo?', seed: 301 },

  {
    id: 's1', type: 'sticky', x: 450, y: 310, w: 230, h: 200,
    fill: '#ffec99', fontFamily: 'hand', fontSize: 20, align: 'left', seed: 401, roughness: 1,
    label: 'Dois cliques numa forma escreve nela. Arraste as formas: as setas acompanham. Delete apaga e Ctrl+Z desfaz.',
  },

  { id: 'a1', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 254, y: 180 }, { x: 326, y: 180 }], startId: 'c1', endId: 'c2', ...arrow('#1971c2'), seed: 501 },
  { id: 'a2', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 524, y: 180 }, { x: 596, y: 180 }], startId: 'c2', endId: 'c3', ...arrow('#6741d9'), seed: 502 },
  { id: 'a3', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 364, y: 390 }, { x: 446, y: 395 }], startId: 'd1', endId: 's1', ...arrow('#f08c00', { strokeStyle: 'dashed' }), seed: 503 },
];

const req = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

/**
 * The board titled TITLE, if there is one. Searched by title and paged, so
 * it is found however many boards the instance holds (one GET lists at most
 * 200).
 */
async function findExisting() {
  const PAGE = 200;
  const q = encodeURIComponent(TITLE);
  for (let offset = 0; ; offset += PAGE) {
    const { boards, total } = await req(`/boards?search=${q}&limit=${PAGE}&offset=${offset}`, {});
    const hit = boards.find((b) => b.title === TITLE);
    if (hit) return hit;
    if (boards.length < PAGE || offset + PAGE >= total) return null;
  }
}

// Reuse a board with this title if it already exists, so re-running is safe.
const existing = await findExisting();
let id;
if (existing && existing.elementCount > 0) {
  id = existing.id;
  console.log('reaproveitando board existente:', id);
} else {
  const body = { title: TITLE, ...(OWNER_ID ? { ownerId: OWNER_ID } : {}) };
  id = existing?.id || (await req('/boards', { method: 'POST', body: JSON.stringify(body) })).board.id;
  if (!existing) console.log('board criado:', id);
  // Fresh opIds per run: the server dedupes on them, so fixed ids would make
  // a re-seed of a board that was emptied a silent no-op.
  const run = Date.now().toString(36);
  const res = await req(`/boards/${encodeURIComponent(id)}/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops: ELEMENTS.map((element, i) => ({ opId: `seed-${run}-${i + 1}`, kind: 'create', element })) }),
  });
  console.log('ops:', res.status, '| rev', res.rev, '| elementos', res.elements?.length);
}

// Always re-verify: an id we hand to a human must be proven to work right now.
const snap = await req(`/boards/${encodeURIComponent(id)}/snapshot`);
console.log('VERIFICADO: id', id, '->', snap.elements.length, 'elementos, rev', snap.rev);
// The share-link form the app's Share button copies (ui/share.js).
console.log(`LINK: ${WEB}/b/${encodeURIComponent(id)}`);
