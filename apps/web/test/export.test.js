/**
 * export.test.js — SVG and JSON export/import, under `node --test`.
 *
 * The SVG exporter is pure (roughjs `generator.toPaths`, no DOM), so its
 * structure — one group per element, the viewBox, the background, fonts,
 * escaping — is asserted on the string. The JSON reader is the gate every
 * imported file passes, so it is tested against valid v1/v2 files and a
 * catalogue of bad ones.
 *
 *   node --test apps/web/test/export.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS } from '@whiteboard/shared';

import {
  exportToSvg,
  exportBounds,
  serializeBoard,
  parseBoardFile,
  applyDarkToPixels,
  BOARD_FILE_VERSION,
} from '../src/editor/export/export.js';
import { elementBounds } from '../src/editor/handles.js';

const rect = (id, extra = {}) => ({
  id,
  type: 'rect',
  x: 0,
  y: 0,
  w: 100,
  h: 60,
  stroke: '#1e1e1e',
  fill: '#a5d8ff',
  fillStyle: 'hachure',
  strokeWidth: 2,
  roughness: 1,
  seed: 11,
  ...extra,
});

const scene = () => [
  rect('r1', { label: 'Caixa', roundness: 'round' }),
  { id: 'e1', type: 'ellipse', x: 150, y: 0, w: 80, h: 60, stroke: '#e03131', seed: 2 },
  { id: 'd1', type: 'diamond', x: 260, y: 0, w: 80, h: 60, stroke: '#000', fill: '#ffec99', fillStyle: 'solid', seed: 3 },
  { id: 'c1', type: 'cylinder', x: 360, y: 0, w: 80, h: 90, stroke: '#000', seed: 4 },
  { id: 'a1', type: 'arrow', x: 0, y: 100, w: 200, h: 0, points: [{ x: 0, y: 100 }, { x: 200, y: 100 }], stroke: '#000', strokeWidth: 2, endArrowhead: 'triangle', seed: 5 },
  { id: 'l1', type: 'line', x: 0, y: 130, w: 200, h: 30, points: [{ x: 0, y: 130 }, { x: 100, y: 160 }, { x: 200, y: 130 }], stroke: '#000', roundness: 'round', seed: 6 },
  { id: 'p1', type: 'pen', x: 0, y: 200, w: 50, h: 20, points: [{ x: 0, y: 200 }, { x: 25, y: 220 }, { x: 50, y: 205 }], stroke: '#2f9e44', strokeWidth: 2 },
  { id: 's1', type: 'sticky', x: 250, y: 150, w: 120, h: 120, label: 'nota', fill: '#ffec99' },
  { id: 't1', type: 'text', x: 0, y: 260, w: 120, h: 30, text: 'a < b & "c"', fontSize: 24, fontFamily: 'hand', stroke: '#1e1e1e' },
  { id: 'i1', type: 'image', x: 400, y: 150, w: 40, h: 40, src: 'data:image/png;base64,iVBORw0KGgo=' },
];

const count = (s, re) => (s.match(re) || []).length;
const attr = (s, name) => s.match(new RegExp(`<svg[^>]* ${name}="([^"]*)"`))?.[1];

/* ------------------------------------------------------------------ *
 * SVG
 * ------------------------------------------------------------------ */

test('exportToSvg: one group per element, in z-order', () => {
  const els = scene();
  const svg = exportToSvg(els);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(svg, /<\/svg>$/);
  assert.equal(count(svg, /<g data-id="/g), els.length);
  const order = [...svg.matchAll(/<g data-id="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(order, els.map((e) => e.id));
});

test('exportToSvg: viewBox is the painted bounds plus padding; size scales', () => {
  const els = [rect('r1', { x: 10, y: 20, w: 100, h: 50 })];
  const b = exportBounds(els);
  const eb = elementBounds(els[0]);
  assert.ok(b.x < eb.x && b.x > eb.x - 10, 'bounds include the stroke margin, not much more');
  const svg = exportToSvg(els, { padding: 10, scale: 2 });
  const [vx, vy, vw, vh] = attr(svg, 'viewBox').split(' ').map(Number);
  const r2 = (v) => Math.round(v * 100) / 100;
  assert.equal(vx, r2(b.x - 10));
  assert.equal(vy, r2(b.y - 10));
  assert.equal(vw, r2(b.w + 20));
  assert.equal(vh, r2(b.h + 20));
  assert.equal(Number(attr(svg, 'width')), r2((b.w + 20) * 2));
  assert.equal(Number(attr(svg, 'height')), r2((b.h + 20) * 2));
});

test('exportToSvg: background rect only when asked; dark wraps everything in the dark filter', () => {
  const els = [rect('r1')];
  const withBg = exportToSvg(els, { background: true });
  assert.match(withBg, /<rect data-role="background" [^>]*fill="#ffffff"\/>/);
  const viewBox = attr(withBg, 'viewBox').split(' ');
  const bg = withBg.match(/<rect data-role="background" x="([^"]+)" y="([^"]+)" width="([^"]+)" height="([^"]+)"/);
  assert.deepEqual(bg.slice(1), viewBox, 'background covers the whole viewBox');
  // The background comes before (under) every element.
  assert.ok(withBg.indexOf('data-role="background"') < withBg.indexOf('<g data-id='));

  const noBg = exportToSvg(els, { background: false });
  assert.doesNotMatch(noBg, /data-role="background"/);
  assert.doesNotMatch(noBg, /wb-dark/);

  const dark = exportToSvg(els, { dark: true });
  assert.match(dark, /<filter id="wb-dark"[^>]*><feColorMatrix type="matrix"/);
  assert.match(dark, /<g filter="url\(#wb-dark\)"><rect data-role="background"/);
});

test('exportToSvg: empty scene is still a valid SVG', () => {
  const svg = exportToSvg([]);
  assert.equal(count(svg, /<g data-id=/g), 0);
  assert.match(svg, /viewBox="-10 -10 20 20"/);
});

test('exportToSvg: text is escaped, anchored and baseline-placed; fonts fall back to the family in node', () => {
  const svg = exportToSvg(scene());
  assert.match(svg, />a &lt; b &amp; &quot;c&quot;<\/text>/);
  assert.match(svg, /font-family="&quot;Virgil&quot;/);
  assert.doesNotMatch(svg, /@font-face/, 'no font data in node');
  assert.match(svg, /text-anchor="middle"[^>]*>Caixa</, 'labels are centred');
  assert.match(svg, /text-anchor="start"[^>]*>a &lt; b/);
  const centred = exportToSvg([{ id: 't', type: 'text', x: 0, y: 0, w: 100, h: 30, text: 'x', align: 'right', fontSize: 20 }]);
  assert.match(centred, /x="100" [^>]*text-anchor="end"/);
  // Baseline: below the line top (y = 0) by roughly the ascent.
  const y = Number(centred.match(/<text x="[^"]+" y="([^"]+)"/)[1]);
  assert.ok(y > 15 && y < 22, `baseline at ${y}`);
});

test('exportToSvg: embeds @font-face only for fonts the text uses', () => {
  const fonts = { Virgil: 'data:font/woff2;base64,VklSRw==', 'Cascadia Code': 'data:font/woff2;base64,Q0FTQw==' };
  const hand = exportToSvg([{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'oi', fontFamily: 'hand' }], { fonts });
  assert.equal(count(hand, /@font-face/g), 1);
  assert.match(hand, /@font-face\{font-family:"Virgil";src:url\(data:font\/woff2;base64,VklSRw==\)/);
  const code = exportToSvg([rect('r', { label: 'x', fontFamily: 'code' })], { fonts });
  assert.match(code, /font-family:"Cascadia Code"/);
  assert.doesNotMatch(code, /font-family:"Virgil"/);
  const none = exportToSvg([rect('r')], { fonts });
  assert.doesNotMatch(none, /@font-face/, 'no text, no font');
  const normal = exportToSvg([{ id: 't', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'oi', fontFamily: 'normal' }], { fonts });
  assert.doesNotMatch(normal, /@font-face/, 'the system font is not embedded');
});

test('exportToSvg: rotation, opacity, dashes, pen and image', () => {
  const svg = exportToSvg([
    rect('rot', { rotation: Math.PI / 2, opacity: 0.5, strokeStyle: 'dashed' }),
    { id: 'p', type: 'pen', x: 0, y: 0, w: 10, h: 10, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }], stroke: '#e03131', strokeWidth: 2 },
    { id: 'img', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'data:image/png;base64,AAAA' },
    { id: 'bad', type: 'image', x: 0, y: 0, w: 10, h: 10, src: 'javascript:alert(1)' },
  ]);
  assert.match(svg, /<g data-id="rot" data-type="rect" transform="rotate\(90 50 30\)" opacity="0.5">/);
  assert.match(svg, /stroke-dasharray="8 10"/);
  assert.match(svg, /<g data-id="p"[^>]*><path transform="translate\(0 0\)" d="M [^"]+Z" fill="#e03131" stroke="none"\/>/);
  assert.match(svg, /<image [^>]*href="data:image\/png;base64,AAAA"/);
  assert.doesNotMatch(svg, /javascript:/, 'unsafe image sources are never emitted');
});

test('exportToSvg: the same scene exports byte-identically (seeded wobble)', () => {
  assert.equal(exportToSvg(scene()), exportToSvg(scene()));
});

test('exportToSvg: hostile colours and ids are neutralised', () => {
  const svg = exportToSvg([rect('x"><script>', { stroke: 'red" onload="alert(1)', fill: 'none' })]);
  assert.doesNotMatch(svg, /<script>/);
  assert.doesNotMatch(svg, /onload=/);
  assert.match(svg, /data-id="x&quot;&gt;&lt;script&gt;"/);
});

test('applyDarkToPixels: white becomes the dark canvas colour, alpha untouched', () => {
  const px = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 128]);
  applyDarkToPixels(px);
  assert.deepEqual([...px], [18, 18, 18, 255, 237, 237, 237, 128]);
});

/* ------------------------------------------------------------------ *
 * JSON
 * ------------------------------------------------------------------ */

const validElements = () => [
  rect('r1', { label: 'Caixa' }),
  { id: 'a1', type: 'arrow', x: 0, y: 0, w: 0, h: 0, points: [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }], startId: 'r1', endArrowhead: 'dot' },
  { id: 't1', type: 'text', x: 0, y: 0, w: 10, h: 10, text: 'oi', fontFamily: 'code' },
];

test('serializeBoard writes version 2 and parseBoardFile reads it back unchanged', () => {
  const els = validElements();
  const json = serializeBoard(els, { board: { id: 'b1', title: 'Meu quadro', theme: 'dark', rev: 99 } });
  const data = JSON.parse(json);
  assert.equal(data.type, 'whiteboard');
  assert.equal(data.version, BOARD_FILE_VERSION);
  assert.equal(typeof data.source, 'string');
  assert.deepEqual(data.board, { id: 'b1', title: 'Meu quadro', theme: 'dark' });
  const res = parseBoardFile(json);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.version, 2);
  assert.deepEqual(res.board, { id: 'b1', title: 'Meu quadro', theme: 'dark' });
  assert.deepEqual(res.elements.map((e) => e.id), ['r1', 'a1', 't1'], 'ids are kept, never re-generated');
  assert.equal(res.elements[0].label, 'Caixa');
  assert.equal(res.elements[1].points.length, 3);
  assert.equal(res.elements[1].endArrowhead, 'dot');
});

test('parseBoardFile accepts the legacy version 1 format and a bare array', () => {
  const v1 = JSON.stringify({
    version: 1,
    kind: 'whiteboard.elements',
    exportedAt: 0,
    board: { id: 'old', title: 'Antigo' },
    elements: [
      { id: 'r', type: 'rect', x: 0, y: 0, w: 10, h: 10, stroke: '#1f2937', fill: 'none' },
      { id: 'a', type: 'arrow', x: 0, y: 0, w: 10, h: 0, points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] },
    ],
  });
  const res = parseBoardFile(v1);
  assert.equal(res.ok, true, res.error);
  assert.equal(res.version, 1);
  assert.equal(res.board.title, 'Antigo');
  assert.equal(res.elements.length, 2);

  const bare = parseBoardFile(JSON.stringify([{ id: 'x', type: 'text', x: 0, y: 0, w: 1, h: 1, text: 'hi' }]));
  assert.equal(bare.ok, true);
  assert.equal(bare.elements[0].fontSize, 24, 'validator defaults are applied');

  const empty = parseBoardFile(serializeBoard([]));
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.elements, []);
  assert.equal(empty.board, null);
});

test('parseBoardFile rejects an invalid element, naming it', () => {
  const els = validElements();
  els[1] = { ...els[1], points: [{ x: 0, y: 0 }] }; // a connector needs 2+ points
  const res = parseBoardFile(serializeBoard(els));
  assert.equal(res.ok, false);
  assert.equal(res.code, 'element');
  assert.equal(res.index, 1);
  assert.match(res.error, /Elemento 1/);
  assert.match(res.error, /points/);

  const badType = parseBoardFile(JSON.stringify({ type: 'whiteboard', version: 2, elements: [{ id: 'q', type: 'blob', x: 0, y: 0, w: 1, h: 1 }] }));
  assert.equal(badType.ok, false);
  assert.equal(badType.index, 0);

  const badEnum = parseBoardFile(JSON.stringify({ type: 'whiteboard', version: 2, elements: [rect('r', { fillStyle: 'dots' })] }));
  assert.equal(badEnum.ok, false);
  assert.match(badEnum.error, /fillStyle/);

  const dup = parseBoardFile(JSON.stringify({ type: 'whiteboard', version: 2, elements: [rect('same'), rect('same')] }));
  assert.equal(dup.ok, false);
  assert.equal(dup.index, 1);
  assert.match(dup.error, /repetido/);
});

test('parseBoardFile rejects non-JSON, foreign files and unknown versions', () => {
  const notJson = parseBoardFile('{nope');
  assert.equal(notJson.ok, false);
  assert.equal(notJson.code, 'json');

  const excalidraw = parseBoardFile(JSON.stringify({ type: 'excalidraw', version: 2, elements: [] }));
  assert.equal(excalidraw.ok, false);
  assert.equal(excalidraw.code, 'format');

  const future = parseBoardFile(JSON.stringify({ type: 'whiteboard', version: 3, elements: [] }));
  assert.equal(future.ok, false);
  assert.equal(future.code, 'version');

  const noElements = parseBoardFile(JSON.stringify({ type: 'whiteboard', version: 2 }));
  assert.equal(noElements.ok, false);

  for (const junk of ['null', '42', '"text"']) {
    const r = parseBoardFile(junk);
    assert.equal(r.ok, false, junk);
    assert.equal(typeof r.error, 'string');
  }

  const tooMany = parseBoardFile(
    JSON.stringify({ type: 'whiteboard', version: 2, elements: Array.from({ length: LIMITS.MAX_ELS + 1 }, (_, i) => rect(`r${i}`)) }),
  );
  assert.equal(tooMany.ok, false);
  assert.equal(tooMany.code, 'too-many');
});

test('parseBoardFile accepts an already-parsed object', () => {
  const res = parseBoardFile({ type: 'whiteboard', version: 2, elements: [rect('r')] });
  assert.equal(res.ok, true);
});
