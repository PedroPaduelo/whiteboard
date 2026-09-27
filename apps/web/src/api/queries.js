/**
 * TanStack Query hooks.
 *
 * Query keys are exactly `['boards']`, `['board', id]` and `['snapshot', id]`
 * — anything that invalidates the board must invalidate the same key, so
 * these are the only three places a key literal is written.
 *
 * `useApplyOps` is the interesting one. It is the HTTP fallback for ops the
 * WebSocket could not deliver, and the 409 path is the board's resync
 * mechanism. It deliberately does NOT throw into a component: a rev conflict
 * is an expected, recoverable outcome, and a rejected promise in a drag
 * handler produces an unhandled rejection and a red console instead of a
 * quiet resync. It returns a discriminated result the caller can branch on.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getActorId, newId } from './client.js';

/** Query keys, in one place so a typo cannot split the cache. */
export const keys = {
  boards: ['boards'],
  board: (id) => ['board', id],
  snapshot: (id) => ['snapshot', id],
};

/**
 * Every board, newest first as the server orders them.
 *
 * `data` is the ARRAY, not the transport envelope. The server replies
 * `{boards, total}` because the list is paginated, but every consumer wants a
 * list to render — and a hook that leaks its envelope makes each caller
 * remember to unwrap it, which is exactly how `(boards ?? []).slice` ends up
 * calling `.slice` on an object and crashing the board list.
 *
 * `total` rides along on the hook as `boardTotal` for callers that paginate.
 * The unwrap is defensive on purpose: it accepts a bare array too, so the hook
 * does not care which server it is talking to.
 */
export function useBoards({ enabled = true, search } = {}) {
  const query = search
    ? `/boards?search=${encodeURIComponent(search)}`
    : '/boards';
  const result = useQuery({
    queryKey: search ? ['boards', search] : keys.boards,
    queryFn: () => api.get(query),
    enabled,
    staleTime: 5000,
  });

  const raw = result.data;
  const data = Array.isArray(raw) ? raw : Array.isArray(raw?.boards) ? raw.boards : [];
  const total = typeof raw?.total === 'number' ? raw.total : data.length;

  return { ...result, data, boards: data, total };
}

/**
 * One board's full payload: metadata plus elements. Mounted by the board
 * page so the canvas has something to draw on first paint, before the
 * socket's `ready` lands.
 */
export function useBoard(id, { enabled = true } = {}) {
  return useQuery({
    queryKey: keys.board(id),
    queryFn: () => api.get(`/boards/${id}`),
    enabled: Boolean(id) && enabled,
    staleTime: 5000,
  });
}

/**
 * The snapshot endpoint, kept separate from `useBoard` because the resync
 * path invalidates ONLY this key. Invalidating `board` too would refetch
 * metadata nobody needs and make the status bar flicker on every conflict.
 */
export function useBoardSnapshot(id, { enabled = true } = {}) {
  return useQuery({
    queryKey: keys.snapshot(id),
    queryFn: () => api.get(`/boards/${id}/snapshot`),
    enabled: Boolean(id) && enabled,
    staleTime: 5000,
  });
}

/** Create a board. The response is a full snapshot, so `board` is refetched. */
export function useCreateBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input = {}) =>
      api.post('/boards', {
        title: input.title ?? 'Untitled board',
        theme: input.theme ?? 'light',
        id: input.id ?? newId(),
        ownerId: input.ownerId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: keys.boards });
    },
  });
}

/** Rename / re-theme a board. */
export function useUpdateBoard(id) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch) => api.patch(`/boards/${id}`, patch),
    onSuccess: (board) => {
      // Patch the cached copy in place so the title updates without a refetch,
      // then invalidate the board lists in the background.
      qc.setQueryData(keys.board(id), (old) => (old ? { ...old, board: { ...old.board, ...board } } : old));
      qc.invalidateQueries({ queryKey: keys.board(id) });
      qc.invalidateQueries({ queryKey: keys.boards });
    },
  });
}

/** Delete a board and everything on it. */
export function useDeleteBoard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.del(`/boards/${id}`),
    onSuccess: (_data, id) => {
      qc.removeQueries({ queryKey: keys.board(id) });
      qc.removeQueries({ queryKey: keys.snapshot(id) });
      qc.invalidateQueries({ queryKey: keys.boards });
    },
  });
}

/**
 * Apply a batch of ops over HTTP.
 *
 * TanStack v5's `mutate`/`mutateAsync` reject on error, so a bare
 * `mutateAsync` here would put a rejected promise in the caller's hands for
 * an outcome that is entirely routine. `mutateAsync` is wrapped so it always
 * RESOLVES with:
 *
 *   `{ ok: true,  status, rev, applied }`  the batch landed
 *   `{ ok: false, code: 'REV_CONFLICT', ... }`  the board moved; resynced
 *   `{ ok: false, code: 'NETWORK', ... }`  never reached the server
 *   `{ ok: false, code: 'HTTP', ... }`  anything else the server rejected
 *
 * A 409 invalidates `['snapshot', id]`, which is the resync path: the
 * snapshot refetch replaces the whole board and the client continues from
 * truth rather than replaying ops against a board that moved.
 */
export function useApplyOps(id) {
  const qc = useQueryClient();

  const mutation = useMutation({
    mutationFn: async ({ ops, actorId, signal } = {}) => {
      const payload = {
        ops: Array.isArray(ops) ? ops : [],
        actorId: actorId ?? (id ? getActorId(id) : undefined),
      };

      try {
        const result = await api.post(`/boards/${id}/ops`, payload, { signal });
        return { ok: true, status: result?.status ?? 'applied', rev: result?.rev ?? null, result };
      } catch (err) {
        // --- 409: the board moved underneath us. Resync, do not replay.
        if (err instanceof ApiError && (err.status === 409 || err.code === 'REV_CONFLICT')) {
          if (id) qc.invalidateQueries({ queryKey: keys.snapshot(id) });
          return {
            ok: false,
            code: 'REV_CONFLICT',
            status: 'conflict',
            rev: err.body?.rev ?? null,
            error: err.message,
            resynced: true,
          };
        }

        // --- Connection-level failure: the ops are still in the outbox.
        if (err instanceof ApiError && err.status === 0) {
          return { ok: false, code: 'NETWORK', error: err.message };
        }

        return {
          ok: false,
          code: err instanceof ApiError ? (err.code ?? `HTTP_${err.status}`) : 'UNKNOWN',
          status: err instanceof ApiError ? err.status : null,
          error: err.message ?? String(err),
        };
      }
    },
  });

  return {
    ...mutation,
    /** Never rejects. Resolves with the discriminated result above. */
    applyOps: (input) => mutation.mutateAsync(input),
  };
}
