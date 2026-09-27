#!/usr/bin/env node
/**
 * Creates the showcase board the user opens from the preview link.
 *
 * Idempotent by TITLE, not by id: an id pasted into a link goes stale the
 * moment the database is recreated, which is exactly what happened — a board id
 * I handed over earlier 404'd. The script prints the id it just made, and
 * callers must use THAT.
 */
const BASE = 'http://localhost:3001/api';
const TITLE = 'Whiteboard — demonstração';

const ELEMENTS = [
  { id: 'title', type: 'text', x: 60, y: 40, w: 640, h: 46, text: 'Como o board funciona', fontSize: 30, fill: 'none', stroke: 'none' },

  { id: 'c1', type: 'rect', x: 60, y: 130, w: 190, h: 100, stroke: '#3b82f6', fill: '#bfdbfe', strokeWidth: 2 },
  { id: 'c1t', type: 'text', x: 95, y: 160, w: 130, h: 40, text: 'Desenhe', fontSize: 20, fill: 'none', stroke: '#1e3a8a' },

  { id: 'c2', type: 'rect', x: 330, y: 130, w: 190, h: 100, stroke: '#8b5cf6', fill: '#e9d5ff', strokeWidth: 2 },
  { id: 'c2t', type: 'text', x: 355, y: 160, w: 150, h: 40, text: 'Conecte', fontSize: 20, fill: 'none', stroke: '#4c1d95' },

  { id: 'c3', type: 'cylinder', x: 600, y: 130, w: 190, h: 100, stroke: '#22c55e', fill: '#bbf7d0', strokeWidth: 2 },
  { id: 'c3t', type: 'text', x: 640, y: 162, w: 130, h: 40, text: 'Persista', fontSize: 20, fill: 'none', stroke: '#14532d' },

  { id: 'd1', type: 'diamond', x: 160, y: 320, w: 180, h: 120, stroke: '#eab308', fill: '#fed7aa', strokeWidth: 2 },
  { id: 'd1t', type: 'text', x: 195, y: 362, w: 110, h: 34, text: 'Salvo?', fontSize: 18, fill: 'none', stroke: '#78350f', align: 'center' },

  {
    id: 's1', type: 'sticky', x: 450, y: 310, w: 210, h: 170,
    fill: '#fde68a', stroke: '#eab308', strokeWidth: 1,
    label: 'Dois cliques num texto edita. Arraste as formas. Delete apaga e Ctrl+Z desfaz.',
  },

  { id: 'a1', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 250, y: 180 }, { x: 330, y: 180 }], startId: 'c1', endId: 'c2', stroke: '#3b82f6', strokeWidth: 2, strokeStyle: 'solid' },
  { id: 'a2', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 520, y: 180 }, { x: 600, y: 180 }], startId: 'c2', endId: 'c3', stroke: '#8b5cf6', strokeWidth: 2, strokeStyle: 'solid' },
  { id: 'a3', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 340, y: 380 }, { x: 450, y: 395 }], startId: 'd1', endId: 's1', stroke: '#eab308', strokeWidth: 2, strokeStyle: 'dashed' },
];

const req = async (path, init) => {
  const r = await fetch(BASE + path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
  });
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
};

// Reuse a board with this title if it already exists, so re-running is safe.
const { boards } = await req('/boards', {});
const existing = boards.find((b) => b.title === TITLE);
let id;
if (existing && existing.elementCount > 0) {
  id = existing.id;
  console.log('reaproveitando board existente:', id);
} else {
  id = (existing?.id) || (await req('/boards', { method: 'POST', body: JSON.stringify({ title: TITLE, ownerId: 'ana' }) })).board.id;
  if (!existing) console.log('board criado:', id);
  const res = await req(`/boards/${id}/ops`, {
    method: 'POST',
    body: JSON.stringify({ ops: ELEMENTS.map((element, i) => ({ opId: `seed-${i + 1}`, kind: 'create', element })) }),
  });
  console.log('ops:', res.status, '| rev', res.rev, '| elementos', res.elements?.length);
}

// Always re-verify: an id we hand to a human must be proven to work right now.
const snap = await req(`/boards/${id}/snapshot`);
console.log('VERIFICADO: id', id, '->', snap.elements.length, 'elementos, rev', snap.rev);
console.log('LINK: https://sb-whiteboard-app.mp.serendiped.com/?board=' + id);
