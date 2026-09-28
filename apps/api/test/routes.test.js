/**
 * REST surface tests.
 *
 * `node --test`, no real port: every request goes through Fastify's
 * `inject()`, so the suite exercises routing, validation, status codes and the
 * store wiring exactly as a real client would see them, and finishes in
 * milliseconds.
 *
 * The app is built the way `server.js` builds it — `buildApp` with a memory
 * store and a fake hub — so these tests run against the same registration order
 * the production app uses. Every test asserts on the response BODY, not just
 * the status: a route that 200s with the wrong shape is a failure here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApp } from '../src/app.js';
import { createStore } from '../src/store/memory.js';
import { Hub } from '../src/ws/hub.js';

/** Prefix the routes are mounted under (see config.API_PREFIX). */
const P = '/api';

/**
 * A REAL hub with `broadcast` wrapped in a spy.
 *
 * Real, not a fake, for one concrete reason: the ws plugin's onClose hook
 * reaches into `hub.peers` / `hub.rooms`, so a hand-rolled object with only a
 * `broadcast` method makes `app.close()` throw and takes the whole test file
 * down with it. Using the actual Hub also means the routes broadcast through
 * the same code path production does; the wrapper only records.
 */
function spyHub() {
  const hub = new Hub();
  const sent = [];
  const realBroadcast = hub.broadcast.bind(hub);

  hub.sent = sent;
  hub.broadcast = (boardId, envelope, except) => {
    sent.push({ boardId, envelope, except });
    return realBroadcast(boardId, envelope, except);
  };
  return hub;
}

async function makeApp() {
  const store = createStore();
  const hub = spyHub();
  // `logLevel: 'silent'` keeps pino's request log out of the TAP output, where
  // it buries the assertion failures that actually matter.
  const app = await buildApp({
    store,
    hub,
    config: { apiPrefix: P, bodyLimit: 8 * 1024 * 1024, logLevel: 'silent', isProduction: false },
  });
  await app.ready();
  return { app, store, hub };
}

/** POST /api/boards, returns the parsed body. Fails the test on a non-201. */
async function createBoard(app, body) {
  const res = await app.inject({ method: 'POST', url: `${P}/boards`, payload: body });
  assert.equal(res.statusCode, 201, `create failed: ${res.body}`);
  return res.json();
}

/** A minimal valid `create` op for a sticky note. */
function createStickyOp(boardId, opId, id, over = {}) {
  return {
    opId,
    boardId,
    kind: 'create',
    element: { id, type: 'sticky', x: 10, y: 20, w: 100, h: 80, label: 'hello', ...over },
  };
}

test('POST /boards — defaults', async (t) => {
  const { app, store } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'POST', url: `${P}/boards`, payload: {} });
  assert.equal(res.statusCode, 201);

  const body = res.json();
  assert.equal(body.board.title, 'Untitled board');
  assert.equal(body.board.theme, 'light');
  assert.equal(body.board.rev, 0);
  assert.ok(body.board.id, 'board has an id');
  assert.equal(typeof body.board.createdAt, 'number');
  assert.deepEqual(body.elements, [], 'a new board has no elements');
  assert.equal(body.rev, 0);

  // Location must point at the resource that was just created.
  const location = res.headers.location;
  assert.ok(location, 'Location header is set');
  assert.ok(location.endsWith(`/boards/${body.board.id}`), `unexpected Location: ${location}`);

  // It is a real board, not just an echo of the request.
  const snap = await store.getSnapshot(body.board.id);
  assert.ok(snap, 'board was persisted');
  assert.deepEqual(snap.elements, []);
});

test('POST /boards — explicit title and theme', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const body = await createBoard(app, { title: 'Sprint planning', theme: 'dark', ownerId: 'u-1' });
  assert.equal(body.board.title, 'Sprint planning');
  assert.equal(body.board.theme, 'dark');
  assert.equal(body.board.ownerId, 'u-1');
  assert.deepEqual(body.elements, []);
});

test('POST /boards — rejects a bad theme with 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards`,
    payload: { title: 'x', theme: 'neon' },
  });
  assert.equal(res.statusCode, 400);

  const body = res.json();
  assert.equal(body.code, 'VALIDATION_FAILED');
  assert.match(body.message, /theme/);
});

test('POST /boards — rejects a non-string title with 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'POST', url: `${P}/boards`, payload: { title: 42 } });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'VALIDATION_FAILED');
  assert.match(res.json().message, /title/);
});

test('GET /boards — default limit and total', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  for (let i = 0; i < 3; i++) await createBoard(app, { title: `board ${i}` });

  const res = await app.inject({ method: 'GET', url: `${P}/boards` });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.total, 3);
  assert.equal(body.boards.length, 3);
  for (const b of body.boards) {
    assert.equal(typeof b.id, 'string');
    assert.equal(typeof b.title, 'string');
    assert.equal(b.theme, 'light');
    assert.equal(b.elementCount, 0, 'BoardSummary carries elementCount');
  }
});

test('GET /boards — explicit limit/offset, total is the whole set', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  for (let i = 0; i < 5; i++) await createBoard(app, { title: `board ${i}` });

  const page1 = (await app.inject({ method: 'GET', url: `${P}/boards?limit=2&offset=0` })).json();
  assert.equal(page1.boards.length, 2);
  assert.equal(page1.total, 5, 'total is unaffected by paging');

  const page2 = (await app.inject({ method: 'GET', url: `${P}/boards?limit=2&offset=2` })).json();
  assert.equal(page2.boards.length, 2);
  assert.equal(page2.total, 5);

  const page3 = (await app.inject({ method: 'GET', url: `${P}/boards?limit=2&offset=4` })).json();
  assert.equal(page3.boards.length, 1, 'the last page is short');
  assert.equal(page3.total, 5);

  // Paging must not repeat a board across pages.
  const ids = [...page1.boards, ...page2.boards, ...page3.boards].map((b) => b.id);
  assert.equal(new Set(ids).size, 5);

  const past = (await app.inject({ method: 'GET', url: `${P}/boards?offset=99` })).json();
  assert.equal(past.boards.length, 0);
  assert.equal(past.total, 5);
});

test('GET /boards — junk query values clamp instead of 400ing', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  await createBoard(app, { title: 'only one' });

  // A client sending ?limit=abc gets the default, not an error.
  const res = await app.inject({ method: 'GET', url: `${P}/boards?limit=abc&offset=xyz` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.total, 1);
  assert.equal(body.boards.length, 1);

  // Out-of-range values clamp rather than being honoured or rejected.
  const over = (await app.inject({ method: 'GET', url: `${P}/boards?limit=99999` })).json();
  assert.equal(over.total, 1);
  const negative = (await app.inject({ method: 'GET', url: `${P}/boards?limit=-5&offset=-5` })).json();
  assert.equal(negative.total, 1);
  assert.equal(negative.boards.length, 1);
});

test('GET /boards — search filters case-insensitively on the title', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  await createBoard(app, { title: 'Sprint Planning' });
  await createBoard(app, { title: 'Retro notes' });
  await createBoard(app, { title: 'Budget 2026' });

  const res = await app.inject({ method: 'GET', url: `${P}/boards?search=SPRINT` });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.total, 1, 'search narrows the total too');
  assert.equal(body.boards.length, 1);
  assert.equal(body.boards[0].title, 'Sprint Planning');

  // Substring, not prefix.
  const sub = (await app.inject({ method: 'GET', url: `${P}/boards?search=notes` })).json();
  assert.equal(sub.total, 1);
  assert.equal(sub.boards[0].title, 'Retro notes');

  const none = (await app.inject({ method: 'GET', url: `${P}/boards?search=zzzz` })).json();
  assert.equal(none.total, 0);
  assert.deepEqual(none.boards, []);
});

/** Titles in a GET /boards body, in response order. */
const titles = (body) => body.boards.map((b) => b.title);

test('GET /boards — ?owner= returns that owner PLUS every unowned board', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  await createBoard(app, { title: 'Ana board', ownerId: 'ana' });
  await createBoard(app, { title: 'Bruno board', ownerId: 'bruno' });
  // No ownerId: exactly the shape of a board that predates the feature.
  await createBoard(app, { title: 'Unowned board' });

  const anas = (await app.inject({ method: 'GET', url: `${P}/boards?owner=ana` })).json();
  assert.equal(anas.total, 2, 'owner filter narrows the total too');
  // The unowned board is the load-bearing case: excluding it looks like a bug
  // (a board with no owner answering a filter on owner) and is not one — it is
  // a board anyone may claim, and hiding it would make every board a person
  // already had vanish the moment they typed a nickname.
  assert.deepEqual(titles(anas).sort(), ['Ana board', 'Unowned board']);
  assert.ok(
    !titles(anas).includes('Bruno board'),
    "another person's board must not leak into this list",
  );

  const brunos = (await app.inject({ method: 'GET', url: `${P}/boards?owner=bruno` })).json();
  assert.deepEqual(titles(brunos).sort(), ['Bruno board', 'Unowned board']);

  // No param: no filter at all.
  const all = (await app.inject({ method: 'GET', url: `${P}/boards` })).json();
  assert.equal(all.total, 3);
  assert.deepEqual(titles(all).sort(), ['Ana board', 'Bruno board', 'Unowned board']);

  // A present-but-empty owner is absent, not an error and not match-nothing.
  const empty = (await app.inject({ method: 'GET', url: `${P}/boards?owner=` })).json();
  assert.equal(empty.total, 3, '?owner= behaves like no param');
  assert.deepEqual(titles(empty).sort(), titles(all).sort());

  // An owner nobody has claimed still gets the unowned boards.
  const carol = (await app.inject({ method: 'GET', url: `${P}/boards?owner=carol` })).json();
  assert.deepEqual(titles(carol), ['Unowned board']);
});

test('GET /boards — ?owner= composes with ?search= and validates its input', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  await createBoard(app, { title: 'Ana notes', ownerId: 'ana' });
  await createBoard(app, { title: 'Ana budget', ownerId: 'ana' });
  await createBoard(app, { title: 'Bruno notes', ownerId: 'bruno' });
  await createBoard(app, { title: 'Unowned notes' });

  // Both filters apply, and the unowned board survives the search too.
  const both = (await app.inject({ method: 'GET', url: `${P}/boards?owner=ana&search=notes` })).json();
  assert.deepEqual(titles(both).sort(), ['Ana notes', 'Unowned notes']);

  // The empty-owner case must not shadow a real search.
  const empty = (await app.inject({ method: 'GET', url: `${P}/boards?owner=&search=notes` })).json();
  assert.deepEqual(titles(empty).sort(), ['Ana notes', 'Bruno notes', 'Unowned notes']);

  // Same bound as ownerId on the body: over MAX_ID_LEN is a 400, not a filter
  // that quietly matches nothing.
  const tooLong = await app.inject({ method: 'GET', url: `${P}/boards?owner=${'x'.repeat(65)}` });
  assert.equal(tooLong.statusCode, 400);
  assert.equal(tooLong.json().code, 'VALIDATION_FAILED');
  assert.match(tooLong.json().message, /owner/);
});

test('GET /boards — ?owner= does not leak when the store ignores it', async (t) => {
  // A store that has not implemented `owner` returns everything; the route has
  // to drop the foreign rows itself or the filter is cosmetic.
  const { app, store } = await makeApp();
  t.after(() => app.close());

  await createBoard(app, { title: 'Ana board', ownerId: 'ana' });
  await createBoard(app, { title: 'Bruno board', ownerId: 'bruno' });

  const real = store.listBoards;
  store.listBoards = async (opts) => {
    const { owner, ...rest } = opts ?? {};
    return real(rest);
  };

  const res = await app.inject({ method: 'GET', url: `${P}/boards?owner=ana` });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.deepEqual(titles(body), ['Ana board']);
  assert.equal(body.total, 1, 'total matches what was actually returned');
});

test('GET /boards/:id — found', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Board one' });

  const res = await app.inject({ method: 'GET', url: `${P}/boards/${created.board.id}` });
  assert.equal(res.statusCode, 200);

  const body = res.json();
  assert.equal(body.board.id, created.board.id);
  assert.equal(body.board.title, 'Board one');
  assert.deepEqual(body.elements, []);
  assert.equal(body.rev, 0);
});

test('GET /boards/:id — snapshot alias returns the same body', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Aliased' });

  const direct = await app.inject({ method: 'GET', url: `${P}/boards/${created.board.id}` });
  const alias = await app.inject({ method: 'GET', url: `${P}/boards/${created.board.id}/snapshot` });
  assert.equal(alias.statusCode, 200);
  assert.deepEqual(alias.json(), direct.json());
});

test('GET /boards/:id — 404 for a malformed id and for an unknown one', async (t) => {
  const { app, store } = await makeApp();
  t.after(() => app.close());

  // Malformed: never reaches the store. 64+ chars of junk is not an id.
  const junk = 'x'.repeat(80);
  const malformed = await app.inject({ method: 'GET', url: `${P}/boards/${junk}` });
  assert.equal(malformed.statusCode, 400);
  assert.equal(malformed.json().code, 'VALIDATION_FAILED');

  // Well-formed but unknown: a real 404.
  const unknown = await app.inject({ method: 'GET', url: `${P}/boards/does-not-exist` });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().code, 'NOT_FOUND');

  const snapAlias = await app.inject({ method: 'GET', url: `${P}/boards/does-not-exist/snapshot` });
  assert.equal(snapAlias.statusCode, 404);
  assert.equal(snapAlias.json().code, 'NOT_FOUND');

  assert.equal(await store.getBoard('does-not-exist'), null);
});

test('PATCH /boards/:id — updates the title', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Before' });
  const id = created.board.id;

  const res = await app.inject({ method: 'PATCH', url: `${P}/boards/${id}`, payload: { title: 'After' } });
  assert.equal(res.statusCode, 200);

  const board = res.json();
  assert.equal(board.id, id);
  assert.equal(board.title, 'After');
  assert.equal(board.theme, 'light', 'untouched fields survive');
  assert.equal(board.updatedAt >= created.board.updatedAt, true);

  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.board.title, 'After', 'the change is persisted');
});

test('PATCH /boards/:id — updates the theme', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Themed' });
  const res = await app.inject({
    method: 'PATCH',
    url: `${P}/boards/${created.board.id}`,
    payload: { theme: 'dark' },
  });
  assert.equal(res.statusCode, 200);

  const board = res.json();
  assert.equal(board.theme, 'dark');
  assert.equal(board.title, 'Themed');

  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${created.board.id}` })).json();
  assert.equal(snap.board.theme, 'dark');
});

test('PATCH /boards/:id — rejects an empty patch with 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Untouched' });
  const id = created.board.id;

  // `{ ownerId: 'u-9' }` is no longer in this list: PATCH can now CLAIM a board,
  // so it is a valid patch rather than an empty one. It is covered by
  // "PATCH /boards/:id — claims an unowned board" below.
  for (const payload of [{}, { nope: true }]) {
    const res = await app.inject({ method: 'PATCH', url: `${P}/boards/${id}`, payload });
    assert.equal(res.statusCode, 400, `payload ${JSON.stringify(payload)} should be rejected`);
    assert.equal(res.json().code, 'VALIDATION_FAILED');
  }

  // The board must be exactly as it was.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.board.title, 'Untouched');
});

test('PATCH /boards/:id — claims an unowned board, and a claim can move', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const ana = (await createBoard(app, { title: 'Ana board', ownerId: 'ana' })).board;
  const bruno = (await createBoard(app, { title: 'Bruno board', ownerId: 'bruno' })).board;
  const free = (await createBoard(app, { title: 'Free board' })).board;
  assert.equal(free.ownerId, null, 'created with no owner, as boards always are by default');

  // The claim itself: ownerId alone is a valid patch, with no title/theme.
  const claim = await app.inject({
    method: 'PATCH',
    url: `${P}/boards/${free.id}`,
    payload: { ownerId: 'ana' },
  });
  assert.equal(claim.statusCode, 200);
  assert.equal(claim.json().ownerId, 'ana');
  assert.equal(claim.json().title, 'Free board', 'claiming does not disturb the rest of the board');

  const isAna = (await app.inject({ method: 'GET', url: `${P}/boards?owner=ana` })).json();
  assert.deepEqual(titles(isAna).sort(), ['Ana board', 'Free board']);
  const isBruno = (await app.inject({ method: 'GET', url: `${P}/boards?owner=bruno` })).json();
  assert.deepEqual(
    titles(isBruno),
    ['Bruno board'],
    'a claimed board leaves the pool of the person who never took it',
  );

  // A title-only patch must NOT wipe ownership — the field is only touched
  // when the client actually sends it.
  const retitle = await app.inject({
    method: 'PATCH',
    url: `${P}/boards/${free.id}`,
    payload: { title: 'Renamed' },
  });
  assert.equal(retitle.statusCode, 200);
  assert.equal(retitle.json().ownerId, 'ana', 'owner survives an unrelated patch');

  // Claims can move between people, and the board follows.
  const move = await app.inject({
    method: 'PATCH',
    url: `${P}/boards/${bruno.id}`,
    payload: { ownerId: 'ana' },
  });
  assert.equal(move.statusCode, 200);
  assert.equal(move.json().ownerId, 'ana');
  // 'Renamed' is the board claimed and then retitled above.
  assert.deepEqual(
    titles((await app.inject({ method: 'GET', url: `${P}/boards?owner=ana` })).json()).sort(),
    ['Ana board', 'Bruno board', 'Renamed'],
  );
  assert.deepEqual(
    titles((await app.inject({ method: 'GET', url: `${P}/boards?owner=bruno` })).json()),
    [],
  );
});

test('PATCH /boards/:id — still rejects a malformed ownerId', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Guarded' });
  const id = created.board.id;

  for (const ownerId of ['', 42, 'x'.repeat(65)]) {
    const res = await app.inject({
      method: 'PATCH',
      url: `${P}/boards/${id}`,
      payload: { ownerId },
    });
    assert.equal(res.statusCode, 400, `ownerId ${JSON.stringify(ownerId)} should be rejected`);
    assert.equal(res.json().code, 'VALIDATION_FAILED');
    assert.match(res.json().message, /ownerId/);
  }

  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.board.ownerId, null, 'a rejected claim changes nothing');
});

test('PATCH /boards/:id — 404 for an unknown board, 400 for a bad theme', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const missing = await app.inject({ method: 'PATCH', url: `${P}/boards/nope`, payload: { title: 'x' } });
  assert.equal(missing.statusCode, 404);
  assert.equal(missing.json().code, 'NOT_FOUND');

  const created = await createBoard(app, {});
  const bad = await app.inject({
    method: 'PATCH',
    url: `${P}/boards/${created.board.id}`,
    payload: { theme: 'chartreuse' },
  });
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().message, /theme/);
});

test('DELETE /boards/:id — 200 then 404', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Doomed' });
  const id = created.board.id;

  const res = await app.inject({ method: 'DELETE', url: `${P}/boards/${id}` });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { deleted: true });

  const again = await app.inject({ method: 'DELETE', url: `${P}/boards/${id}` });
  assert.equal(again.statusCode, 404);
  assert.equal(again.json().code, 'NOT_FOUND');

  assert.equal((await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).statusCode, 404);
});

test('POST /boards/:id/ops — a valid create is applied and shows up in the snapshot', async (t) => {
  const { app, store, hub } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, { title: 'Drawing' });
  const id = created.board.id;

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: { ops: [createStickyOp(id, 'op-1', 'el-1')], actorId: 'alice' },
  });
  assert.equal(res.statusCode, 200);

  const result = res.json();
  assert.equal(result.status, 'applied');
  assert.equal(result.rev, 1, 'one batch bumps the rev exactly once');
  assert.equal(result.appliedOps.length, 1);
  assert.equal(result.appliedOps[0].opId, 'op-1');

  // The element is really on the board.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.elements.length, 1);
  assert.equal(snap.elements[0].id, 'el-1');
  assert.equal(snap.elements[0].type, 'sticky');
  assert.equal(snap.elements[0].label, 'hello');
  assert.equal(snap.rev, 1);
  assert.equal(snap.board.rev, 1);

  // elementCount in the list reflects the write.
  const list = (await app.inject({ method: 'GET', url: `${P}/boards` })).json();
  assert.equal(list.boards.find((b) => b.id === id).elementCount, 1);

  // ...and the write was fanned out to the room, to everyone.
  assert.equal(hub.sent.length, 1);
  assert.equal(hub.sent[0].boardId, id);
  assert.equal(hub.sent[0].envelope.type, 'op');
  assert.equal(hub.sent[0].envelope.rev, 1);
  assert.equal(hub.sent[0].envelope.ops.length, 1);
  assert.equal(hub.sent[0].except, null, 'null except = everyone in the room');

  assert.equal((await store.hasOp(id, 'op-1')), true, 'the opId is recorded for dedupe');
});

test('POST /boards/:id/ops — a batch is atomic and bumps the rev once', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: {
      ops: [
        createStickyOp(id, 'op-a', 'el-a'),
        createStickyOp(id, 'op-b', 'el-b', { label: 'second' }),
        { opId: 'op-c', boardId: id, kind: 'reorder', order: ['el-b', 'el-a'] },
      ],
    },
  });
  assert.equal(res.statusCode, 200);

  const result = res.json();
  assert.equal(result.status, 'applied');
  assert.equal(result.rev, 1, 'three ops in one batch = one rev bump');
  assert.equal(result.appliedOps.length, 3);

  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.rev, 1);
  assert.deepEqual(snap.elements.map((e) => e.id), ['el-b', 'el-a'], 'z-order follows the reorder op');
});

test('POST /boards/:id/ops — a stale baseRev is 409 and changes nothing', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;

  // One good batch: rev is now 1.
  const ok = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: { ops: [createStickyOp(id, 'op-1', 'el-1')] },
  });
  assert.equal(ok.json().rev, 1);

  // A client that still believes the board is at rev 0 sends baseRev: 0. Any
  // op carrying a stale baseRev rejects the WHOLE batch.
  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: {
      ops: [{ ...createStickyOp(id, 'op-2', 'el-2', { label: 'stale' }), baseRev: 0 }],
    },
  });
  assert.equal(res.statusCode, 409);

  const body = res.json();
  assert.equal(body.statusCode, 409);
  assert.equal(body.code, 'REV_CONFLICT');
  assert.ok(body.rev, 'the current rev travels with the 409 so the client can resync');
  assert.equal(body.rev, 1, 'rev is the CURRENT rev, so the client knows where it moved to');

  // Nothing was written and the rev did not move — otherwise every retry
  // would conflict too.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.rev, 1, 'a rejected batch must not bump the rev');
  assert.equal(snap.elements.length, 1, 'a rejected batch must not apply anything');
  assert.equal(snap.elements[0].id, 'el-1');
});

test('POST /boards/:id/ops — a matching baseRev is accepted', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: { ops: [{ ...createStickyOp(id, 'op-1', 'el-1'), baseRev: 0 }] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'applied');
  assert.equal(res.json().rev, 1);
});

test('POST /boards/:id/ops — a malformed op is 400 naming the field path', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;

  // A rect with a non-numeric w: the message must name the op index and the
  // field, not just say "validation error".
  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: {
      ops: [
        createStickyOp(id, 'op-ok', 'el-ok'),
        { opId: 'op-bad', boardId: id, kind: 'create', element: { id: 'el-bad', type: 'rect', x: 0, y: 0, w: 'wide', h: 10 } },
      ],
    },
  });
  assert.equal(res.statusCode, 400);

  const body = res.json();
  assert.equal(body.code, 'VALIDATION_FAILED');
  assert.match(body.message, /ops\[1\]/, 'the message names the offending op index');
  assert.match(body.message, /\.w/, 'the message names the offending field');

  // A batch rejected wholesale: the valid first op did not sneak through.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.elements.length, 0, 'no op in a rejected batch is applied');
  assert.equal(snap.rev, 0);
});

test('POST /boards/:id/ops — other malformed shapes are 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;
  const url = `${P}/boards/${id}/ops`;

  const cases = [
    [{ ops: 'not-an-array' }, /ops/],
    [{ ops: [{ kind: 'create' }] }, /opId/],                       // no opId
    [{ ops: [{ opId: 'x', kind: 'teleport' }] }, /kind/],         // bad kind
    [{ ops: [{ opId: 'x', kind: 'delete' }] }, /elementId/],      // delete needs an id
    [{ ops: [{ opId: 'x', kind: 'create', element: { id: 'e', type: 'unicorn' } }] }, /type/],
    [{}, /ops/],
  ];

  for (const [payload, pattern] of cases) {
    const res = await app.inject({ method: 'POST', url, payload });
    assert.equal(res.statusCode, 400, `expected 400 for ${JSON.stringify(payload)}`);
    assert.equal(res.json().code, 'VALIDATION_FAILED');
    assert.match(res.json().message, pattern);
  }
});

test('POST /boards/:id/ops — replaying the same opIds is a 200 duplicate', async (t) => {
  const { app, hub } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;
  const url = `${P}/boards/${id}/ops`;
  const payload = { ops: [createStickyOp(id, 'op-retry', 'el-retry')] };

  const first = await app.inject({ method: 'POST', url, payload });
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().status, 'applied');
  const appliedRev = first.json().rev;
  const broadcastsAfterFirst = hub.sent.length;

  // The client never saw the ack and retried the identical batch.
  const second = await app.inject({ method: 'POST', url, payload });
  assert.equal(second.statusCode, 200, 'a duplicate is a successful no-op, not an error');

  const body = second.json();
  assert.equal(body.status, 'duplicate');
  assert.equal(body.rev, appliedRev, 'the rev is unchanged by a retry');
  assert.deepEqual(body.appliedOps, [], 'a retry applies nothing');

  // ...and the element exists exactly once.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.elements.length, 1);
  assert.equal(snap.rev, appliedRev);
  assert.equal(
    hub.sent.length,
    broadcastsAfterFirst,
    'a duplicate is not re-broadcast to the room',
  );
});

test('POST /boards/:id/ops — against an unknown board is 404', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/ghost-board/ops`,
    payload: { ops: [createStickyOp('ghost-board', 'op-1', 'el-1')] },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

test('POST /boards/:id/ops — a malformed board id is 400', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${'z'.repeat(70)}/ops`,
    payload: { ops: [createStickyOp('z', 'op-1', 'el-1')] },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().code, 'VALIDATION_FAILED');
});

test('DELETE /boards/:id/elements — clears the board and bumps the rev', async (t) => {
  const { app, hub } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;
  const url = `${P}/boards/${id}/ops`;

  await app.inject({
    method: 'POST',
    url,
    payload: {
      ops: [createStickyOp(id, 'op-1', 'el-1'), createStickyOp(id, 'op-2', 'el-2')],
    },
  });
  const before = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(before.elements.length, 2);
  assert.equal(before.rev, 1);
  const broadcastsBefore = hub.sent.length;

  const res = await app.inject({ method: 'DELETE', url: `${P}/boards/${id}/elements` });
  assert.equal(res.statusCode, 200);

  const result = res.json();
  assert.equal(result.status, 'applied');
  assert.equal(result.rev, 2, 'a clear is a mutation, so the rev moves');
  assert.deepEqual(result.appliedOps, []);

  const after = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(after.elements.length, 0, 'the board is empty');
  assert.equal(after.rev, 2);
  assert.equal(after.board.id, id, 'the board itself still exists');

  const list = (await app.inject({ method: 'GET', url: `${P}/boards` })).json();
  assert.equal(list.boards.find((b) => b.id === id).elementCount, 0);

  assert.equal(hub.sent.length, broadcastsBefore + 1, 'the clear is fanned out');
  assert.equal(hub.sent.at(-1).boardId, id);
  assert.equal(hub.sent.at(-1).except, null);
});

test('DELETE /boards/:id/elements — an unknown board is 404', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'DELETE', url: `${P}/boards/ghost/elements` });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'NOT_FOUND');
});

test('POST /boards/:id/ops — a store-thrown contract violation is 400, not 500', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;
  const url = `${P}/boards/${id}/ops`;

  // Seed one element.
  await app.inject({ method: 'POST', url, payload: { ops: [createStickyOp(id, 'op-1', 'el-1')] } });

  // A second `create` of the same element id passes validateOps (which cannot
  // know what is already on the board) and is rejected by the STORE. That is
  // the client's bug: 400, and the whole batch must roll back.
  const res = await app.inject({
    method: 'POST',
    url,
    payload: {
      ops: [
        createStickyOp(id, 'op-2', 'el-2'),
        createStickyOp(id, 'op-3', 'el-1'),
      ],
    },
  });
  assert.equal(res.statusCode, 400, 'a rejected batch is a 400, never a 500');

  const body = res.json();
  assert.equal(body.code, 'VALIDATION_FAILED');
  assert.match(body.message, /already exists/);
  assert.match(body.message, /ops\[1\]/, 'the message names the offending op index');

  // Atomicity: op-2 did not sneak through alongside the rejected op-3.
  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.elements.length, 1, 'the whole batch rolled back');
  assert.equal(snap.elements[0].id, 'el-1');
  assert.equal(snap.rev, 1, 'a rolled-back batch does not bump the rev');
});

test('POST /boards/:id/ops — a genuine store failure is a 500, not masked as 400', async (t) => {
  const { app, store } = await makeApp();
  t.after(() => app.close());

  // Infrastructure breakage must not be reported as a client error; a 400
  // here would tell the user to fix their op when the real fault is ours.
  store.applyOps = async () => {
    const err = new Error('database is locked');
    throw err;
  };

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/whatever/ops`,
    payload: { ops: [createStickyOp('whatever', 'op-1', 'el-1')] },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().code, 'INTERNAL');
});

test('GET /health — 200 with a real store read', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const empty = await app.inject({ method: 'GET', url: `${P}/health` });
  assert.equal(empty.statusCode, 200);
  const before = empty.json();
  assert.equal(before.ok, true);
  assert.equal(before.boards, 0);
  assert.equal(typeof before.uptime, 'number');
  assert.ok(before.uptime >= 0);
  assert.equal(typeof before.version, 'string');
  assert.ok(before.version.length > 0);
  assert.ok(['sqlite', 'memory'].includes(before.store), `unexpected store kind: ${before.store}`);

  // The board count is a real query, not a constant.
  await createBoard(app, { title: 'a' });
  await createBoard(app, { title: 'b' });

  const after = (await app.inject({ method: 'GET', url: `${P}/health` })).json();
  assert.equal(after.ok, true);
  assert.equal(after.boards, 2);
});

test('GET /health — 503 when the store throws', async (t) => {
  const { app, store } = await makeApp();
  t.after(() => app.close());

  // A health check that lies is worse than one that fails.
  store.listBoards = async () => {
    throw new Error('disk on fire');
  };

  const res = await app.inject({ method: 'GET', url: `${P}/health` });
  assert.equal(res.statusCode, 503);

  const body = res.json();
  assert.equal(body.ok, false, 'ok:false is the whole point');
  assert.match(body.message, /disk on fire/);
});

test('POST /boards/:id/ops — a broadcast failure does not fail the write', async (t) => {
  const { app, hub } = await makeApp();
  t.after(() => app.close());

  const created = await createBoard(app, {});
  const id = created.board.id;

  // The write is already persisted; a dead socket must not roll it back.
  hub.broadcast = () => {
    throw new Error('socket exploded');
  };

  const res = await app.inject({
    method: 'POST',
    url: `${P}/boards/${id}/ops`,
    payload: { ops: [createStickyOp(id, 'op-1', 'el-1')] },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'applied');

  const snap = (await app.inject({ method: 'GET', url: `${P}/boards/${id}` })).json();
  assert.equal(snap.elements.length, 1, 'the write landed despite the broadcast failure');
});

test('unknown routes are 404, not 500', async (t) => {
  const { app } = await makeApp();
  t.after(() => app.close());

  const res = await app.inject({ method: 'GET', url: `${P}/nope` });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().code, 'ROUTE_NOT_FOUND');
});
