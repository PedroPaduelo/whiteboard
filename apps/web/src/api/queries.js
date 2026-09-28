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

import { useSyncExternalStore } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, getActorId, newId } from './client.js';

/* ==========================================================================
   The nickname
   ==========================================================================

   This app has no accounts, so the nickname IS the identity: it decides which
   boards `GET /boards?owner=` returns and who a new board is created for. It
   lives in `localStorage` under one key, and this block is the ONLY place that
   knows how.

   Everything here is guarded because `localStorage` throws, not returns, in
   Safari private mode and in sandboxed iframes — a whiteboard that cannot boot
   because it could not store a name is not acceptable, and a thrown
   ReferenceError inside a module initialiser takes the whole app down rather
   than degrading. So a blocked storage falls back to an in-memory value and
   the app stays usable for the session; it simply forgets on reload.
   ========================================================================== */

export const NICKNAME_KEY = 'whiteboard:nickname';

/** Server-side ceiling on an owner id; the field refuses anything longer. */
export const NICKNAME_MAX = 64;

/** Last-resort holder for a session whose storage is blocked. */
let memoryNickname = '';

/** Listeners so a rename re-renders the gate, the header and the list at once. */
const nicknameListeners = new Set();

function emitNickname(value) {
  for (const fn of nicknameListeners) {
    try {
      fn();
    } catch {
      /* a bad subscriber must not stop the others */
    }
  }
}

/**
 * The current nickname, or `''` when there is none.
 *
 * The in-memory copy is checked FIRST and wins over a stored value: if an
 * earlier write was rejected, the only name this browser has is the one we
 * kept, and re-reading storage would resurrect a stale name from before the
 * block. Same reasoning as `getActorId` in client.js.
 */
export function readNickname() {
  if (memoryNickname) return memoryNickname;
  try {
    const hit = window.localStorage.getItem(NICKNAME_KEY);
    if (hit) {
      memoryNickname = hit;
      return hit;
    }
  } catch {
    /* storage unavailable (private mode, disabled cookies, sandboxed iframe) */
  }
  return '';
}

/**
 * Validate a raw nickname field value.
 *
 * Returns `{ok:true, value}` or `{ok:false, error}` rather than throwing or
 * silently returning `''`, because both failure modes are worse than a message
 * on screen: a silent no-op looks like a broken button, and the field would
 * just refuse to clear.
 *
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 */
export function validateNickname(raw) {
  const value = String(raw ?? '').trim();
  if (!value) {
    return { ok: false, error: 'Pick a name — the board list is filtered by it.' };
  }
  if (value.length > NICKNAME_MAX) {
    return {
      ok: false,
      error: `That name is ${value.length} characters. Keep it to ${NICKNAME_MAX} or fewer.`,
    };
  }
  return { ok: true, value };
}

/** Persist a nickname. Never throws; a blocked store still works this session. */
export function writeNickname(name) {
  const value = String(name ?? '').trim();
  memoryNickname = value;
  try {
    if (value) window.localStorage.setItem(NICKNAME_KEY, value);
    else window.localStorage.removeItem(NICKNAME_KEY);
  } catch {
    /* quota exceeded / private mode — the in-memory value above still holds */
  }
  emitNickname(value);
  return value;
}

/**
 * Subscribe to nickname changes.
 *
 * `getSnapshot` returns a string, so React's `useSyncExternalStore`
 * comparison is by value and a repeated write of the same name does not
 * re-render the list.
 */
function subscribeNickname(onChange) {
  nicknameListeners.add(onChange);
  return () => nicknameListeners.delete(onChange);
}

/**
 * The nickname as reactive state, for components that must re-render when it
 * changes. Reading `readNickname()` directly is right for module-level code
 * and for event handlers; this is right for rendering.
 */
export function useNickname() {
  return useSyncExternalStore(subscribeNickname, readNickname, () => '');
}

/* ==========================================================================
   Query keys
   ========================================================================== */

/** Query keys, in one place so a typo cannot split the cache. */
export const keys = {
  /**
   * The board list is keyed BY NICKNAME.
   *
   * This is the whole point. A single `['boards']` key means switching
   * nickname repaints the list from the previous nickname's cache — you see
   * someone else's boards until the refetch lands, and on a slow or failed
   * request you keep seeing them for good. Putting the owner in the key makes
   * each nickname's list a separate entry, so a switch is a different query,
   * not a stale re-read of the old one.
   *
   * `allBoards` is the shared PREFIX. TanStack invalidates by prefix with
   * `exact: false` by default, so `invalidateQueries({queryKey: keys.allBoards})`
   * reaches every nickname's entry at once — which is what a create or a
   * delete wants, since the board may be visible under any owner.
   */
  allBoards: ['boards'],
  boards: (owner, search) => (search ? ['boards', owner ?? '', search] : ['boards', owner ?? '']),
  board: (id) => ['board', id],
  snapshot: (id) => ['snapshot', id],
};

/**
 * Boards visible to `owner`: the ones they own plus the unclaimed ones.
 *
 * Defaults to the current nickname so a caller that says nothing is never
 * accidentally unscoped — passing no owner used to mean "every board on the
 * server", which is precisely the list that had to go away.
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
export function useBoards({ enabled = true, search, owner } = {}) {
  const nickname = useNickname();
  const scope = owner === undefined ? nickname : owner;

  // No nickname means no list: there is nothing to filter by, and asking for
  // an unscoped list is how fifteen identical boards came back in the first
  // place. The gate blocks this in the UI; this stops it if a caller forgets.
  const canQuery = enabled && Boolean(scope);

  const params = new URLSearchParams();
  if (scope) params.set('owner', scope);
  if (search) params.set('search', search);
  const query = `/boards?${params.toString()}`;

  const result = useQuery({
    queryKey: keys.boards(scope, search),
    queryFn: () => api.get(query),
    enabled: canQuery,
    staleTime: 5000,
  });

  const raw = result.data;
  const data = Array.isArray(raw) ? raw : Array.isArray(raw?.boards) ? raw.boards : [];
  const total = typeof raw?.total === 'number' ? raw.total : data.length;

  return { ...result, data, boards: data, total, owner: scope };
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

/**
 * Create a board, owned by `input.ownerId` — the current nickname by default.
 *
 * Without the default a caller that said nothing produced an OWNERLESS board,
 * which is the same as a board nobody can ever find again: it stays in
 * everyone's list as "unclaimed" until someone bothers to claim it, and its
 * creator does not even know they made it. Defaulting to the nickname is what
 * makes a new board show up under the person who made it.
 *
 * The hook UNWRAPS the response to the board. `POST /boards` replies with a
 * full snapshot — `{board, elements, rev}` — and every caller wants the board.
 * Returning the envelope made `onSuccess: (b) => onOpen(b.id)` navigate to
 * `undefined`: the board was really created, the POST really returned 201, and
 * the "New board" button silently did nothing, which reads as a broken button
 * rather than as a wrong destructuring. The unwrap accepts a bare board too,
 * so a server that returns one still works.
 */
export function useCreateBoard() {
  const qc = useQueryClient();
  const nickname = useNickname();
  return useMutation({
    mutationFn: async (input = {}) => {
      const created = await api.post('/boards', {
        title: input.title ?? 'Untitled board',
        theme: input.theme ?? 'light',
        id: input.id ?? newId(),
        ownerId: input.ownerId ?? nickname ?? undefined,
      });
      return created?.board ?? created;
    },
    onSuccess: () => {
      // Prefix invalidation: the new board may be visible under any owner.
      qc.invalidateQueries({ queryKey: keys.allBoards });
    },
  });
}

/**
 * Claim an unclaimed board for `nickname` (PATCH `ownerId`).
 *
 * Separate from `useUpdateBoard` on purpose. Rename is a field this app
 * offers on your OWN board; claiming is the one mutation that reassigns
 * ownership, and a row must not offer it for a board someone else owns. Keeping
 * them apart makes "which mutations can change ownership" answerable by reading
 * one function instead of auditing every `patch` call site.
 */
export function useClaimBoard() {
  const qc = useQueryClient();
  const nickname = useNickname();
  return useMutation({
    mutationFn: ({ id, owner } = {}) => {
      const target = owner ?? nickname;
      if (!id) throw new ApiError('Cannot claim a board without an id', { status: 0, path: `/boards/${id}` });
      if (!target) throw new ApiError('Cannot claim a board without a nickname', { status: 0, path: `/boards/${id}` });
      return api.patch(`/boards/${id}`, { ownerId: target });
    },
    onSuccess: (_board, vars) => {
      const id = vars?.id;
      // The claimed board leaves the "unclaimed" bucket and joins this
      // nickname's, so BOTH lists are stale: the one it came out of and the
      // one it went into. Invalidating only the prefix the viewer is looking at
      // leaves the other nickname's list showing a board that is no longer
      // theirs.
      qc.invalidateQueries({ queryKey: keys.allBoards });
      if (id) {
        qc.invalidateQueries({ queryKey: keys.board(id) });
      }
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
      qc.invalidateQueries({ queryKey: keys.allBoards });
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
      qc.invalidateQueries({ queryKey: keys.allBoards });
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
