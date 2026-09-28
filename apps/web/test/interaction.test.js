/**
 * interaction.test.js — drives the pure interaction reducer through whole
 * gestures for every tool, applying its effects to the REAL board store the
 * way Canvas.jsx does, and asserts what matters for undo and sync:
 * exactly one commit per gesture, drafts that stay out of the store until
 * finished, click-to-place, multi-point connectors, binding and unbinding,
 * the one-commit eraser, Alt-duplicate, and locked elements that never move.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveConnectors, connectorEndpoint, BIND_GAP } from '@whiteboard/shared';
import { useBoardStore } from '../src/store/boardStore.js';
import { reduce, initialInteraction } from '../src/editor/interaction.js';
import { createElement } from '../src/editor/elements.js';
import { selectionFrame, transformHandles } from '../src/editor/handles.js';
import { DEFAULT_STYLE, DEFAULT_SHAPE_SIZE, STICKY_SIZE, DRAG_THRESHOLD } from '../src/editor/constants.js';

/* ------------------------------------------------------------------ *
 * Test driver: reducer + real store, effects applied in order.
 * ------------------------------------------------------------------ */

class Driver {
  constructor({ elements = [], tool = 'select', toolLocked = false, view = { zoom: 1, panX: 0, panY: 0 }, snapEnabled = false, selection = [] } = {}) {
    const st = useBoardStore.getState();
    st.reset();
    useBoardStore.setState({ elements, tool, toolLocked, view, snapEnabled, gridSize: 20, style: { ...DEFAULT_STYLE }, selection: new Set(selection) });
    this.state = initialInteraction();
    this.effects = [];
    this.textEdits = [];
    this.menus = [];
    this.images = [];
    this.spaceDown = false;
    this.now = 1000;
    this.x = 0;
    this.y = 0;
  }

  get store() {
    return useBoardStore.getState();
  }

  ctx() {
    const s = this.store;
    return {
      elements: s.elements,
      selection: s.selection,
      tool: s.tool,
      toolLocked: s.toolLocked,
      style: s.style,
      view: s.view,
      gridSize: s.gridSize,
      snapEnabled: s.snapEnabled,
      editingId: s.editingId,
      now: (this.now += 16),
      spaceDown: this.spaceDown,
    };
  }

  send(ev) {
    const r = reduce(this.state, ev, this.ctx());
    this.state = r.state;
    this.effects.push(...r.effects);
    this.apply(r.effects);
    return r;
  }

  apply(effects) {
    const s = () => useBoardStore.getState();
    for (const fx of effects) {
      switch (fx.type) {
        case 'commit': s().commit(fx.label); break;
        case 'addElements': s().addElements(fx.elements); break;
        case 'updateElements': s().updateElements(fx.patches); break;
        case 'removeElements': s().removeElements(fx.ids); break;
        case 'select': s().select(fx.ids); break;
        case 'setTool': s().setTool(fx.tool); break;
        case 'panBy': s().panBy(fx.dx, fx.dy); break;
        case 'zoomAt': s().zoomAtScreen({ x: fx.x, y: fx.y }, fx.factor); break;
        case 'setHovered': s().setHovered(fx.id); break;
        case 'startTextEdit':
          this.textEdits.push(fx);
          if (!fx.element) {
            s().select([fx.id]);
            s().setEditing(fx.id);
          }
          break;
        case 'contextMenu': this.menus.push(fx); break;
        case 'requestImage': this.images.push(fx); break;
        default: throw new Error(`unknown effect ${fx.type}`);
      }
    }
  }

  ev(type, x, y, opts = {}) {
    this.x = x;
    this.y = y;
    return this.send({ type, x, y, button: 0, buttons: type === 'pointerup' ? 0 : 1, pointerType: 'mouse', pointerId: 1, shiftKey: false, altKey: false, mod: false, ...opts });
  }
  down(x, y, opts) { return this.ev('pointerdown', x, y, opts); }
  move(x, y, opts) { return this.ev('pointermove', x, y, opts); }
  hover(x, y, opts) { return this.ev('pointermove', x, y, { buttons: 0, ...opts }); }
  up(x, y, opts) { return this.ev('pointerup', x, y, opts); }
  click(x, y, opts) { this.down(x, y, opts); return this.up(x, y, opts); }
  drag(x0, y0, x1, y1, { steps = 4, ...opts } = {}) {
    this.down(x0, y0, opts);
    for (let i = 1; i <= steps; i++) this.move(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, opts);
    return this.up(x1, y1, opts);
  }
  key(key, opts = {}) { return this.send({ type: 'keydown', key, shiftKey: false, altKey: false, mod: false, ...opts }); }
  dblclick(x, y) { return this.send({ type: 'dblclick', x, y, button: 0 }); }

  commits() { return this.effects.filter((e) => e.type === 'commit'); }
  of(type) { return this.effects.filter((e) => e.type === type); }
  el(id) { return this.store.elements.find((e) => e.id === id); }
  get selection() { return [...this.store.selection].sort(); }
  reset() { this.effects = []; }
}

const R = (id, x, y, w, h, extra = {}) => ({ ...createElement('rect', { x, y, w, h }, DEFAULT_STYLE), id, ...extra });
const filled = { fill: '#ffc9c9', fillStyle: 'solid' };

/* ------------------------------------------------------------------ *
 * select
 * ------------------------------------------------------------------ */

test('click selects the topmost element without a commit; empty click clears', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled), R('b', 50, 50, 100, 100, filled)] });
  d.click(75, 75);
  assert.deepEqual(d.selection, ['b']);
  d.click(20, 20);
  assert.deepEqual(d.selection, ['a']);
  d.click(500, 500);
  assert.deepEqual(d.selection, []);
  assert.equal(d.commits().length, 0);
  assert.equal(d.of('updateElements').length, 0);
});

test('Shift-click toggles membership; a plain click on a multi-selection member narrows to it', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled), R('b', 200, 0, 100, 100, filled)] });
  d.click(50, 50);
  d.click(250, 50, { shiftKey: true });
  assert.deepEqual(d.selection, ['a', 'b']);
  d.click(250, 50, { shiftKey: true });
  assert.deepEqual(d.selection, ['a']);
  d.click(250, 50, { shiftKey: true });
  d.click(50, 50);
  assert.deepEqual(d.selection, ['a']);
  assert.equal(d.commits().length, 0);
});

test('dragging an element is ONE commit then live updateElements every frame', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.drag(50, 50, 150, 110, { steps: 5 });
  const commits = d.commits();
  assert.equal(commits.length, 1);
  assert.match(commits[0].label, /^move:/);
  assert.equal(d.of('updateElements').length, 5);
  assert.deepEqual({ x: d.el('a').x, y: d.el('a').y }, { x: 100, y: 60 });
  // The commit comes before the first update.
  assert.ok(d.effects.findIndex((e) => e.type === 'commit') < d.effects.findIndex((e) => e.type === 'updateElements'));
  // A second gesture gets its own label (no coalescing into one undo step).
  d.drag(150, 110, 160, 110);
  const labels = d.commits().map((c) => c.label);
  assert.equal(labels.length, 2);
  assert.notEqual(labels[0], labels[1]);
  d.store.undo();
  assert.equal(d.el('a').x, 100);
  d.store.undo();
  assert.equal(d.el('a').x, 0);
});

test('a jitter below the drag threshold is a click, not a move', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.down(50, 50);
  d.move(50 + DRAG_THRESHOLD - 1, 50);
  d.up(50 + DRAG_THRESHOLD - 1, 50);
  assert.equal(d.commits().length, 0);
  assert.equal(d.el('a').x, 0);
});

test('a selected transparent rect can be dragged by its empty middle', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 200, 200)], selection: ['a'] });
  d.drag(100, 100, 130, 100);
  assert.equal(d.el('a').x, 30);
  assert.equal(d.commits().length, 1);
});

test('marquee selects only fully contained elements (and whole groups)', () => {
  const d = new Driver({
    elements: [R('in', 10, 10, 30, 30), R('half', 90, 10, 30, 30), R('g1', 10, 60, 20, 20, { groupId: 'G' }), R('g2', 300, 300, 20, 20, { groupId: 'G' })],
  });
  d.drag(0, 0, 100, 100);
  assert.deepEqual(d.selection, ['g1', 'g2', 'in']);
  assert.equal(d.state.marquee, null, 'marquee cleared on release');
  assert.equal(d.commits().length, 0);
});

test('clicking a group member selects the group and dragging moves all members', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 50, 50, { ...filled, groupId: 'G' }), R('b', 100, 0, 50, 50, { ...filled, groupId: 'G' })] });
  d.drag(25, 25, 45, 45);
  assert.deepEqual(d.selection, ['a', 'b']);
  assert.equal(d.el('b').x, 120);
  assert.equal(d.commits().length, 1);
});

test('Alt-drag duplicates: one commit, copies move, originals stay', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.drag(50, 50, 250, 50, { altKey: true });
  assert.equal(d.commits().length, 1);
  assert.equal(d.of('addElements').length, 1);
  const els = d.store.elements;
  assert.equal(els.length, 2);
  assert.equal(d.el('a').x, 0, 'original stays');
  const copy = els.find((e) => e.id !== 'a');
  assert.equal(copy.x, 200);
  assert.deepEqual(d.selection, [copy.id]);
  d.store.undo();
  assert.equal(d.store.elements.length, 1);
});

test('locked elements: selectable by click only when nothing else is under the cursor, never moved', () => {
  const d = new Driver({ elements: [R('lock', 0, 0, 100, 100, { ...filled, locked: true }), R('top', 60, 60, 100, 100, filled)] });
  d.drag(20, 20, 220, 220);
  assert.deepEqual(d.selection, ['lock']);
  assert.equal(d.el('lock').x, 0);
  assert.equal(d.commits().length, 0);
  assert.equal(d.of('updateElements').length, 0);
  d.click(80, 80);
  assert.deepEqual(d.selection, ['top'], 'the unlocked element wins where they overlap');
  // Marquee never picks locked elements.
  d.drag(-10, -10, 300, 300);
  assert.deepEqual(d.selection, ['top']);
  // A mixed selection moves only the unlocked member.
  useBoardStore.getState().select(['lock', 'top']);
  d.drag(100, 100, 120, 100);
  assert.equal(d.el('lock').x, 0);
  assert.equal(d.el('top').x, 80);
});

test('moving a shape moves its bound arrow in the same updateElements batch', () => {
  const A = R('A', 0, 0, 100, 100, filled);
  const B = R('B', 300, 0, 100, 100, filled);
  const ar = resolveConnectors([A, B, { ...createElement('arrow', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), id: 'ar', startId: 'A', endId: 'B' }])[2];
  const d = new Driver({ elements: [A, B, ar] });
  d.drag(350, 50, 350, 250);
  const last = d.of('updateElements').at(-1);
  assert.deepEqual(last.patches.map((p) => p.id).sort(), ['B', 'ar']);
  const arrow = d.el('ar');
  assert.equal(arrow.endId, 'B');
  // The end sits on B's (moved) outline, BIND_GAP outside it, aimed at A's centre.
  const end = arrow.points.at(-1);
  const expected = connectorEndpoint(d.el('B'), { x: 50, y: 50 }, BIND_GAP);
  assert.ok(Math.hypot(end.x - expected.x, end.y - expected.y) < 1e-9, `end ${JSON.stringify(end)}`);
  assert.equal(d.el('B').y, 200);
  assert.deepEqual(resolveConnectors(d.store.elements)[2].points, arrow.points, 'store is settled');
});

test('resize by a corner handle is one commit; Shift keeps aspect', () => {
  const d = new Driver({ elements: [R('a', 100, 100, 100, 50)], selection: ['a'] });
  const frame = selectionFrame([d.el('a')], 1);
  const se = transformHandles(frame, 1).se;
  d.down(se.x, se.y);
  d.move(se.x + 50, se.y + 10);
  d.move(se.x + 100, se.y + 50);
  d.up(se.x + 100, se.y + 50);
  assert.equal(d.commits().length, 1);
  assert.match(d.commits()[0].label, /^resize:/);
  const a = d.el('a');
  assert.deepEqual({ x: a.x, y: a.y, w: a.w, h: a.h }, { x: 100, y: 100, w: 200, h: 100 });
  // Shift: aspect locked.
  const f2 = selectionFrame([a], 1);
  const se2 = transformHandles(f2, 1).se;
  d.drag(se2.x, se2.y, se2.x + 200, se2.y + 10, { shiftKey: true });
  const b = d.el('a');
  assert.equal(b.w / b.h, 2);
  assert.equal(d.commits().length, 2);
});

test('rotation handle rotates with Shift snapping to 15°', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100)], selection: ['a'] });
  const frame = selectionFrame([d.el('a')], 1);
  const rot = transformHandles(frame, 1).rotation;
  d.down(rot.x, rot.y);
  d.move(rot.x + 40, rot.y + 5, { shiftKey: true });
  d.move(150, 55, { shiftKey: true });
  d.up(150, 55, { shiftKey: true });
  assert.equal(d.commits().length, 1);
  assert.match(d.commits()[0].label, /^rotate:/);
  assert.ok(Math.abs(d.el('a').rotation - Math.PI / 2) < 1e-9, `rotation ${d.el('a').rotation}`);
});

test('Shift pressed mid-drag re-evaluates the gesture without moving the pointer', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.down(50, 50);
  d.move(150, 70);
  assert.deepEqual({ x: d.el('a').x, y: d.el('a').y }, { x: 100, y: 20 });
  const r = d.key('Shift', { shiftKey: true });
  assert.equal(r.handled, true);
  assert.deepEqual({ x: d.el('a').x, y: d.el('a').y }, { x: 100, y: 0 }, 'axis-locked');
  d.up(150, 70, { shiftKey: true });
  assert.equal(d.commits().length, 1);
});

/* ------------------------------------------------------------------ *
 * box tools
 * ------------------------------------------------------------------ */

test('box tool: a click places DEFAULT_SHAPE_SIZE centred on the pointer, selects it, returns to select', () => {
  const d = new Driver({ tool: 'rect' });
  d.click(200, 150);
  assert.equal(d.commits().length, 1);
  const [el] = d.store.elements;
  assert.equal(el.type, 'rect');
  assert.deepEqual({ x: el.x, y: el.y, w: el.w, h: el.h }, { x: 200 - DEFAULT_SHAPE_SIZE.w / 2, y: 150 - DEFAULT_SHAPE_SIZE.h / 2, ...DEFAULT_SHAPE_SIZE });
  assert.deepEqual(d.selection, [el.id]);
  assert.equal(d.store.tool, 'select');
});

test('box tool: the draft is local while dragging and added once on release; Shift squares it', () => {
  const d = new Driver({ tool: 'ellipse' });
  d.down(10, 10);
  d.move(60, 30);
  d.move(110, 60);
  assert.equal(d.store.elements.length, 0, 'not in the store while dragging');
  assert.equal(d.state.draft.type, 'ellipse');
  assert.deepEqual({ w: d.state.draft.w, h: d.state.draft.h }, { w: 100, h: 50 });
  d.up(110, 60, { shiftKey: true });
  const [el] = d.store.elements;
  assert.deepEqual({ x: el.x, y: el.y, w: el.w, h: el.h }, { x: 10, y: 10, w: 100, h: 100 });
  assert.equal(el.id, d.effects.find((e) => e.type === 'addElements').elements[0].id);
  assert.equal(d.commits().length, 1);
  assert.equal(d.state.draft, null);
});

test('box tool with the tool lock stays on the tool and leaves the selection alone', () => {
  const d = new Driver({ tool: 'diamond', toolLocked: true });
  d.drag(0, 0, 100, 80);
  d.drag(200, 0, 300, 80);
  assert.equal(d.store.elements.length, 2);
  assert.equal(d.store.tool, 'diamond');
  assert.equal(d.of('setTool').length, 0);
  assert.equal(d.commits().length, 2);
});

test('sticky: a click places STICKY_SIZE and opens the label editor', () => {
  const d = new Driver({ tool: 'sticky' });
  d.click(300, 300);
  const [el] = d.store.elements;
  assert.equal(el.type, 'sticky');
  assert.deepEqual({ w: el.w, h: el.h }, STICKY_SIZE);
  assert.deepEqual(d.textEdits.map((t) => t.id), [el.id]);
  assert.equal(d.store.editingId, el.id, 'setTool ran before startTextEdit (it clears editingId)');
});

/* ------------------------------------------------------------------ *
 * arrow / line
 * ------------------------------------------------------------------ */

test('arrow: dragging from one shape to another creates a bound 2-point arrow, highlighting the target', () => {
  const A = R('A', 0, 0, 100, 100, filled);
  const B = R('B', 300, 0, 100, 100, filled);
  const d = new Driver({ elements: [A, B], tool: 'arrow' });
  d.down(50, 50);
  d.move(150, 50);
  assert.equal(d.store.elements.length, 2, 'draft stays local');
  assert.equal(d.state.bindTarget, null);
  d.move(340, 50);
  assert.equal(d.state.bindTarget?.id, 'B', 'live bind-target highlight');
  d.up(340, 50);
  assert.equal(d.commits().length, 1);
  const ar = d.store.elements[2];
  assert.equal(ar.type, 'arrow');
  assert.equal(ar.startId, 'A');
  assert.equal(ar.endId, 'B');
  assert.equal(ar.points.length, 2);
  assert.ok(Math.abs(ar.points[0].x - (100 + BIND_GAP)) < 1e-6, `start on A outline: ${ar.points[0].x}`);
  assert.ok(Math.abs(ar.points[1].x - (300 - BIND_GAP)) < 1e-6, `end on B outline: ${ar.points[1].x}`);
  assert.deepEqual(d.selection, [ar.id]);
  assert.equal(d.store.tool, 'select');
  assert.equal(d.state.bindTarget, null);
});

test('line: click, click, click, Enter creates a 3-point connector with one commit', () => {
  const d = new Driver({ tool: 'line' });
  d.click(0, 0);
  assert.equal(d.state.mode, 'linear');
  d.hover(50, 10);
  assert.equal(d.state.draft.points.length, 2, 'the next point follows the pointer');
  d.click(100, 0);
  d.hover(120, 50);
  d.click(100, 100);
  d.hover(40, 140);
  assert.equal(d.store.elements.length, 0);
  const r = d.key('Enter');
  assert.equal(r.handled, true);
  assert.equal(d.commits().length, 1);
  const [ln] = d.store.elements;
  assert.equal(ln.type, 'line');
  assert.deepEqual(ln.points, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }]);
  assert.equal(d.store.tool, 'select');
});

test('multi-point: clicking the last point finishes, and the following dblclick is swallowed', () => {
  const d = new Driver({ tool: 'arrow' });
  d.click(0, 0);
  d.click(100, 0);
  d.click(100, 100);
  d.click(101, 101); // on the last placed point
  assert.equal(d.store.elements.length, 1);
  assert.equal(d.store.elements[0].points.length, 3);
  d.dblclick(101, 101);
  assert.equal(d.textEdits.length, 0, 'no text editor from the finishing double-click');
  assert.equal(d.commits().length, 1);
});

test('multi-point: Escape finishes; a single click then Escape creates nothing', () => {
  const d = new Driver({ tool: 'arrow' });
  d.click(0, 0);
  d.click(50, 50);
  d.key('Escape');
  assert.equal(d.store.elements.length, 1);
  assert.equal(d.store.elements[0].points.length, 2);
  const e = new Driver({ tool: 'arrow' });
  e.click(0, 0);
  const r = e.key('Escape');
  assert.equal(r.handled, true);
  assert.equal(e.store.elements.length, 0);
  assert.equal(e.commits().length, 0);
  assert.equal(e.state.mode, 'idle');
});

test('connector point editing: drag an end off a shape unbinds it, onto a shape binds it', () => {
  const A = R('A', 0, 0, 100, 100, filled);
  const B = R('B', 300, 0, 100, 100, filled);
  const C = R('C', 300, 300, 100, 100, filled);
  const ar = resolveConnectors([A, B, { ...createElement('arrow', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), id: 'ar', startId: 'A', endId: 'B' }])[2];
  const d = new Driver({ elements: [A, B, C, ar], selection: ['ar'] });
  assert.equal(d.state.linearEdit, null);
  d.hover(200, 200);
  assert.equal(d.state.linearEdit?.id, 'ar', 'a lone selected connector is in point-edit state');
  const end = ar.points[1];
  // Drag the end into empty space: unbound at the first movement.
  d.down(end.x, end.y);
  d.move(end.x - 50, end.y + 150);
  assert.equal(d.el('ar').endId, undefined, 'endId removed via a null patch');
  const firstUpdate = d.of('updateElements')[0];
  assert.equal(firstUpdate.patches[0].patch.endId, null);
  d.move(200, 200);
  d.up(200, 200);
  assert.equal(d.el('ar').endId, undefined);
  assert.deepEqual(d.el('ar').points[1], { x: 200, y: 200 });
  assert.equal(d.el('ar').startId, 'A', 'the other end stays bound');
  assert.equal(d.commits().length, 1);
  // Now drag it onto C: bound on release, end resolved onto C's outline.
  d.down(200, 200);
  d.move(300, 300);
  d.move(350, 340);
  assert.equal(d.state.bindTarget?.id, 'C');
  d.up(350, 340);
  const bound = d.el('ar');
  assert.equal(bound.endId, 'C');
  assert.deepEqual(resolveConnectors(d.store.elements)[3].points, bound.points, 'resolved and settled');
  assert.equal(d.commits().length, 2);
  assert.equal(d.state.bindTarget, null);
});

test('double-click on a connector enters point editing; a second one inserts a point on a segment', () => {
  const ln = { ...createElement('line', { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] }), id: 'ln' };
  const d = new Driver({ elements: [ln] });
  d.click(100, 0);
  d.dblclick(100, 0);
  assert.equal(d.state.linearEdit?.editing, true);
  assert.equal(d.commits().length, 0);
  d.dblclick(100, 1);
  assert.equal(d.commits().length, 1);
  assert.equal(d.el('ln').points.length, 3);
  // Double-click the interior point removes it again.
  d.dblclick(100, 1);
  assert.equal(d.el('ln').points.length, 2);
  assert.equal(d.commits().length, 2);
  // Escape leaves point editing (and is consumed).
  assert.equal(d.key('Escape').handled, true);
  assert.equal(d.state.linearEdit.editing, false);
});

/* ------------------------------------------------------------------ *
 * pen
 * ------------------------------------------------------------------ */

test('pen: points collected locally with spacing, one commit + add on release, stays on pen', () => {
  const d = new Driver({ tool: 'pen' });
  d.down(0, 0);
  for (let i = 1; i <= 20; i++) d.move(i * 0.1, 0); // 0.1 px apart: mostly dropped
  for (let i = 1; i <= 10; i++) d.move(2 + i * 10, i * 5);
  assert.equal(d.store.elements.length, 0, 'draft is not in the store');
  assert.equal(d.state.draft.type, 'pen');
  assert.equal(d.state.mode, 'freedraw');
  d.up(102, 50);
  assert.equal(d.commits().length, 1);
  const [pen] = d.store.elements;
  assert.equal(pen.type, 'pen');
  assert.ok(pen.points.length <= 13, `spacing drops dense points (${pen.points.length})`);
  assert.deepEqual(pen.points.at(-1), { x: 102, y: 50 });
  assert.equal(d.store.tool, 'pen');
  assert.equal(d.of('setTool').length, 0);
  assert.equal(d.state.draft, null);
});

test('pen: a tap makes a dot; pointercancel drops the stroke', () => {
  const d = new Driver({ tool: 'pen' });
  d.click(10, 10);
  assert.equal(d.store.elements.length, 1);
  assert.equal(d.store.elements[0].points.length, 1);
  d.down(50, 50);
  d.move(60, 60);
  d.send({ type: 'pointercancel', x: 60, y: 60, pointerId: 1 });
  assert.equal(d.store.elements.length, 1);
  assert.equal(d.commits().length, 1);
  assert.equal(d.state.draft, null);
});

/* ------------------------------------------------------------------ *
 * text
 * ------------------------------------------------------------------ */

test('text tool: click opens a NEW text (not in the store); clicking an existing text edits it', () => {
  const t = { ...createElement('text', { x: 300, y: 300, text: 'olá' }), id: 't' };
  const d = new Driver({ elements: [t], tool: 'text' });
  d.click(50, 60);
  assert.equal(d.textEdits.length, 1);
  assert.equal(d.textEdits[0].element.type, 'text');
  assert.equal(d.textEdits[0].id, d.textEdits[0].element.id);
  assert.equal(d.store.elements.length, 1, 'nothing added until the text is committed');
  d.click(t.x + 5, t.y + 5);
  assert.equal(d.textEdits[1].id, 't');
  assert.equal(d.textEdits[1].element, undefined);
  assert.equal(d.commits().length, 0);
});

test('double-click: empty canvas -> new text, text -> edit, shape -> edit its label', () => {
  const t = { ...createElement('text', { x: 300, y: 300, text: 'olá' }), id: 't' };
  const d = new Driver({ elements: [t, R('r', 0, 0, 100, 100)] });
  d.dblclick(600, 600);
  assert.ok(d.textEdits[0].element);
  d.dblclick(t.x + 5, t.y + 5);
  assert.equal(d.textEdits[1].id, 't');
  d.dblclick(0, 50); // on the unfilled rect's outline
  assert.equal(d.textEdits[2].id, 'r');
  assert.equal(d.commits().length, 0);
});

/* ------------------------------------------------------------------ *
 * eraser
 * ------------------------------------------------------------------ */

test('eraser: a sweep marks every element it crosses and removes them with ONE commit', () => {
  const pen = { ...createElement('pen', { points: [{ x: 0, y: 200 }, { x: 100, y: 200 }] }), id: 'p' };
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled), R('b', 200, 0, 100, 100), pen, R('keep', 0, 400, 50, 50, filled)], tool: 'eraser' });
  d.down(50, -20);
  d.move(50, 50);
  d.move(50, 250);
  assert.deepEqual([...d.state.erasingIds].sort(), ['a', 'p']);
  d.move(250, 250);
  d.move(250, 50); // crosses b's bottom edge
  assert.equal(d.store.elements.length, 4, 'nothing removed mid-sweep');
  d.up(250, 50);
  assert.equal(d.commits().length, 1);
  assert.deepEqual(d.of('removeElements')[0].ids.sort(), ['a', 'b', 'p']);
  assert.deepEqual(d.store.elements.map((e) => e.id), ['keep']);
});

test('eraser: Alt-drag restores marked elements; an empty sweep commits nothing; locked survive', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled), R('l', 200, 0, 100, 100, { ...filled, locked: true })], tool: 'eraser' });
  d.down(50, 50);
  assert.deepEqual([...d.state.erasingIds], ['a']);
  d.move(50, 60, { altKey: true });
  assert.deepEqual([...d.state.erasingIds], []);
  d.move(250, 50, { altKey: true });
  d.up(250, 50, { altKey: true });
  assert.equal(d.commits().length, 0);
  assert.equal(d.store.elements.length, 2);
  d.drag(500, 500, 600, 600);
  assert.equal(d.commits().length, 0);
});

/* ------------------------------------------------------------------ *
 * view
 * ------------------------------------------------------------------ */

test('hand tool, Space-drag and middle-drag pan by screen deltas', () => {
  const d = new Driver({ tool: 'hand', elements: [R('a', 0, 0, 100, 100, filled)] });
  d.drag(50, 50, 80, 20);
  assert.deepEqual(d.store.view, { zoom: 1, panX: 30, panY: -30 });
  assert.equal(d.el('a').x, 0);
  const e = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  e.spaceDown = true;
  e.drag(50, 50, 60, 70);
  assert.deepEqual(e.store.view, { zoom: 1, panX: 10, panY: 20 });
  e.spaceDown = false;
  e.drag(50, 50, 40, 50, { button: 1 });
  assert.deepEqual(e.store.view, { zoom: 1, panX: 0, panY: 20 });
  assert.equal(e.el('a').x, 0);
  assert.equal(e.commits().length, 0);
});

test('wheel pans, Shift+wheel pans horizontally, Ctrl/⌘+wheel (and pinch) zooms at the pointer', () => {
  const d = new Driver();
  d.send({ type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: 50, deltaMode: 0 });
  assert.deepEqual(d.store.view, { zoom: 1, panX: 0, panY: -50 });
  d.send({ type: 'wheel', x: 100, y: 100, deltaX: 0, deltaY: 30, deltaMode: 0, shiftKey: true });
  assert.deepEqual(d.store.view, { zoom: 1, panX: -30, panY: -50 });
  const before = d.store.view;
  const board = { x: (200 - before.panX) / before.zoom, y: (150 - before.panY) / before.zoom };
  const r = d.send({ type: 'wheel', x: 200, y: 150, deltaX: 0, deltaY: -100, deltaMode: 0, mod: true });
  assert.equal(r.handled, true);
  const v = d.store.view;
  assert.ok(v.zoom > 1, 'zoomed in');
  assert.ok(Math.abs(board.x * v.zoom + v.panX - 200) < 1e-9 && Math.abs(board.y * v.zoom + v.panY - 150) < 1e-9, 'point under the cursor is fixed');
});

test('right click opens the context menu for the element under the pointer (selecting it first)', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.down(50, 50, { button: 2 });
  assert.equal(d.menus.length, 0, 'the right button itself starts nothing');
  d.up(50, 50, { button: 2 });
  const r = d.send({ type: 'contextmenu', x: 50, y: 50, button: 2 });
  assert.equal(r.handled, true);
  assert.deepEqual(d.menus.map((m) => ({ x: m.x, y: m.y, targetId: m.targetId })), [{ x: 50, y: 50, targetId: 'a' }]);
  assert.deepEqual(d.selection, ['a']);
  d.send({ type: 'contextmenu', x: 500, y: 500, button: 2 });
  assert.equal(d.menus[1].targetId, null);
  assert.deepEqual(d.selection, []);
  assert.equal(d.commits().length, 0);
});

test('image tool: a click requests an image at that board point', () => {
  const d = new Driver({ tool: 'image', view: { zoom: 2, panX: 10, panY: 20 } });
  d.click(110, 220);
  assert.deepEqual(d.images.map(({ x, y }) => ({ x, y })), [{ x: 50, y: 100 }]);
});

test('a tool change mid-way through a multi-point connector keeps what was drawn', () => {
  const d = new Driver({ tool: 'line' });
  d.click(0, 0);
  d.click(100, 0);
  d.hover(150, 50);
  useBoardStore.getState().setTool('rect');
  d.send({ type: 'toolchange' });
  assert.equal(d.store.elements.length, 1);
  assert.equal(d.store.elements[0].points.length, 2);
  assert.equal(d.store.tool, 'rect', 'finishing because of a tool change does not switch tools');
  assert.equal(d.state.mode, 'idle');
});

test('hover sets the hovered element once per change and a handle cursor over handles', () => {
  const d = new Driver({ elements: [R('a', 100, 100, 100, 100, filled)], selection: ['a'] });
  d.hover(150, 150);
  d.hover(151, 150);
  assert.equal(d.of('setHovered').length, 1);
  assert.equal(d.store.hoveredId, 'a');
  assert.equal(d.state.cursor, 'move');
  const se = transformHandles(selectionFrame([d.el('a')], 1), 1).se;
  d.hover(se.x, se.y);
  assert.equal(d.state.cursor, 'nwse-resize');
  d.hover(900, 900);
  assert.equal(d.store.hoveredId, null);
  assert.equal(d.state.cursor, 'default');
});

/* ------------------------------------------------------------------ *
 * robustness
 * ------------------------------------------------------------------ */

test('reduce never mutates the state it is given', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.down(50, 50);
  d.move(60, 50);
  const before = d.state;
  const snapshot = JSON.stringify(before.g);
  reduce(before, { type: 'pointermove', x: 90, y: 70, buttons: 1, pointerType: 'mouse', pointerId: 1 }, d.ctx());
  assert.equal(JSON.stringify(before.g), snapshot);
});

test('a lost pointerup (same pointer pressing again) finishes the old gesture first', () => {
  const d = new Driver({ elements: [R('a', 0, 0, 100, 100, filled)] });
  d.down(50, 50);
  d.move(80, 50);
  // No pointerup: the button was released outside the window.
  d.down(300, 300);
  assert.equal(d.state.mode, 'marquee', 'the new press starts its own gesture');
  assert.equal(d.el('a').x, 30);
  d.up(300, 300);
  assert.equal(d.commits().length, 1);
  // A second touch while one is held is ignored by the reducer (the Canvas pinches).
  d.down(50 + 30, 50);
  d.send({ type: 'pointerdown', x: 400, y: 400, button: 0, buttons: 1, pointerType: 'touch', pointerId: 7 });
  assert.equal(d.state.mode, 'moving');
});

test('Ctrl/⌘-click on a segment while point-editing inserts a point (one commit)', () => {
  const ln = { ...createElement('line', { points: [{ x: 0, y: 0 }, { x: 200, y: 0 }] }), id: 'ln' };
  const d = new Driver({ elements: [ln], selection: ['ln'] });
  d.dblclick(100, 0); // enter point editing
  d.click(60, 1, { mod: true });
  assert.equal(d.el('ln').points.length, 3);
  assert.deepEqual(d.el('ln').points[1], { x: 60, y: 1 });
  assert.equal(d.commits().length, 1);
  // Without point editing, Ctrl-click is a plain click.
  const e = new Driver({ elements: [{ ...ln }], selection: ['ln'] });
  e.click(60, 1, { mod: true });
  assert.equal(e.el('ln').points.length, 2);
  assert.equal(e.commits().length, 0);
});

test('eraser never marks locked elements, even when swept across them', () => {
  const d = new Driver({ elements: [R('l', 0, 0, 100, 100, { ...filled, locked: true })], tool: 'eraser' });
  d.drag(-10, 50, 150, 50);
  assert.equal(d.commits().length, 0);
  assert.equal(d.store.elements.length, 1);
});

test('multi-selection resize through the reducer scales every member and follows bound arrows', () => {
  const A = R('A', 0, 0, 100, 100, filled);
  const B = R('B', 200, 0, 100, 100, filled);
  const C = R('C', 600, 0, 100, 100, filled);
  const ar = resolveConnectors([A, C, { ...createElement('arrow', { points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }), id: 'ar', startId: 'A', endId: 'C' }])[2];
  const d = new Driver({ elements: [A, B, C, ar], selection: ['A', 'B'] });
  const frame = selectionFrame([A, B], 1);
  const se = transformHandles(frame, 1).se;
  d.drag(se.x, se.y, se.x + 300, se.y + 100);
  assert.equal(d.commits().length, 1);
  assert.deepEqual({ x: d.el('B').x, w: d.el('B').w, h: d.el('B').h }, { x: 400, w: 200, h: 200 });
  assert.deepEqual(resolveConnectors(d.store.elements)[3].points, d.el('ar').points, 'the arrow was re-resolved in the same batches');
  assert.ok(d.of('updateElements').at(-1).patches.some((p) => p.id === 'ar'));
});
