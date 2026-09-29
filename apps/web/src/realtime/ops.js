/**
 * Pure op-list utilities shared by the sync bridge and the realtime client.
 *
 * Kept in their own module (no imports) so `realtime.js` can compact its
 * outbox without importing `sync.js`, which itself imports the realtime
 * singleton — that cycle would hand `new StoreSync()` an uninitialised client.
 */

/**
 * Fold a batch of ops down to at most one pending `update` per element.
 *
 * A drag produces a real diff on every frame — 60 `update` ops for the same
 * element in 50ms — and sending those is exactly the "collaborative canvas
 * feels laggy" problem. Only `update`s merge, into the latest earlier
 * `update` of the same element that no `create`/`delete` of that element (and
 * no `clear`) has come after: merging across a delete + re-create (undo then
 * redo inside one window) would apply the newer patch to the older element.
 * Merged ops keep their FIRST opId.
 *
 * Nothing merges across a `create` either (of any element): a later patch may
 * bind a connector to the element just created, and folding it into an
 * update queued BEFORE that create would move the binding ahead of its
 * target — split into two batches there, the server drops it.
 *
 * Everything before the last `clear` is dead (the clear wipes it) and is
 * dropped — except ops in `frozen`, which have already been SENT once: the
 * server may hold them, so they are never merged into or dropped.
 *
 * @param {object[]} ops
 * @param {{frozen?: Set<string>}} [opts]
 * @returns {object[]} a new array, in first-seen order
 */
export function collapseOps(ops, { frozen } = {}) {
  const isFrozen = (op) => Boolean(frozen) && frozen.has(op.opId);
  const lastClear = ops.reduce((acc, op, i) => (op.kind === 'clear' ? i : acc), -1);
  const live = lastClear <= 0 ? ops : [...ops.slice(0, lastClear).filter(isFrozen), ...ops.slice(lastClear)];

  const out = [];
  const open = new Map(); // elementId -> the update entry later patches may merge into

  for (const op of live) {
    if (op.kind === 'update' && op.elementId) {
      const target = open.get(op.elementId);
      if (target && !isFrozen(op)) {
        target.patch = { ...target.patch, ...op.patch };
        continue;
      }
      if (isFrozen(op)) {
        out.push(op);
        open.delete(op.elementId);
        continue;
      }
      const entry = { ...op, patch: { ...op.patch } };
      open.set(op.elementId, entry);
      out.push(entry);
      continue;
    }
    if (op.kind === 'create') open.clear();
    else if (op.kind === 'delete' && op.elementId) open.delete(op.elementId);
    else if (op.kind === 'clear') open.clear();
    out.push(op);
  }

  return out;
}
