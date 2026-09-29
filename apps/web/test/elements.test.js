/**
 * elements.test.js — editor/elements.js style keys and element creation, in node.
 *
 * The properties panel shows `styleKeysForTool(tool)` while a drawing tool is
 * active and `styleKeysFor(type)` for a selection; `createElement` builds the
 * next element from the default style. The rule tested here is the one users
 * see: every control the tool panel shows changes what gets drawn.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as shared from '@whiteboard/shared';
import { createElement, styleKeysFor, styleKeysForTool, styleKeysForElement } from '../src/editor/elements.js';
import { DEFAULT_STYLE, FILL_STYLES, STROKE_STYLES, ROUNDNESS, ARROWHEADS, TEXT_ALIGNS } from '../src/editor/constants.js';
import { TOOLBAR } from '../src/editor/tools.js';

/** A value different from the default for every style key. */
const ALT = {
  stroke: '#e03131',
  fill: '#a5d8ff',
  fillStyle: 'zigzag',
  strokeWidth: 4,
  strokeStyle: 'dashed',
  roughness: 2,
  roundness: 'sharp',
  opacity: 0.5,
  fontFamily: 'code',
  fontSize: 36,
  align: 'right',
  startArrowhead: 'dot',
  endArrowhead: 'bar',
};

function geomFor(tool) {
  if (tool === 'arrow' || tool === 'line' || tool === 'pen') return { points: [{ x: 0, y: 0 }, { x: 100, y: 40 }] };
  if (tool === 'text') return { x: 0, y: 0, text: 'olá' };
  return { x: 0, y: 0, w: 120, h: 80 };
}

test('every control the tool panel shows is applied to the element that tool draws', () => {
  for (const { id: tool } of TOOLBAR) {
    for (const key of styleKeysForTool(tool)) {
      assert.notEqual(ALT[key], DEFAULT_STYLE[key], `ALT.${key} differs from the default`);
      // The sticky tool's "Fundo" edits style.stickyFill (actions.applyStyle).
      const style = tool === 'sticky' && key === 'fill' ? { ...DEFAULT_STYLE, stickyFill: ALT.fill } : { ...DEFAULT_STYLE, [key]: ALT[key] };
      const el = createElement(tool, geomFor(tool), style);
      assert.equal(el[key], ALT[key], `${tool}: "${key}" shown in the tool panel reaches the new element`);
    }
  }
});

test('line tool: no arrowhead controls, and new lines have none; a selected line still offers them', () => {
  assert.ok(!styleKeysForTool('line').includes('startArrowhead'));
  assert.ok(!styleKeysForTool('line').includes('endArrowhead'));
  assert.ok(styleKeysForTool('arrow').includes('endArrowhead'));
  assert.ok(styleKeysFor('line').includes('startArrowhead'));
  const line = createElement('line', geomFor('line'), { ...DEFAULT_STYLE, startArrowhead: 'triangle', endArrowhead: 'bar' });
  assert.equal(line.startArrowhead, 'none');
  assert.equal(line.endArrowhead, 'none');
});

test('shape labels can be aligned: align is a style key of every labelled shape type', () => {
  for (const type of ['rect', 'diamond', 'ellipse', 'cylinder', 'sticky', 'text']) {
    assert.ok(styleKeysFor(type).includes('align'), `${type} has align`);
    assert.ok(styleKeysFor(type).includes('fontFamily'), `${type} has fontFamily`);
  }
  // …but a shape tool shows no text controls: the new shape has no label yet.
  for (const tool of ['rect', 'diamond', 'ellipse', 'cylinder']) {
    for (const k of ['fontFamily', 'fontSize', 'align']) assert.ok(!styleKeysForTool(tool).includes(k), `${tool} tool hides ${k}`);
  }
  for (const tool of ['text', 'sticky']) assert.ok(styleKeysForTool(tool).includes('align'));
  // A new shape leaves align unset, so its label is centred.
  assert.equal(createElement('rect', geomFor('rect'), { ...DEFAULT_STYLE, align: 'right' }).align, undefined);
  // The server accepts align on a shape (what applyStyle patches).
  assert.equal(shared.tryValidateElement({ ...createElement('rect', geomFor('rect')), label: 'oi', align: 'left' }).element.align, 'left');
});

test('new sticky notes take the alignment from the default style', () => {
  assert.equal(createElement('sticky', { x: 0, y: 0 }).align, 'left');
  assert.equal(createElement('sticky', { x: 0, y: 0 }, { ...DEFAULT_STYLE, align: 'center' }).align, 'center');
});

test('styleKeysForElement: font/size/align only for shapes that have (or are getting) a label', () => {
  const bare = createElement('rect', geomFor('rect'));
  const labelled = { ...bare, label: 'oi' };
  assert.ok(!styleKeysForElement(bare).includes('align'));
  assert.ok(!styleKeysForElement(bare).includes('fontFamily'));
  assert.ok(styleKeysForElement(bare).includes('stroke'));
  assert.deepEqual(styleKeysForElement(labelled), styleKeysFor('rect'));
  assert.deepEqual(styleKeysForElement(bare, { editing: true }), styleKeysFor('rect'));
  const note = createElement('sticky', { x: 0, y: 0 });
  assert.deepEqual(styleKeysForElement(note), styleKeysFor('sticky'), 'an empty note still shows its text controls');
  const text = createElement('text', geomFor('text'));
  assert.deepEqual(styleKeysForElement(text), styleKeysFor('text'));
});

test('editor enums are the shared model enums (no drifting copy): zigzag is a fill style', () => {
  assert.equal(FILL_STYLES, shared.FILL_STYLES);
  assert.ok(FILL_STYLES.includes('zigzag'));
  assert.equal(STROKE_STYLES, shared.STROKE_STYLES);
  assert.equal(ROUNDNESS, shared.ROUNDNESS);
  assert.equal(ARROWHEADS, shared.ARROWHEADS);
  assert.equal(TEXT_ALIGNS, shared.TEXT_ALIGNS);
});
