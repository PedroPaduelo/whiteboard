/**
 * Process-level wiring and the first-run demo board.
 *
 * `main()` itself binds a port and installs signal handlers, so it is not run
 * here; what it is made of is: the option builders that map the runtime config
 * onto the store and the hub (their key names differ, which is exactly how
 * WS_PEER_TTL_MS and OP_DEDUPE_TTL_MS were once silently ignored), and the
 * demo seed, which must be a valid, fully bound board in the current model.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

import {
  validateElement,
  resolveConnectors,
  connectorEndpoint,
  BIND_GAP,
  ELEMENT_TYPES,
} from '@whiteboard/shared';
import { DEMO_ELEMENTS, seedDemoBoard, storeOptions, hubOptions } from '../src/server.js';
import { createMemoryStore } from '../src/store/index.js';
import { Hub } from '../src/ws/hub.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..');

describe('config wiring', () => {
  const cfg = {
    storage: 'memory', sqlitePath: '/tmp/x.db', opDedupeTtlMs: 1234,
    wsPeerTtlMs: 5000, wsCursorRateMs: 50, port: 1, apiPrefix: '/api',
  };

  test('the store gets exactly the keys createStore reads', () => {
    assert.deepEqual(storeOptions(cfg), { storage: 'memory', sqlitePath: '/tmp/x.db', opDedupeTtlMs: 1234 });
  });

  test('the hub gets WS_PEER_TTL_MS and WS_CURSOR_RATE_MS under ITS names', () => {
    assert.deepEqual(hubOptions(cfg), { peerTtlMs: 5000, cursorRateMs: 50 });
    const hub = new Hub(hubOptions(cfg));
    assert.equal(hub.peerTtlMs, 5000);
    assert.equal(hub.cursorRateMs, 50);
  });

  test('OP_DEDUPE_TTL_MS reaches the store: an expired opId is applied again', async () => {
    // A 1ms TTL: the recorded opId expires before the retry arrives.
    const store = createMemoryStore({ opTtlMs: storeOptions({ ...cfg, opDedupeTtlMs: 1 }).opDedupeTtlMs });
    const b = await store.createBoard({ title: 'ttl' });
    const op = { opId: 'o1', kind: 'update', elementId: 'nothing', patch: {} };
    assert.equal((await store.applyOps(b.id, [op])).status, 'applied');
    await new Promise((r) => setTimeout(r, 5));
    assert.equal((await store.applyOps(b.id, [op])).status, 'applied', 'the dedupe window really was 1ms');
    await store.close();
  });
});

describe('package.json declares every package the API imports', () => {
  test('no bare import resolves only through workspace hoisting', () => {
    const pkg = JSON.parse(readFileSync(join(apiRoot, 'package.json'), 'utf8'));
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const builtins = new Set(builtinModules);
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.js')) files.push(p);
      }
    };
    walk(join(apiRoot, 'src'));
    const missing = [];
    const seen = new Set();
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        if (spec.startsWith('.') || spec.startsWith('node:') || builtins.has(spec)) continue;
        const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
        seen.add(name);
        if (!declared.has(name)) missing.push(`${name} (${file.slice(apiRoot.length + 1)})`);
      }
    }
    // The scan must actually see the imports it polices.
    for (const name of ['fastify', 'fastify-plugin', '@fastify/websocket', '@fastify/cors', '@whiteboard/shared']) {
      assert.ok(seen.has(name), `scanner found ${name}`);
    }
    assert.deepEqual(missing, [], 'declare these in apps/api/package.json');
  });
});

describe('demo board', () => {
  const byId = new Map(DEMO_ELEMENTS.map((e) => [e.id, e]));

  test('every demo element is valid and nothing is stripped by the validator', () => {
    for (const el of DEMO_ELEMENTS) {
      assert.ok(ELEMENT_TYPES.includes(el.type), el.id);
      const clean = validateElement(el);
      for (const k of Object.keys(el)) {
        assert.ok(k in clean, `${el.id}.${k} would be silently dropped`);
      }
      assert.ok(el.id.length <= 40, `${el.id} fits LIMITS.MAX_ID`);
    }
    assert.equal(new Set(DEMO_ELEMENTS.map((e) => e.id)).size, DEMO_ELEMENTS.length, 'ids are unique');
  });

  test('it uses the new model: labels INSIDE shapes, one free text (the title)', () => {
    const texts = DEMO_ELEMENTS.filter((e) => e.type === 'text');
    assert.deepEqual(texts.map((e) => e.id), ['demo-title'], 'no separate *-lbl text elements');
    for (const el of DEMO_ELEMENTS.filter((e) => ['rect', 'ellipse', 'diamond', 'cylinder'].includes(e.type))) {
      assert.equal(typeof el.label, 'string', `${el.id} carries its text`);
      assert.ok(el.label.length > 0);
    }
    for (const type of ['sticky', 'pen', 'arrow', 'rect', 'ellipse', 'diamond', 'cylinder', 'text']) {
      assert.ok(DEMO_ELEMENTS.some((e) => e.type === type), `the demo shows a ${type}`);
    }
    assert.ok(DEMO_ELEMENTS.some((e) => e.type === 'arrow' && e.points.length > 2), 'and a multi-point arrow');
  });

  test('the hand-drawn look: seed, roughness 1, hachure fills, round rects, hand font', () => {
    const seeds = new Set();
    for (const el of DEMO_ELEMENTS) {
      assert.ok(Number.isInteger(el.seed) && el.seed >= 0 && el.seed < 2 ** 31, `${el.id} has a seed`);
      seeds.add(el.seed);
      assert.equal(el.roughness, 1, `${el.id} roughness`);
      const filled = el.fill && el.fill !== 'none';
      // A sticky is painted as a crisp note, not a rough fill: no fillStyle.
      if (filled && el.type !== 'sticky') assert.equal(el.fillStyle, 'hachure', `${el.id} fillStyle`);
      if (el.type === 'rect') assert.equal(el.roundness, 'round', `${el.id} roundness`);
      if (['text', 'sticky', 'rect', 'ellipse', 'diamond', 'cylinder'].includes(el.type)) {
        assert.equal(el.fontFamily, 'hand', `${el.id} fontFamily`);
      }
    }
    assert.equal(seeds.size, DEMO_ELEMENTS.length, 'every element wobbles differently');
  });

  test('the copy is Portuguese', () => {
    const words = DEMO_ELEMENTS.map((e) => e.text ?? e.label ?? '').join(' ');
    for (const w of ['Como funciona o quadro', 'Navegador', 'Op válida?', 'Outras abas', 'Dê dois cliques']) {
      assert.ok(words.includes(w), w);
    }
    assert.doesNotMatch(words, /Browser|Double-click|Valid op/);
  });

  test('every arrow is bound at both ends to a shape that exists', () => {
    const arrows = DEMO_ELEMENTS.filter((e) => e.type === 'arrow');
    assert.ok(arrows.length >= 3);
    for (const a of arrows) {
      assert.ok(byId.has(a.startId), `${a.id} start`);
      assert.ok(byId.has(a.endId), `${a.id} end`);
      assert.notEqual(a.startId, a.endId);
    }
  });

  test('seedDemoBoard seeds once, in one batch, and the arrows land on the outlines', async () => {
    const store = createMemoryStore();
    const board = await seedDemoBoard(store);
    assert.ok(board, 'an empty store is seeded');
    assert.equal(board.title, 'Demonstração');

    const snap = await store.getSnapshot(board.id);
    assert.equal(snap.rev, 1, 'one batch, one rev');
    assert.deepEqual(snap.elements.map((e) => e.id), DEMO_ELEMENTS.map((e) => e.id));

    const stored = new Map(snap.elements.map((e) => [e.id, e]));
    for (const a of snap.elements.filter((e) => e.type === 'arrow')) {
      const n = a.points.length;
      const s = stored.get(a.startId);
      const t = stored.get(a.endId);
      // What the store persisted is exactly the resolved position: on the
      // outline (per shape), BIND_GAP outside, aimed per the binding rule.
      const aimS = n === 2 ? { x: t.x + t.w / 2, y: t.y + t.h / 2 } : a.points[1];
      const aimE = n === 2 ? { x: s.x + s.w / 2, y: s.y + s.h / 2 } : a.points[n - 2];
      assert.deepEqual(a.points[0], connectorEndpoint(s, aimS, BIND_GAP), `${a.id} start`);
      assert.deepEqual(a.points[n - 1], connectorEndpoint(t, aimE, BIND_GAP), `${a.id} end`);
    }
    // Stable: resolving the stored board again changes nothing.
    const again = resolveConnectors(snap.elements);
    assert.ok(again.every((e, i) => e === snap.elements[i]));

    assert.equal(await seedDemoBoard(store), null, 'a store with boards is never re-seeded');
    assert.equal((await store.listBoards()).total, 1);
    await store.close();
  });
});
