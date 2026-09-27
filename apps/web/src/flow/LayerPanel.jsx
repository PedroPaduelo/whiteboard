/**
 * `<LayerPanel />` — the z-order list.
 *
 * Rows are sorted top-of-stack-first (index 0 of `elements` is furthest back,
 * and a layer panel reads the way a design tool reads). Dragging a row
 * dispatches the store's documented `reorder(orderedIds)` with the exact new
 * id order.
 *
 * Rows expose three toggles:
 *   - visible/hidden  -> `opacity: 0`. NOT deleted, and NOT a `hidden` field:
 *     the server's validator strips unknown fields, so an element hidden by an
 *     invented flag would silently reappear for every other peer.
 *   - locked/unlocked -> `locked: true`. See the note in the row component; the
 *     field is real in the store and honoured here, but `validate.js` does not
 *     list it as patchable, so the server will drop it. Reported, not hidden.
 *   - delete          -> `removeElements([id])`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useBoardStore, useShallowSelector, useSelector } from './useStore.js';
import { GLYPH_KIND, isHidden, labelOf, nodeTypeFor, reorderIds, toLayerOrder } from './derive.js';
import { TypeGlyph } from './flowNodes.jsx';

/**
 * Windowing constants. The store caps a board at `LIMITS.MAX_ELS` (5000)
 * elements; a naive list of 5000 sortable rows mounts 5000 subscribers to
 * dnd-kit's measurement store and the panel becomes a multi-second freeze on
 * open. So: a fixed viewport height, a windowed slice, and a spacer that keeps
 * the scrollbar honest. No new dependency — `@tanstack/react-virtual` is not in
 * the pinned list and adding one is not mine to do.
 */
const ROW_HEIGHT = 34;
const VIEWPORT_HEIGHT = 420;
const OVERSCAN = 6;

function truncate(s, n = 28) {
  if (!s) return '';
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function LayerRow({ element, index, total, onToggleVisible, onToggleLocked, onDelete }) {
  const id = element.id;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  const hidden = isHidden(element);
  const locked = element.locked === true;
  // A boolean, not the Set: no shallow wrapper needed, and a row only re-renders
  // when its OWN selected flag flips.
  const selected = useSelector((s) => (s.selection ? s.selection.has(id) : false));

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    height: ROW_HEIGHT,
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    padding: '0 var(--sp-2)',
    borderRadius: 'var(--radius-sm)',
    background: isDragging
      ? 'var(--color-surface-hover)'
      : selected
        ? 'var(--color-accent-soft)'
        : 'transparent',
    boxSizing: 'border-box',
    // A hidden row stays in the list, dimmed. It is not gone, and hiding it
    // would make "where did my element go" unanswerable.
    opacity: hidden ? 0.45 : 1,
    color: 'var(--color-text)',
    fontSize: 'var(--fs-sm)',
    fontFamily: 'var(--font-sans)',
    userSelect: 'none',
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-layer-row={id}
      {...attributes}
    >
      <button
        type="button"
        // The handle is the ONLY part that starts a reorder drag. Row-wide
        // listeners would swallow clicks meant for the toggles.
        {...listeners}
        aria-label={`Reorder layer ${truncate(labelOf(element) || element.type, 24)}`}
        style={{
          width: 18,
          flex: '0 0 auto',
          border: 'none',
          background: 'transparent',
          color: 'var(--color-text-muted)',
          cursor: 'grab',
          padding: 0,
          fontSize: 12,
          lineHeight: 1,
        }}
      >
        ⠿
      </button>

      <TypeGlyph kind={GLYPH_KIND[nodeTypeFor(element)] ?? 'box'} title={element.type} />

      <span
        title={labelOf(element) || element.id}
        style={{
          flex: '1 1 auto',
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          cursor: 'default',
        }}
      >
        {truncate(labelOf(element)) || element.type}
      </span>

      <IconToggle
        active={!hidden}
        title={hidden ? 'Show layer' : 'Hide layer'}
        label={hidden ? 'Show' : 'Hide'}
        glyph={hidden ? '◌' : '◉'}
        onClick={() => onToggleVisible(id, element)}
      />
      <IconToggle
        active={locked}
        title={locked ? 'Unlock layer' : 'Lock layer'}
        label={locked ? 'Locked' : 'Unlocked'}
        glyph={locked ? '🔒' : '🔓'}
        onClick={() => onToggleLocked(id, element)}
      />
      <IconToggle
        active={false}
        danger
        title="Delete layer"
        label="Delete"
        glyph="✕"
        onClick={() => onDelete(id)}
      />
      <span
        aria-hidden="true"
        style={{
          fontSize: 'var(--fs-xs)',
          color: 'var(--color-text-muted)',
          minWidth: 28,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {total - index}
      </span>
    </div>
  );
}

function IconToggle({ active, danger, title, label, glyph, onClick }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      style={{
        width: 22,
        height: 22,
        flex: '0 0 auto',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-xs)',
        background: active ? 'var(--color-surface)' : 'var(--color-surface-sunken)',
        color: danger
          ? 'var(--color-danger)'
          : active
            ? 'var(--color-text)'
            : 'var(--color-text-muted)',
        fontSize: 11,
        lineHeight: 1,
        cursor: 'pointer',
        opacity: active ? 1 : 0.7,
        padding: 0,
      }}
    >
      <span aria-hidden="true">{glyph}</span>
      <span
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clipPath: 'inset(50%)',
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </button>
  );
}

export function LayerPanel({ className = '', style }) {
  const elements = useSelector((s) => s.elements);
  const commit = useBoardStore((s) => s.commit);
  const reorder = useBoardStore((s) => s.reorder);
  const updateElement = useBoardStore((s) => s.updateElement);
  const removeElements = useBoardStore((s) => s.removeElements);
  const select = useBoardStore((s) => s.select);

  const [scrollTop, setScrollTop] = useState(0);
  const scrollRef = useRef(null);

  /** Top-of-stack-first. `elements` order is the store's z-order. */
  const rows = useMemo(() => toLayerOrder(elements), [elements]);
  const orderedIds = useMemo(() => rows.map((el) => el.id), [rows]);

  // --- windowing ----------------------------------------------------------
  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);
  const windowed = rows.slice(start, end);
  const padTop = start * ROW_HEIGHT;
  const padBottom = Math.max(0, (rows.length - end) * ROW_HEIGHT);

  const sensors = useSensors(
    // A small activation distance so a click on a toggle is not read as the
    // start of a drag.
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /**
   * `active.id` and `over.id` are ids in OUR (reversed) display order, but
   * `reorder()` wants the store's own z-order. The result is reversed back, so
   * the store ends up with exactly the order the user sees.
   */
  const onDragEnd = useCallback(
    ({ active, over }) => {
      if (!over || active.id === over.id) return;
      const from = orderedIds.indexOf(active.id);
      const to = orderedIds.indexOf(over.id);
      if (from < 0 || to < 0) return;
      const displayOrder = reorderIds(orderedIds, from, to);
      commit('reorder');
      // Reversed back into the store's own z-order: `reorder()` takes the full
      // list, index 0 furthest back. We display top-of-stack first.
      reorder(displayOrder.slice().reverse());
    },
    [orderedIds, reorder, commit],
  );

  const onToggleVisible = useCallback(
    (id, element) => {
      const hidden = isHidden(element);
      // Hidden is `opacity: 0`, NOT a new field: `validate.js` strips unknown
      // fields, so a `hidden` flag would be silently dropped by the server and
      // the element would pop back for every other peer.
      commit(hidden ? 'show' : 'hide');
      updateElement(id, { opacity: hidden ? 1 : 0 });
    },
    [commit, updateElement],
  );

  const onToggleLocked = useCallback(
    (id, element) => {
      const locked = element.locked === true;
      commit(locked ? 'unlock' : 'lock');
      updateElement(id, { locked: !locked });
    },
    [commit, updateElement],
  );

  const onDelete = useCallback(
    (id) => {
      commit('delete layer');
      removeElements([id]);
    },
    [commit, removeElements],
  );

  // Scroll position is a ref-backed local: it changes on every wheel tick and
  // must not re-run any effect.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const onScroll = () => setScrollTop(el.scrollTop);
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  if (rows.length === 0) {
    return (
      <aside
        className={className}
        style={{
          width: 260,
          padding: 'var(--sp-3)',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--fs-sm)',
          fontFamily: 'var(--font-sans)',
          ...style,
        }}
      >
        No elements on this board.
      </aside>
    );
  }

  return (
    <aside
      className={className}
      data-layer-panel=""
      style={{
        width: 260,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
        fontFamily: 'var(--font-sans)',
        ...style,
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          color: 'var(--color-text-muted)',
          fontSize: 'var(--fs-xs)',
          lineHeight: 'var(--lh-xs)',
        }}
      >
        <span style={{ fontWeight: 'var(--fw-semibold)' }}>LAYERS</span>
        <span>{rows.length}</span>
      </header>

      {/* A single SortableContext over the windowed slice. dnd-kit resolves
          collisions against what is rendered, so a row dragged off the top of
          the viewport still lands correctly: the window follows `scrollTop`,
          and the drop target is whatever row is under the pointer. */}
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragEnd={onDragEnd}
        modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      >
        <SortableContext items={orderedIds} strategy={verticalListSortingStrategy}>
          <div
            ref={scrollRef}
            role="list"
            aria-label="Layers"
            style={{
              height: VIEWPORT_HEIGHT,
              overflowY: 'auto',
              overflowX: 'hidden',
              position: 'relative',
              paddingTop: padTop,
              paddingBottom: padBottom,
              boxSizing: 'content-box',
            }}
          >
            {windowed.map((el, i) => (
              <div role="listitem" key={el.id}>
                <LayerRow
                  element={el}
                  index={start + i}
                  total={rows.length}
                  onToggleVisible={onToggleVisible}
                  onToggleLocked={onToggleLocked}
                  onDelete={onDelete}
                />
              </div>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </aside>
  );
}

export default LayerPanel;
