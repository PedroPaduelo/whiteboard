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

import { Fragment, useCallback, useMemo, useState } from 'react';
import { useDraggable } from '@dnd-kit/core';
import { PRESET_GROUPS, PRESETS, searchPresets } from '../store/presets.js';
import { useDndContext } from './DndProvider.jsx';
import { useDropOnCanvas } from './useDropOnCanvas.js';
import './palette.css';

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

  // Styling lives in palette.css. Inline styles cannot express hover, and
  // they are the reason this panel looked improvised.
  const style = { opacity: isDragging ? 0.4 : 1 };

  return (
    /* The dnd-kit ref goes on the BUTTON, not on a wrapper. A wrapper div
       would be the grid item, so the button inside it inherited a single
       52px column instead of filling its cell — which is what made the
       palette look like a narrow list no matter what the grid said. */
    <button
      ref={setNodeRef}
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
        className="wb-palette__tile"
        data-selected={selected ? '' : undefined}
        data-dragging={isDragging ? '' : undefined}
        style={style}
      >
        <span className="wb-palette__icon" aria-hidden="true">
          {/* `preset.icon` is an SVG PATH STRING ("M4 7V5h16v2M12 5v14..."),
              not a glyph. Rendering it as a text child prints the path
              source over the label, which is exactly what it did. It has to
              go inside a <path d={...}>, or the palette shows you its own
              source code. */}
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={preset.icon} />
          </svg>
        </span>
        <span className="wb-palette__label">
          {preset.label}
        </span>
    </button>
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
      className={`wb-palette ${className}`}
      data-preset-palette=""
      aria-label="Element presets"
      /* Layout comes from palette.css. The inline `width: 232` that used to
         be here overrode the stylesheet, which is why the panel stayed narrow
         no matter what the CSS said. Only caller-supplied style stays inline. */
      style={style}
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

      {/* ONE grid of tiles for every preset, with each group heading
          spanning the full width. The previous version nested a flex-column
          per group INSIDE a grid, so each group got one narrow column: the
          tiles came out 52px wide and the heading overlapped them. A Fragment
          keeps the heading and the tiles as direct grid items, which is the
          only way to get both "heading spans" and "tiles flow in two
          columns" out of one grid. */}
      <div className="wb-palette__grid">
        {groups.length === 0 ? (
          <p className="wb-palette__empty">No preset matches "{query}".</p>
        ) : (
          groups.map((group) => (
            <Fragment key={group.name}>
              <h3 className="wb-palette__group">
                {group.name}
                {group.hint ? <span className="wb-palette__group-hint"> · {group.hint}</span> : null}
              </h3>
              {group.items.map((preset) => (
                <PaletteItem
                  key={preset.id}
                  preset={preset}
                  onPlace={onPlace}
                  selected={activePreset?.id === preset.id}
                  onSelect={setActivePreset}
                />
              ))}
            </Fragment>
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
