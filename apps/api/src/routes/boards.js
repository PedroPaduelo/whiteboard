/**
 * REST: board CRUD and snapshots.
 *
 * Registered by `app.js` under the app's own API prefix, so every path here is
 * relative to it — this plugin owns `/boards`, not `/api/boards`.
 *
 * The store is reached exclusively through the `fastify.store` decoration
 * (`const store = fastify.store`), never by importing the store module: that
 * keeps one instance per process and lets tests swap the driver.
 *
 * Error bodies are written directly rather than thrown, so the exact
 * `{statusCode, error, message, code}` envelope the contract promises is
 * produced even when the app-level error handler is not in the chain (tests,
 * embedded use). Genuinely unexpected failures still throw and reach the app
 * error handler.
 */

/** Board ids are opaque client-visible strings; keep them short and printable. */
const MAX_ID_LEN = 64;
const MAX_TITLE_LEN = 200;
const THEMES = Object.freeze(['light', 'dark']);
const DEFAULT_TITLE = 'Untitled board';
const DEFAULT_THEME = 'light';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const STATUS_TEXT = Object.freeze({
  400: 'Bad Request',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  503: 'Service Unavailable',
});

/**
 * Send a contract error envelope. `extra` merges additional fields (e.g. `rev`
 * on a 409) so the client can branch without a second round trip.
 */
export function sendError(reply, statusCode, code, message, extra) {
  return reply.code(statusCode).send({
    statusCode,
    code,
    error: STATUS_TEXT[statusCode] || 'Error',
    message,
    ...(extra || {}),
  });
}

/**
 * Shape check for a `:id` before it ever reaches the store. A garbage id must
 * not become a database query.
 * @returns {string|null} the id, or null when malformed
 */
export function assertBoardId(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > MAX_ID_LEN) return null;
  if (raw.trim().length === 0) return null;
  // Whitespace and control characters never appear in a generated id, and
  // allowing them through means a caller can smuggle odd bytes into a query.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  return raw;
}

/** Clamp a query value into range; a junk value falls back to the default. */
function clampInt(raw, def, min, max) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  const i = Math.floor(n);
  if (i < min) return min;
  if (max !== undefined && i > max) return max;
  return i;
}

/**
 * Validate the `{title?, theme?, ownerId?}` body used by POST and PATCH.
 * Unknown keys are ignored rather than rejected: a newer client may send more.
 * @returns {{ok: true, value: Object} | {ok: false, message: string}}
 */
function validateBoardInput(body, { partial }) {
  if (body === undefined || body === null) body = {};
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: 'body: expected an object' };
  }

  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;

  if (has('title')) {
    const t = body.title;
    if (typeof t !== 'string') {
      return { ok: false, message: 'title: expected a string' };
    }
    if (t.length > MAX_TITLE_LEN) {
      return { ok: false, message: `title: expected a string <= ${MAX_TITLE_LEN} chars` };
    }
    out.title = t;
  } else if (!partial) {
    out.title = DEFAULT_TITLE;
  }

  if (has('theme')) {
    if (!THEMES.includes(body.theme)) {
      return { ok: false, message: `theme: must be one of ${THEMES.join(', ')}` };
    }
    out.theme = body.theme;
  } else if (!partial) {
    out.theme = DEFAULT_THEME;
  }

  if (has('ownerId') && body.ownerId !== null) {
    const o = body.ownerId;
    if (typeof o !== 'string' || o.length === 0 || o.length > MAX_ID_LEN) {
      return { ok: false, message: `ownerId: expected a string of 1..${MAX_ID_LEN} chars` };
    }
    out.ownerId = o;
  } else if (!partial && body.ownerId === null) {
    out.ownerId = null;
  }

  // PATCH takes `{title?, theme?}` only. `ownerId` is a create-time field — the
  // store's updateBoard has no notion of reassigning ownership — so a PATCH
  // carrying nothing else is an empty patch, not an ownership change.
  if (partial) delete out.ownerId;

  if (partial && Object.keys(out).length === 0) {
    return { ok: false, message: 'patch: expected at least one of title, theme' };
  }

  return { ok: true, value: out };
}

export default async function boardsRoutes(fastify, opts) {
  const opts_ = opts || {};
  const prefix = opts_.prefix || '';

  /**
   * The prefix this route is actually mounted under, used to build the
   * `Location` header on create. Falls back to the plugin option because
   * `routeOptions.prefix` is only present on newer Fastify versions.
   */
  const mountPrefix = (request) => {
    const fromRoute = request && request.routeOptions && request.routeOptions.prefix;
    if (typeof fromRoute === 'string' && fromRoute.length > 0) return fromRoute;
    return prefix;
  };

  const readId = (request, reply) => {
    const id = assertBoardId(request.params && request.params.id);
    if (id === null) {
      sendError(reply, 400, 'VALIDATION_FAILED', `id: expected a non-empty string of at most ${MAX_ID_LEN} chars`);
      return null;
    }
    return id;
  };

  /** Shared by GET /boards/:id and GET /boards/:id/snapshot — same body. */
  async function snapshotHandler(request, reply) {
    const id = readId(request, reply);
    if (id === null) return reply;

    const store = fastify.store;
    const snap = await store.getSnapshot(id);
    if (!snap || !snap.board) {
      return sendError(reply, 404, 'NOT_FOUND', `board ${id} not found`);
    }
    return reply.send({
      board: snap.board,
      elements: Array.isArray(snap.elements) ? snap.elements : [],
      rev: Number.isFinite(snap.rev) ? snap.rev : snap.board.rev ?? 0,
    });
  }

  fastify.get('/boards', async (request, reply) => {
    const store = fastify.store;
    const q = (request.query && typeof request.query === 'object') ? request.query : {};

    const limit = clampInt(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = clampInt(q.offset, 0, 0);
    const search = typeof q.search === 'string' ? q.search.trim() : '';

    const query = { limit, offset };
    if (search) query.search = search;

    const res = await store.listBoards(query);
    let boards = Array.isArray(res && res.boards) ? res.boards : [];
    const total = Number.isFinite(res && res.total) ? res.total : boards.length;

    // Defensive: a store that has not (yet) implemented `search` returns
    // unfiltered rows. Dropping the non-matching ones keeps this page honest;
    // the filtered total is then unknown, so report what is actually in hand
    // rather than a count for a set the caller cannot see.
    if (search) {
      const needle = search.toLowerCase();
      const filtered = boards.filter(
        (b) => typeof b.title === 'string' && b.title.toLowerCase().includes(needle),
      );
      if (filtered.length !== boards.length) {
        return reply.send({ boards: filtered, total: filtered.length });
      }
    }

    return reply.send({ boards, total });
  });

  fastify.post('/boards', async (request, reply) => {
    const parsed = validateBoardInput(request.body, { partial: false });
    if (!parsed.ok) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.message);
    }

    const store = fastify.store;
    const board = await store.createBoard(parsed.value);
    const base = `${mountPrefix(request)}/boards/${board.id}`;
    reply.header('Location', base);

    // Read back through the snapshot path so the create response and a
    // subsequent GET are byte-identical; fall back to the bare board if the
    // store cannot read it back immediately.
    let snap = null;
    try {
      snap = await store.getSnapshot(board.id);
    } catch {
      snap = null;
    }

    if (snap && snap.board) {
      return reply.code(201).send({
        board: snap.board,
        elements: Array.isArray(snap.elements) ? snap.elements : [],
        rev: Number.isFinite(snap.rev) ? snap.rev : snap.board.rev ?? 0,
      });
    }
    return reply.code(201).send({ board, elements: [], rev: board.rev ?? 0 });
  });

  fastify.get('/boards/:id', snapshotHandler);

  fastify.get('/boards/:id/snapshot', snapshotHandler);

  fastify.patch('/boards/:id', async (request, reply) => {
    const id = readId(request, reply);
    if (id === null) return reply;

    const parsed = validateBoardInput(request.body, { partial: true });
    if (!parsed.ok) {
      return sendError(reply, 400, 'VALIDATION_FAILED', parsed.message);
    }

    const store = fastify.store;
    const board = await store.updateBoard(id, parsed.value);
    if (!board) {
      return sendError(reply, 404, 'NOT_FOUND', `board ${id} not found`);
    }
    return reply.send(board);
  });

  fastify.delete('/boards/:id', async (request, reply) => {
    const id = readId(request, reply);
    if (id === null) return reply;

    const store = fastify.store;
    const deleted = await store.deleteBoard(id);
    if (!deleted) {
      return sendError(reply, 404, 'NOT_FOUND', `board ${id} not found`);
    }
    return reply.send({ deleted: true });
  });
}
