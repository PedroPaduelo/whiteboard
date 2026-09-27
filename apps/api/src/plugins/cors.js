/**
 * CORS for the whiteboard API.
 *
 * Two modes, chosen by config:
 *   ['*']      -> any origin, no credentials. The right default for a public
 *                 board app: the API is token-less, so `credentials: true`
 *                 would be a cross-site-request-forgery footgun, not a feature.
 *   allowlist  -> exact string matches only. No suffix or wildcard matching:
 *                 `https://evil-example.com.attacker.net` must not pass an
 *                 `endsWith('example.com')` check.
 *
 * Preflight is answered with 204 and a zero content-length — Safari and the
 * fetch spec both need that, and a 200 with a body is a classic source of
 * "works in Chrome, hangs in Safari" bugs.
 */

import cors from '@fastify/cors';
import fp from 'fastify-plugin';

const METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_HEADERS = ['content-type'];

/**
 * Pure: turn `config.corsOrigin` into `@fastify/cors` options. Exported for
 * unit tests, which assert on this without booting a server.
 *
 * @param {string[]|string} corsOrigin
 */
export function buildCorsOptions(corsOrigin) {
  const list = Array.isArray(corsOrigin) ? corsOrigin : [corsOrigin];

  /** @type {{origin: true | ((origin: string) => boolean), credentials: false}} */
  let origin;

  if (list.includes('*')) {
    // `true` = reflect the caller's own Origin back, which beats a literal
    // `*` whenever the header is present and keeps one code path downstream.
    origin = true;
  } else {
    const allowed = new Set(list.filter((o) => typeof o === 'string' && o !== ''));
    /**
     * Called with the request's Origin header. `false` makes @fastify/cors skip
     * the CORS headers entirely and skip preflight — the browser-visible
     * "blocked" outcome, which is what we want for an unlisted origin.
     *
     * The second `cb` argument is not optional in practice: @fastify/cors
     * resolves a function origin through `(origin, cb) => cb(null, result)`.
     * A plain `value => boolean` returns a value the library never inspects and
     * never calls back, so the request HANGS FOREVER instead of being answered.
     * The return value is kept for direct callers (and unit tests); when `cb`
     * is supplied we call it and return undefined so the callback fires exactly
     * once.
     */
    origin = (value, cb) => {
      const ok = typeof value === 'string' && allowed.has(value);
      if (typeof cb === 'function') {
        cb(null, ok);
        return undefined;
      }
      return ok;
    };
  }

  return {
    origin,
    credentials: false,
    methods: METHODS,
    allowedHeaders: ALLOWED_HEADERS,
    optionsSuccessStatus: 204,
    preflightContinue: false,
    strictPreflight: false,
    hideOptionsRoute: false,
  };
}

async function corsPlugin(fastify, opts) {
  await fastify.register(cors, buildCorsOptions(opts.corsOrigin));
}

// `fastify-plugin` (fp) is REQUIRED here, not decorative. Registering
// @fastify/cors inside a normal plugin puts its onRequest hook in a child
// scope, so the hook applies to nothing outside it and every route silently
// ships without CORS headers — which is exactly the failure this wrapper
// exists to prevent. fp skips encapsulation so the hook is truly global.
export default fp(corsPlugin, { name: 'whiteboard-cors', fastify: '5.x' });
export { corsPlugin, METHODS, ALLOWED_HEADERS };
