/**
 * `GET {prefix}/health` — liveness plus one real store call.
 *
 * Deliberately dependency-free: no config import (the instance is decorated
 * with it by app.js), no timers, exactly one await. A health endpoint that
 * cannot fail is worthless, so a throwing store yields 503 with the reason
 * rather than a cheerful `{ok:true}`.
 */

const STATUS_TEXT = Object.freeze({ 503: 'Service Unavailable' });

export default async function healthPlugin(fastify, opts) {
  const options = opts || {};
  // Fastify injects `prefix` for a plugin registered inside a prefixed scope,
  // which is how app.js mounts this as `/api/health`.
  const prefix = typeof options.prefix === 'string' ? options.prefix : '';
  const path = `${prefix}/health`;

  /** 'sqlite' | 'memory', from the decorated config; driver name as a backstop. */
  const storeKind = () => {
    const fromConfig = fastify.config && fastify.config.storage;
    if (typeof fromConfig === 'string' && fromConfig) return fromConfig;
    if (fastify.store && typeof fastify.store.driver === 'string') return fastify.store.driver;
    return 'memory';
  };

  const appVersion = () => {
    const candidates = [options.version, fastify.config && fastify.config.version];
    for (const c of candidates) {
      if (typeof c === 'string' && c.length > 0) return c;
      if (typeof c === 'number') return String(c);
    }
    return '0.0.0';
  };

  const uptime = () => Math.round(process.uptime() * 1000) / 1000;

  fastify.get(path, async (request, reply) => {
    const body = {
      ok: true,
      uptime: uptime(),
      version: appVersion(),
      boards: 0,
      store: storeKind(),
    };

    try {
      const store = fastify.store;
      if (!store || typeof store.listBoards !== 'function') {
        throw new Error('no store decorated on the app instance');
      }
      // One row is plenty: `total` is the whole point and it does not depend
      // on the page size.
      const res = await store.listBoards({ limit: 1 });
      body.boards = Number.isFinite(res && res.total) ? res.total : 0;
      return reply.send(body);
    } catch (err) {
      const message = err && err.message ? err.message : 'store unavailable';
      return reply.code(503).send({
        statusCode: 503,
        code: 'STORE_UNAVAILABLE',
        error: STATUS_TEXT[503],
        ok: false,
        uptime: body.uptime,
        version: body.version,
        store: body.store,
        reason: message,
        message,
      });
    }
  });
}
