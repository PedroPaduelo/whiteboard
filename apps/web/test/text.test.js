/**
 * text.test.js — editor/text.js line breaking and label layout, in node.
 *
 * In node there is no canvas, so `measureLine` uses the fixed per-character
 * advance (code font at 20px = 12px per UTF-16 unit): a 160px box holds 13
 * characters. The rules under test are the ones the label textarea follows
 * (white-space: pre-wrap + break-word); they were checked against Chromium
 * with the real fonts, and these tests pin them down.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wrapText, layoutText, labelBox, measureLine, trimTrailingSpaces } from '../src/editor/text.js';
import { LABEL_PADDING } from '../src/editor/constants.js';

const wrap = (s, w = 160) => wrapText(s, w, 'code', 20);
const fitsAll = (lines, w = 160) => lines.every((l) => measureLine(trimTrailingSpaces(l), 'code', 20) <= w);

test('wrapText: a word wider than the box is broken by characters even after other words (URL in a label)', () => {
  const s = 'veja https://exemplo.com.br/um/caminho/muito/comprido ok';
  const lines = wrap(s);
  assert.equal(lines[0], 'veja');
  assert.ok(fitsAll(lines), `every line fits: ${JSON.stringify(lines)}`);
  assert.equal(lines.join(''), s.replace('veja ', 'veja'), 'no character is lost or duplicated');
  assert.equal(lines.at(-1), '/comprido ok', 'the rest of the paragraph continues after the broken word');
});

test('wrapText: a long word at the very start of a paragraph is still broken', () => {
  const lines = wrap('https://github.com/excalidraw/excalidraw/issues');
  assert.ok(lines.length > 1);
  assert.ok(fitsAll(lines));
});

test('wrapText: breaks after hyphens, like the textarea, instead of in the middle of a word', () => {
  assert.deepEqual(wrap('texto-com-hifens-que-quebram-diferente no navegador'), [
    'texto-com-',
    'hifens-que-',
    'quebram-',
    'diferente no',
    'navegador',
  ]);
  assert.deepEqual(wrap('reunião de segunda-feira às dez', 120), ['reunião de', 'segunda-', 'feira às', 'dez']);
  // Never between two hyphens (no line starts with one).
  assert.deepEqual(wrap('aaaaaaaa--bbbbb', 120), ['aaaaaaaa--', 'bbbbb']);
});

test('wrapText: spaces before a line break stay on the line and never add an empty line', () => {
  assert.deepEqual(wrap('palavra final   \nsegunda'), ['palavra final   ', 'segunda']);
  assert.deepEqual(wrap('abc   '), ['abc   ']);
  assert.deepEqual(wrap('a\n\nb'), ['a', '', 'b']);
  assert.deepEqual(wrap(''), ['']);
});

test('wrapText: spaces at a soft wrap hang (they do not push the next word down or stay on the line)', () => {
  assert.deepEqual(wrap('palavra final   segunda'), ['palavra final', 'segunda']);
  assert.deepEqual(wrap('um dois     tres quatro cinco seis', 204), ['um dois     tres', 'quatro cinco seis']);
  // Leading spaces wider than the box: they fill one line, the word goes to the next.
  assert.deepEqual(wrap(' '.repeat(20) + 'abc'), ['', 'abc']);
  // A paragraph of nothing but spaces is one line.
  assert.equal(wrap(' '.repeat(40)).length, 1);
});

test('wrapText: a no-break space never breaks', () => {
  assert.deepEqual(wrap('aaaaaaa\u00a0bbbbbbbbbbbb'), ['aaaaaaa\u00a0bbbbb', 'bbbbbbb']);
});

test('wrapText: breaking by characters never splits a grapheme', () => {
  // 'e' + combining acute: 2 UTF-16 units, 24px each in node.
  const lines = wrapText('e\u0301'.repeat(5), 60, 'code', 20);
  assert.deepEqual(lines, ['e\u0301e\u0301', 'e\u0301e\u0301', 'e\u0301']);
});

test('wrapText: a single character wider than the box still gets its own line (no infinite loop)', () => {
  assert.deepEqual(wrapText('abc', 1, 'code', 20), ['a', 'b', 'c']);
});

const rect = (label, align, w = 160 + 2 * LABEL_PADDING) => ({
  type: 'rect', x: 0, y: 0, w, h: 200, label, fontFamily: 'code', fontSize: 20, ...(align ? { align } : {}),
});

test('layoutText: a label URL in a 170x120 rect paints inside the shape', () => {
  const el = { type: 'rect', x: 0, y: 0, w: 170, h: 120, label: 'veja https://exemplo.com.br/um/caminho/muito/comprido ok', fontFamily: 'code', fontSize: 20 };
  const box = labelBox(el);
  const l = layoutText(el);
  for (const line of l.lines) {
    const w = measureLine(line.text, 'code', 20);
    assert.ok(line.x - w / 2 >= box.x - 0.01 && line.x + w / 2 <= box.x + box.w + 0.01, `"${line.text}" stays in the box`);
  }
});

test('layoutText: painted lines never carry trailing spaces', () => {
  const l = layoutText(rect('palavra final   \nsegunda', 'left'));
  assert.deepEqual(l.lines.map((x) => x.text), ['palavra final', 'segunda']);
});

test('layoutText: spaces typed before a newline count for centring/right alignment, up to the box width', () => {
  const box = labelBox(rect('x'));
  // 'abc   ' is 72px wide as the browser counts it; 'abc' (36px) is painted.
  const c = layoutText(rect('abc   \nsegunda', 'center'));
  assert.equal(c.lines[0].text, 'abc');
  assert.equal(c.lines[0].x, box.x + box.w / 2 - 18);
  assert.equal(c.lines[1].x, box.x + box.w / 2, 'a line without trailing spaces is unaffected');
  const r = layoutText(rect('abc   \nsegunda', 'right'));
  assert.equal(r.lines[0].x, box.x + box.w - 36);
  // 'palavra final' (156px) + 3 spaces overflows 160px: counted only up to the box width.
  const capped = layoutText(rect('palavra final   \nx', 'center'));
  assert.equal(capped.lines[0].x, box.x + box.w / 2 - 2);
  // Spaces that hang at a soft wrap do not count.
  const soft = layoutText(rect('palavra final   segunda', 'center'));
  assert.equal(soft.lines[0].x, box.x + box.w / 2);
});

test('layoutText: shape labels honour align (default centre), sticky notes default to left', () => {
  const box = labelBox(rect('x'));
  assert.equal(layoutText(rect('oi')).textAlign, 'center');
  assert.equal(layoutText(rect('oi', 'left')).lines[0].x, box.x);
  assert.equal(layoutText(rect('oi', 'right')).lines[0].x, box.x + box.w);
  const sticky = { type: 'sticky', x: 0, y: 0, w: 200, h: 200, label: 'oi', fontFamily: 'code', fontSize: 20 };
  assert.equal(layoutText(sticky).textAlign, 'left');
});
