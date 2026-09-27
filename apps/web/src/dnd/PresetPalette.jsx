/**
 * `<PresetPalette />` — the draggable preset palette.
 *
 * Two rules, one of which is a real requirement rather than polish:
 *
 *  - Every item is a `useDraggable` with `data: { preset }`, so a drag can
 *    hand the whole preset to the canvas droppable.
 *  - Every item is ALSO clickable, and keyboard-activatable, to place the
 *    preset at the centre of the viewport. A palette that can only be used by
 *    dragging is unusable without a mouse, which makes the whole preset
 *    feature unreachable for keyboard and switch users.
 *
 * Group order is fixed and matches the store's `PRESETS[].group` values. The
 * search filter matches label, group and `keywords`, so "database" finds
 * "DB" and "cylinder" finds "database".
 */

import { useCallback, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { PRESET_GROUPS, PRESETS, searchPresets } from '../store/presets.js';
import { useDndContext } from './DndProvider.jsx';
import { useDropOnCanvas } from './useDropOnCanvas.js';

/**
 * Flavour text per group. The store's own `PRESET_GROUPS` is the authority for
 * WHICH groups exist and in what order — it is derived from `PRESETS` in
 * first-appearance order — so a group added later shows up without touching
 * this file. An unknown group simply gets no hint.
 */
const GROUP_HINT = {
  Basics: 'Draw once',
  Shapes: 'Draw once',
  Connectors: 'Join things up',
  Notes: 'Capture a thought',
  People: 'Show who does what',
  Structure: 'Organise the board',
};

function matches(preset, q) {
  if (!q) return true;
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (preset.label?.toLowerCase().includes(needle)) return true;
  if (preset.group?.toLowerCase().includes(needle)) return true;
  const kw = Array.isArray(preset.keywords) ? preset.keywords : [];
  return kw.some((k) => String(k).toLowerCase().includes(needle));
}

/**
 * Group the preset list for display, in the store's own group order, dropping
 * any group the search emptied out.
 *
 * `searchPresets` from the store does the matching (label + group + keywords),
 * so search behaviour lives with the presets instead of in two places. The
 * local `matches` is the same rule, and the fallback if that helper is absent.
 */
export function groupPresets(presets, query = '') {
  let filtered;
  if (typeof searchPresets === 'function') {
    try {
      // Filter the GIVEN list, so a caller passing a subset still works.
      const allowed = new Set(searchPresets(query).map((p) => p.id));
      filtered = presets.filter((p) => allowed.has(p.id));
    } catch {
      filtered = presets.filter((p) => matches(p, query));
    }
  } else {
    filtered = presets.filter((p) => matches(p, query));
  }

  const byGroup = new Map();
  for (const p of filtered) {
    const g = p.group || 'Basics';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(p);
  }
  // `PRESET_GROUPS` order first, then anything the store does not list.
  const known = (Array.isArray(PRESET_GROUPS) ? PRESET_GROUPS : []).filter((g) => byGroup.has(g));
  const extra = [...byGroup.keys()].filter((g) => !known.includes(g));
  return [...known, ...extra].map((name) => ({
    name,
    hint: GROUP_HINT[name] ?? '',
    items: byGroup.get(name),
  }));
}

function PaletteItem({ preset, onPlace, selected, onSelect }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `preset:${preset.id}`,
    data: { preset },
  });

  const style = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--sp-2)',
    width: '100%',
    padding: 'var(--sp-2)',
    borderRadius: 'var(--radius-sm)',
    border: `1px solid ${selected ? 'var(--color-accent)' : 'var(--color-border)'}`,
    background: selected ? 'var(--color-accent-soft)' : 'var(--color-surface)',
    color: 'var(--color-text)',
    fontSize: 'var(--fs-sm)',
    fontFamily: 'var(--font-sans)',
    textAlign: 'left',
    cursor: isDragging ? 'grabbing' : 'grab',
    opacity: isDragging ? 0.4 : 1,
    touchAction: 'none',
    // The palette must be fully interactive; it is a panel above the canvas,
    // not part of the pointer-transparent flow layer.
    pointerEvents: 'auto',
  };

  return (
    <div ref={setNodeRef} style={{ position: 'relative' }}>
      <button
        type="button"
        {...attributes}
        {...listeners}
        // Click-to-place. Also the keyboard path: Enter/Space fires click on a
        // button, so this one handler covers mouse, touch and keyboard.
        onClick={() => onPlace(preset)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            onPlace(preset);
          }
        }}
        aria-label={`Add ${preset.label}. Drag onto the canvas, or press Enter to place it at the centre.`}
        style={style}
      >
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
            borderRadius: 'var(--radius-xs)',
            background: 'var(--color-surface-sunken)',
            color: 'var(--color-text-muted)',
            fontSize: 13,
          }}
        >
          {preset.icon ?? '▭'}
        </span>
        <span
          style={{
            flex: '1 1 auto',
            minWidth: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {preset.label}
        </span>
      </button>
    </div>
  );
}

export function PresetPalette({ className = '', style, onPlaced }) {
  const [query, setQuery] = useState('');
  const { activePreset, setActivePreset } = useDndContext();
  // The palette owns the drop handler so a click-to-place goes through exactly
  // the same conversion as a real drop: screen -> board, then `build`.
  const { onDropAtCentre } = useDropOnCanvas();

  const presets = useMemo(
    () => (Array.isArray(PRESETS) ? PRESETS : []),
    [],
  );
  const groups = useMemo(() => groupPresets(presets, query), [presets, query]);

  const onPlace = useCallback(
    (preset) => {
      const elements = onDropAtCentre(preset);
      if (elements) onPlaced?.(elements, preset);
      setActivePreset(null);
    },
    [onDropAtCentre, onPlaced, setActivePreset],
  );

  return (
    <aside
      className={className}
      data-preset-palette=""
      aria-label="Element presets"
      style={{
        width: 232,
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--sp-2)',
        fontFamily: 'var(--font-sans)',
        pointerEvents: 'auto',
        ...style,
      }}
    >
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search presets"
        aria-label="Search presets"
        style={{
          width: '100%',
          boxSizing: 'border-box',
          padding: 'var(--sp-2)',
          borderRadius: 'var(--radius-sm)',
          border: '1px solid var(--color-border)',
          background: 'var(--color-surface)',
          color: 'var(--color-text)',
          fontSize: 'var(--fs-sm)',
          fontFamily: 'var(--font-sans)',
        }}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--sp-3)',
          overflowY: 'auto',
          // A short list: a keyboard user arrowing down it does not want to
          // scroll the page out from under them.
          maxHeight: 'min(52vh, 460px)',
        }}
      >
        {groups.length === 0 ? (
          <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)', margin: 0 }}>
            No preset matches “{query}”.
          </p>
        ) : (
          groups.map((group) => (
            <section key={group.name} aria-label={group.name}>
              <h3
                style={{
                  margin: '0 0 var(--sp-1)',
                  fontSize: 'var(--fs-xs)',
                  lineHeight: 'var(--lh-xs)',
                  fontWeight: 'var(--fw-semibold)',
                  color: 'var(--color-text-muted)',
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                }}
              >
                {group.name}
                {group.hint ? (
                  <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 400 }}>
                    {' '}
                    · {group.hint}
                  </span>
                ) : null}
              </h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-1)' }}>
                {group.items.map((preset) => (
                  <PaletteItem
                    key={preset.id}
                    preset={preset}
                    onPlace={onPlace}
                    selected={activePreset?.id === preset.id}
                    onSelect={setActivePreset}
                  />
                ))}
              </div>
            </section>
          ))
        )}
      </div>

      <p
        style={{
          margin: 0,
          color: 'var(--color-text-muted)',
          fontSize: 'var(--fs-xs)',
          lineHeight: 'var(--lh-xs)',
        }}
      >
        Drag onto the canvas, or press <kbd>Enter</kbd> to place at the centre.
      </p>
    </aside>
  );
}

export default PresetPalette;
