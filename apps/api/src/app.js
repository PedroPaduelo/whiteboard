/**
 * Builds the Fastify instance. Separate from server.js on purpose: app.js
 * never listens, so tests can `buildApp()` and use `app.inject()` without
 * binding a port, and server.js stays a thin process-level concern
 * (config -> store -> listen -> signals).
 *
 * The store and hub arrive as arguments rather than being constructed here,
 * so a test can pass a memory store and a fake hub.
 */

import Fastify, { LogController } from 'fastify';

import defaultConfig from './config.js';
import corsPlugin from './plugins/cors.js';
import { errorHandler } from './plugins/errors.js';
import healthRoutes from './plugins/health.js';
import websocketPlugin from './ws/plugin.js';
import boardsRoutes from './routes/boards.js';
import opsRoutes from './routes/ops.js';

const VERSION = '1.0.0';

/**
 * @param {object} deps
 * @param {import('./store/index.js').Store} deps.store
 * @param {import('./ws/hub.js').Hub} deps.hub
 * @param {object} [deps.config]
 * @param {string} [deps.version]
 */
export async function buildApp({ store, hub, config = defaultConfig, version = VERSION } = {}) {
  if (!store) throw new TypeError('buildApp requires a store');
  if (!hub) throw new TypeError('buildApp requires a hub');

  const app = Fastify({
    logger: { level: config.logLevel },
    bodyLimit: config.bodyLimit,
    trustProxy: config.trustProxy,
    // Per-request lines are noise in production; real errors still come
    // through the error handler. `logController` is the non-deprecated route
    // (the top-level `disableRequestLogging` option warns as of Fastify 5.5).
    logController: new LogController({
      disableRequestLogging: config.isProduction && config.logLevel !== 'debug',
    }),
    requestIdHeader: 'x-request-id',
  });

  // Decoration BEFORE the plugins that close over them, so every route and the
  // ws handlers can reach `app.store` / `app.hub` regardless of registration
  // order. `Object.assign` on the returned app for the same reason.
  app.decorate('store', store);
  app.decorate('hub', hub);
  app.decorate('config', config);

  app.setErrorHandler(errorHandler);
  app.setNotFoundHandler((request, reply) => {
    reply.code(404).send({
      statusCode: 404,
      code: 'ROUTE_NOT_FOUND',
      error: 'Not Found',
      message: `${request.method} ${request.url} is not a route on this API`,
    });
  });

  await app.register(corsPlugin, { corsOrigin: config.corsOrigin });

  // @fastify/websocket registers the `GET {prefix}/ws` upgrade route. It must
  // come before the REST routes so `app.route` never sees the ws path.
  await app.register(websocketPlugin, { config, store, hub });

  await app.register(
    async (scope) => {
      await scope.register(healthRoutes, { config, version });
      await scope.register(boardsRoutes, { config, store, hub });
      await scope.register(opsRoutes, { config, store, hub });
    },
    { prefix: config.apiPrefix },
  );

  app.addHook('onClose', async () => {
    // Order matters: stop accepting work, then release the handle. `close` is
    // sync per the Store contract but may be async in a future driver, so await
    // it either way and never let a failure block shutdown.
    try {
      if (typeof hub?.close === 'function') await hub.close();
    } catch (err) {
      app.log.error({ err }, 'hub close failed');
    }
    try {
      await store.close();
    } catch (err) {
      app.log.error({ err }, 'store close failed');
    }
  });

  // Decorate returns the instance; make it available to importers that build
  // the app through a plugin wrapper.
  Object.assign(app, { store, hub, config });

  return app;
}

export default buildApp;
export { VERSION };
