/**
 * REST: op batches and the board-wide clear.
 *
 * The store is reached through the `fastify.store` decoration only. A batch is
 * validated here *and* by the store, but validating at the edge is what lets a
 * bad op come back as a 400 naming the exact `ops[i].field.path` instead of
 * surfacing as a 500.
 *
 * After a successful write the batch is fanned out to the board's websocket
 * room, if a hub is attached. `except` is null: this batch came over HTTP from
 * a client that may be a different peer than the socket one (or may have no
 * socket at all), so nobody in the room can be assumed to already have it.
 */

import { validateOps } from '@whiteboard/shared';

import { assertBoardId, sendError } from './boards.js';

const MAX_ID_LEN = 64;

/**
 * Validate a `:id` and, when bad, write the 400 envelope. Returns the id or
 * null; on null the reply has already been sent.
 */
function readId(request, reply) {
  const id = assertBoardId(request.params && request.params.id);
  if (id === null) {
    sendError(reply, 400, 'VALIDATION_FAILED', `id: expected a non-empty string of at most ${MAX_ID_LEN} chars`);
    return null;
  }
  return id;
}

/**
 * Fan out to the websocket room. Best-effort by design: a broadcast failure
 * must never fail a write that has already been persisted. The null `except`
 * means "everyone", since the HTTP caller is not necessarily a room member.
 */
function broadcast(fastify, boardId, envelope) {
  const hub = fastify.hub;
  if (!hub || typeof hub.broadcast !== 'function') return;
  try {
    hub.broadcast(boardId, envelope, null);
  } catch {
    // A dead room is not an error for the writer; the next GET/snapshot
    // resyncs anyone who missed the message.
  }
}

export default async function opsRoutes(fastify, opts) {
  fastify.post('/boards/:id/ops', async (request, reply) => {
    const id = readId(request, reply);
    if (id === null) return reply;

    const body = request.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'body: expected an object');
    }

    // validateOps throws an Invalid whose message already carries the path
    // (`ops[2].element.points[0].x: expected a finite number`), so the client
    // gets the offending index and field for free.
    let ops;
    try {
      ops = validateOps(body.ops);
    } catch (err) {
      return sendError(
        reply,
        400,
        'VALIDATION_FAILED',
        err && err.message ? err.message : 'ops: invalid batch',
        err && err.path ? { path: err.path } : undefined,
      );
    }

    if (ops.length === 0) {
      return sendError(reply, 400, 'VALIDATION_FAILED', 'ops: expected at least one op');
    }

    let actorId = body.actorId;
    if (actorId !== undefined && actorId !== null) {
      if (typeof actorId !== 'string' || actorId.length === 0 || actorId.length > MAX_ID_LEN) {
        return sendError(reply, 400, 'VALIDATION_FAILED', `actorId: expected a string of 1..${MAX_ID_LEN} chars`);
      }
    } else {
      actorId = undefined;
    }

    const store = fastify.store;

    // A throw here is a CONTRACT violation the store detected mid-batch, not
    // an infrastructure failure: a duplicate element id, `LIMITS.MAX_ELS`
    // exceeded, or an update whose merged result fails validateElement. The
    // store has already rolled the whole batch back, so this is the client's
    // bug to fix — 400, with the message naming the offending op index.
    let result;
    try {
      result = await store.applyOps(id, ops, actorId);
    } catch (err) {
      const isValidation =
        err && (err.name === 'InvalidElement' || typeof err.code === 'string');
      if (!isValidation) throw err;
      return sendError(reply, 400, 'VALIDATION_FAILED', err.message ?? 'ops: rejected by the store');
    }

    const status = result && result.status;
    const rev = Number.isFinite(result && result.rev) ? result.rev : 0;
    const appliedOps = Array.isArray(result && result.appliedOps) ? result.appliedOps : [];

    if (status === 'missing') {
      return sendError(reply, 404, 'NOT_FOUND', (result && result.message) || `board ${id} not found`);
    }

    if (status === 'conflict') {
      // The client must resync: GET the snapshot, rebase, replay. Sending the
      // current rev saves it a guess.
      return sendError(reply, 409, 'REV_CONFLICT', (result && result.message) || 'board moved; resync', { rev });
    }

    // `duplicate` is a successful no-op retry (the client did not get our ack
    // and resent the same opIds), not a failure — same 200 and same rev.
    if (status !== 'applied' && status !== 'duplicate') {
      return sendError(reply, 500, 'INTERNAL_ERROR', `unexpected applyOps status ${String(status)}`);
    }

    if (status === 'applied') {
      broadcast(fastify, id, { type: 'op', ops: appliedOps, rev });
    }

    const payload = { status, rev, appliedOps };
    if (Array.isArray(result && result.elements)) payload.elements = result.elements;
    return reply.send(payload);
  });

  fastify.delete('/boards/:id/elements', async (request, reply) => {
    const id = readId(request, reply);
    if (id === null) return reply;

    const store = fastify.store;

    // clearBoard returns the new rev, not existence, so confirm the board is
    // there first — otherwise a typo would 200 and lie about the clear.
    const existing = await store.getBoard(id);
    if (!existing) {
      return sendError(reply, 404, 'NOT_FOUND', `board ${id} not found`);
    }

    const rev = await store.clearBoard(id);
    const finalRev = Number.isFinite(rev) ? rev : (existing.rev ?? 0);

    broadcast(fastify, id, { type: 'op', ops: [], rev: finalRev });
    return reply.send({ status: 'applied', rev: finalRev, appliedOps: [] });
  });
}
