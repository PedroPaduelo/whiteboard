/**
 * One error shape for the whole API.
 *
 * Every failure the client can see comes back as:
 *
 *   { statusCode, code, error, message }
 *
 * `code` is the branchable field — a client matches on `VALIDATION_FAILED` or
 * `BOARD_NOT_FOUND`, never on prose. `message` is for humans and a log grep.
 *
 * Two invariants worth stating out loud:
 *
 *  1. A stack trace NEVER reaches the response. It is a map of the server's
 *     filesystem and an invitation to probe it; it goes to the logger instead.
 *  2. `@whiteboard/shared`'s `InvalidElement` message is passed through
 *     VERBATIM. That message is `ops[3].element.w: expected a finite number` —
 *     it already names the offending op index and field path, which is the
 *     single most useful thing a client developer can be told. Rewriting it
 *     into "validation error" would throw that away.
 */

import { STATUS_CODES } from 'node:http';

/** Default code per status, used when an error carries no usable `code`. */
const CODE_BY_STATUS = Object.freeze({
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'UNPROCESSABLE_ENTITY',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL',
  501: 'NOT_IMPLEMENTED',
  503: 'SERVICE_UNAVAILABLE',
});

/**
 * Fastify's own error codes, mapped to a response code + client-facing code.
 * Anything not listed falls through to the status-derived default, and
 * anything with no status at all becomes a 500 INTERNAL.
 *
 * The split that matters: framework misconfiguration (a bad schema, a
 * duplicate route) is a BUG and must be loud — 500, logged with the stack.
 * Bad input from the client is not — 400/404/413, logged at info without noise.
 */
const FASTIFY_ERROR_MAP = Object.freeze({
  FST_ERR_NOT_FOUND: { statusCode: 404, code: 'ROUTE_NOT_FOUND' },
  FST_ERR_VALIDATION: { statusCode: 400, code: 'VALIDATION_FAILED' },
  FST_ERR_CTP_INVALID_JSON_BODY: { statusCode: 400, code: 'INVALID_JSON' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { statusCode: 400, code: 'INVALID_JSON' },
  FST_ERR_CTP_BODY_TOO_LARGE: { statusCode: 413, code: 'PAYLOAD_TOO_LARGE' },
  FST_ERR_CTP_EMPTY_TYPE: { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE' },
  FST_ERR_CTP_INVALID_CONTENT_LENGTH: { statusCode: 400, code: 'INVALID_CONTENT_LENGTH' },
  FST_ERR_BAD_URL: { statusCode: 400, code: 'INVALID_URL' },
  FST_ERR_BAD_STATUS_CODE: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_REP_ALREADY_SENT: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_SEND_INSIDE_ONERR: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_SEND_UNDEFINED_ERR: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_HANDLER_TIMEOUT: { statusCode: 503, code: 'HANDLER_TIMEOUT' },
  FST_ERR_HOOK_TIMEOUT: { statusCode: 503, code: 'HANDLER_TIMEOUT' },
  FST_ERR_ROUTE_HANDLER_TIMEOUT: { statusCode: 503, code: 'HANDLER_TIMEOUT' },
  FST_ERR_FAILED_ERROR_SERIALIZATION: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_SCH_SERIALIZATION_BUILD: { statusCode: 500, code: 'INTERNAL' },
  FST_ERR_SCH_VALIDATION_BUILD: { statusCode: 500, code: 'INTERNAL' },
});

/**
 * Body-parse failures surface from `@fastify/*` as generic Node errors with an
 * `ERR_` code. Only the ones a client can actually cause get a friendly
 * status; the rest stay 500 so a server bug is not disguised as bad input.
 */
const NODE_ERROR_MAP = Object.freeze({
  ERR_INVALID_JSON: { statusCode: 400, code: 'INVALID_JSON' },
  FST_ERR_DEC_ALREADY_PRESENT: { statusCode: 500, code: 'INTERNAL' },
});

const errorTitle = (statusCode) => STATUS_CODES[statusCode] ?? 'Internal Server Error';

function isPlainString(v) {
  return typeof v === 'string' && v !== '';
}

/**
 * Pull a usable `{statusCode, code}` out of a Fastify/Nodes/own error.
 * Order matters: an explicit `err.statusCode` from a route handler is the most
 * specific statement of intent and always wins.
 */
function classify(err) {
  // 1. `@whiteboard/shared` validation. Its message is the field path.
  if (err && err.name === 'InvalidElement') {
    return { statusCode: 400, code: 'VALIDATION_FAILED', message: err.message };
  }

  const hasOwnStatus = err && Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode < 600;
  const rawCode = err && isPlainString(err.code) ? err.code : null;
  const mapped = (rawCode && (FASTIFY_ERROR_MAP[rawCode] || NODE_ERROR_MAP[rawCode])) || null;

  if (hasOwnStatus) {
    return {
      statusCode: err.statusCode,
      // A handler that set its own code gets it verbatim; a FST_/ERR_ code
      // that did not make the table still becomes a stable, greppable name
      // rather than leaking the framework's internal string to clients.
      code: isPlainString(err.code) && !/^(FST_|ERR_)/.test(err.code)
        ? err.code
        : mapped?.code ?? CODE_BY_STATUS[err.statusCode] ?? 'INTERNAL',
      message: err.message,
    };
  }

  if (mapped) {
    return { statusCode: mapped.statusCode, code: mapped.code, message: err.message };
  }

  return { statusCode: 500, code: 'INTERNAL', message: err?.message };
}

/**
 * Fastify error handler. Registered by app.js, so it also catches errors
 * raised inside the websocket plugin's upgrade path and inside `onClose`.
 */
export function errorHandler(err, request, reply) {
  if (!err) {
    reply.status(500).send({ statusCode: 500, code: 'INTERNAL', error: 'Internal Server Error', message: 'unknown error' });
    return;
  }

  const { statusCode, code, message } = classify(err);
  const log = request.log ?? console;

  // 5xx is our fault and needs the stack; 4xx is the client's and does not.
  // Either way the stack stays in the log, never in the body.
  const logPayload = { err, reqId: request.id, code, url: request.url, method: request.method };
  if (statusCode >= 500) {
    log.error(logPayload, message ?? err.message ?? 'request failed');
  } else {
    log.info(logPayload, message ?? err.message ?? 'request rejected');
  }

  const body = {
    statusCode,
    code,
    error: errorTitle(statusCode),
    message: isPlainString(message) ? message : errorTitle(statusCode),
  };

  // `err` is set on the reply so `reply.send(err)` paths keep the original
  // stack for the logger without ever serialising it.
  reply.status(statusCode).send(body);
}

export default errorHandler;
export { CODE_BY_STATUS, FASTIFY_ERROR_MAP, errorTitle, classify };
