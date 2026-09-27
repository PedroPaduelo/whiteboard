/**
 * Toolbar.jsx — the left vertical tool rail.
 *
 * Structure, top to bottom: one button per tool (in TOOLS order), a divider,
 * the style controls (stroke colour, fill, width, dash), the sticky-note
 * colour, the grid/snap pair, and undo/redo. Below 640px the scaffold's
 * toolbar.css turns the rail into a bottom dock; a "styles" disclosure lets
 * the style section collapse so the dock is not a wall of swatches.
 *
 * Two rules this file holds to:
 *   - No element mutation happens here. Only documented store actions are
 *     called, so the realtime outbox (which subscribes to those actions) is
 *     the only thing that ships anything to the server.
 *   - The keyboard hint badge on every tool button is read from
 *     `shortcuts.js`, never re-typed, so a hint cannot drift from its
 *     binding.
 */

import React, { useCallback, useMemo, useRef, useState } from 'react';
import {
  FILL_PRESETS,
  GRID,
  STROKE_PRESETS,
  TOOLS,
} from '@whiteboard/shared';
import { useStore, getStoreApi } from './store.js';
import { TOOL_ICONS, IconGrid, IconRedo, IconSnap, IconUndo } from './Icons.jsx';
import { TOOL_LABELS, formatKeys, hintForTool } from './shortcuts.js';

const MIN_WIDTH = 1;
const MAX_WIDTH = 24;

/** Colour swatches offered for sticky notes — same hues as FILL_PRESETS. */
const STICKY_COLORS = [
  '#fde68a',
  '#bbf7d0',
  '#bfdbfe',
  '#fbcfe8',
  '#e9d5ff',
  '#fed7aa',
];

function ToolButton({ tool, active, onSelect, index }) {
  const Icon = TOOL_ICONS[tool] ?? TOOL_ICONS.select;
  const label = TOOL_LABELS[tool] ?? tool;
  const hint = hintForTool(tool);
  return (
    <button
      type="button"
      className="tool-btn"
      aria-pressed={active}
      aria-label={label}
      title={hint ? `${label}  (${formatKeys([hint])})` : label}
      onClick={() => onSelect(tool)}
      data-tool-index={index}
      tabIndex={active ? 0 : -1}
    >
      <span className="tool-btn__icon">
        <Icon />
      </span>
      {hint ? <span className="tool-btn__key">{hint}</span> : null}
    </button>
  );
}

function SwatchGrid({ values, current, onPick, variant, ariaLabel }) {
  return (
    <div
      className="swatch-grid"
      role="radiogroup"
      aria-label={ariaLabel}
      style={
        variant === 'stroke'
          ? { gridTemplateColumns: 'repeat(2, 1fr)' }
          : undefined
      }
    >
      {values.map((v) => {
        const isNone = v === 'none';
        return (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={current === v}
            aria-label={isNone ? `${ariaLabel}: none` : `${ariaLabel}: ${v}`}
            title={isNone ? 'None' : v}
            className={[
              'swatch',
              variant === 'stroke' ? 'swatch--stroke' : '',
              isNone ? 'swatch--none' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={isNone || variant === 'stroke' ? undefined : { '--swatch': v }}
            onClick={() => onPick(v)}
          />
        );
      })}
    </div>
  );
}

export function Toolbar() {
  const tool = useStore((s) => s.tool ?? 'select');
  const style = useStore((s) => s.style ?? {});
  const gridSize = useStore((s) => s.gridSize ?? 0);
  const snapEnabled = useStore((s) => Boolean(s.snapEnabled));
  const canUndo = useStore((s) => Boolean(s.canUndo));
  const canRedo = useStore((s) => Boolean(s.canRedo));

  const [stylesOpen, setStylesOpen] = useState(false);
  const railRef = useRef(null);

  const store = useMemo(() => getStoreApi(), []);

  const setStyle = useCallback(
    (patch) => {
      store.setStyle(patch);
    },
    [store],
  );

  /* --- roving tabindex over the tool buttons -----------------------------
     `role="toolbar"` with arrow keys is the WAI-ARIA toolbar pattern: one
     tab stop for the whole rail, arrows move between tools. Without this a
     keyboard user tabs through twelve buttons before reaching anything else.
     ------------------------------------------------------------------- */
  const onRailKeyDown = useCallback(
    (event) => {
      const { key } = event;
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
      const rail = railRef.current;
      if (!rail) return;
      const buttons = [...rail.querySelectorAll('.tool-btn[data-tool-index]')];
      if (!buttons.length) return;
      const current = buttons.findIndex((b) => b === document.activeElement);
      const forward = key === 'ArrowDown' || key === 'ArrowRight';
      let next;
      if (key === 'Home') next = 0;
      else if (key === 'End') next = buttons.length - 1;
      else next = current < 0 ? 0 : (current + (forward ? 1 : -1) + buttons.length) % buttons.length;
      event.preventDefault();
      const target = buttons[next];
      target.focus();
      target.click();
    },
    [],
  );

  const strokeWidth = Number(style.strokeWidth ?? 2);
  const strokeStyle = style.strokeStyle ?? 'solid';
  const stickyFill = style.stickyFill ?? '#fde68a';

  const dashHints = useMemo(
    () => [
      { value: 'solid', label: 'Solid' },
      { value: 'dashed', label: 'Dashed' },
      { value: 'dotted', label: 'Dotted' },
    ],
    [],
  );

  return (
    <div
      ref={railRef}
      className="toolbar"
      role="toolbar"
      aria-label="Drawing tools and styles"
      aria-orientation="vertical"
      data-has-active="true"
      onKeyDown={onRailKeyDown}
    >
      {/* --- tools ------------------------------------------------------- */}
      <div className="toolbar__group">
        {TOOLS.map((t, i) => (
          <ToolButton
            key={t}
            tool={t}
            index={i}
            active={tool === t}
            onSelect={(next) => store.setTool(next)}
            onKeyDown={onRailKeyDown}
          />
        ))}
      </div>

      {/* --- styles ------------------------------------------------------ */}
      <div className="toolbar__group">
        <button
          type="button"
          className="tool-btn"
          aria-expanded={stylesOpen}
          aria-label="Toggle style controls"
          title="Styles"
          onClick={() => setStylesOpen((v) => !v)}
          style={{ display: stylesOpen ? 'none' : 'grid' }}
        >
          <span className="tool-btn__icon">
            <span
              style={{
                display: 'block',
                width: 20,
                height: 20,
                borderRadius: 4,
                background:
                  'conic-gradient(from 210deg, #ef4444, #eab308, #22c55e, #3b82f6, #a855f7, #ef4444)',
              }}
            />
          </span>
        </button>

        {stylesOpen ? (
          <>
            <span className="toolbar__label">Stroke</span>
            <SwatchGrid
              values={STROKE_PRESETS}
              current={style.stroke}
              onPick={(v) => setStyle({ stroke: v })}
              variant="stroke"
              ariaLabel="Stroke colour"
            />

            <span className="toolbar__label">Fill</span>
            <SwatchGrid
              values={FILL_PRESETS}
              current={style.fill}
              onPick={(v) => setStyle({ fill: v })}
              ariaLabel="Fill colour"
            />

            <span className="toolbar__label">
              <span className="size-slider__value">{strokeWidth}px</span>
            </span>
            <input
              className="size-slider"
              type="range"
              min={MIN_WIDTH}
              max={MAX_WIDTH}
              step={1}
              value={strokeWidth}
              aria-label="Stroke width in pixels"
              onChange={(e) => setStyle({ strokeWidth: Number(e.target.value) })}
            />

            <div className="segmented" role="radiogroup" aria-label="Line style">
              {dashHints.map((d) => (
                <button
                  key={d.value}
                  type="button"
                  role="radio"
                  aria-checked={strokeStyle === d.value}
                  className="segmented__item"
                  title={d.label}
                  onClick={() => setStyle({ strokeStyle: d.value })}
                >
                  <svg width="18" height="8" aria-hidden="true" focusable="false">
                    <line
                      x1="1"
                      y1="4"
                      x2="17"
                      y2="4"
                      stroke="currentColor"
                      strokeWidth="1.6"
                      strokeLinecap="round"
                      strokeDasharray={
                        d.value === 'dashed' ? '5 3' : d.value === 'dotted' ? '1 3' : undefined
                      }
                    />
                  </svg>
                </button>
              ))}
            </div>

            <span className="toolbar__label">Note</span>
            <SwatchGrid
              values={STICKY_COLORS}
              current={stickyFill}
              onPick={(v) => setStyle({ stickyFill: v })}
              ariaLabel="Sticky note colour"
            />
          </>
        ) : (
          <span className="toolbar__label">Style</span>
        )}
      </div>

      {/* --- grid + snap -------------------------------------------------- */}
      <div className="toolbar__group">
        <button
          type="button"
          className="tool-btn"
          aria-pressed={gridSize > 0}
          aria-label={gridSize > 0 ? 'Hide grid' : 'Show grid'}
          title={gridSize > 0 ? 'Hide grid  (G)' : 'Show grid  (G)'}
          onClick={() => store.setGridSize(gridSize > 0 ? 0 : GRID.defaultSize)}
        >
          <span className="tool-btn__icon">
            <IconGrid />
          </span>
          <span className="tool-btn__key">G</span>
        </button>

        <div
          className="segmented"
          role="radiogroup"
          aria-label="Grid size"
          style={{ width: 'auto' }}
        >
          {[0, 20, 40].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={gridSize === n}
              className="segmented__item"
              style={{ width: 18, fontSize: 'var(--fs-xs)' }}
              title={n === 0 ? 'No grid' : `${n}px grid`}
              onClick={() => store.setGridSize(n)}
            >
              {n === 0 ? '—' : n}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="tool-btn"
          aria-pressed={snapEnabled}
          aria-label="Toggle snapping to grid"
          title={`${snapEnabled ? 'Disable' : 'Enable'} snapping  (K)`}
          onClick={() => store.toggleSnap()}
        >
          <span className="tool-btn__icon">
            <IconSnap />
          </span>
          <span className="tool-btn__key">K</span>
        </button>
      </div>

      {/* --- history ------------------------------------------------------ */}
      <div className="toolbar__group">
        <div className="toolbar__history">
          <button
            type="button"
            className="tool-btn"
            disabled={!canUndo}
            aria-label="Undo"
            title="Undo  (Ctrl+Z)"
            onClick={() => store.undo()}
          >
            <span className="tool-btn__icon">
              <IconUndo />
            </span>
          </button>
          <button
            type="button"
            className="tool-btn"
            disabled={!canRedo}
            aria-label="Redo"
            title="Redo  (Ctrl+Shift+Z)"
            onClick={() => store.redo()}
          >
            <span className="tool-btn__icon">
              <IconRedo />
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

export default Toolbar;
