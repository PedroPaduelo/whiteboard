/**
 * errors.js — failed requests, told in Portuguese.
 *
 * An `ApiError`'s own message is for developers: the client's connection
 * text and the server's `board <id> not found` are English. The UI used to
 * show it as is (`toast.error(e?.message || fallback)`), so a network failure
 * or a board deleted elsewhere put English into a pt-BR interface. Callers
 * now pass their own "Não foi possível …" and get it back with a short
 * Portuguese reason when the status says something useful (ui/strings.js).
 *
 * Plain JS (no JSX) so node tests can import it.
 */

import { t } from './strings.js';

/**
 * The reason a request failed, as a lower-case Portuguese clause, or null
 * when the status says nothing a person can act on.
 *
 * @param {unknown} err an ApiError (`status` 0 = no connection) or any error
 * @param {{notFound?: string|null}} [opts] what a 404 means here (default:
 *   the board is gone; null for requests where it cannot mean that)
 * @returns {string|null}
 */
export function errorReason(err, { notFound = t.errors.reasons.boardGone } = {}) {
  if (!err || typeof err !== 'object') return null;
  const status = typeof err.status === 'number' ? err.status : null;
  // status 0 is the API client's "the request never reached the server"; a
  // bare TypeError is fetch's own "Failed to fetch".
  if (status === 0 || (status === null && err.name === 'TypeError')) return t.errors.reasons.network;
  if (status === 404) return notFound;
  if (status === 413) return t.errors.reasons.tooLarge;
  if (status === 429) return t.errors.reasons.rateLimited;
  if (status !== null && status >= 500) return t.errors.reasons.server;
  return null;
}

/** "Não foi possível …: <reason>." — or just `fallback` when there is no reason to add. */
export function errorMessage(err, fallback, opts) {
  const reason = errorReason(err, opts);
  return reason ? `${fallback}: ${reason}.` : fallback;
}

/** The reason as a sentence ("Sem conexão com o servidor."), or null. */
export function errorSentence(err, opts) {
  const reason = errorReason(err, opts);
  return reason ? `${reason.charAt(0).toUpperCase()}${reason.slice(1)}.` : null;
}
