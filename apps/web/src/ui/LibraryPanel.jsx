/**
 * LibraryPanel.jsx — the shape library sidebar (Excalidraw's Library).
 *
 * Items come from store/presets.js and are previewed with the real SVG
 * exporter (same roughjs shapes as the board, in the current style). Two
 * ways to place one, both a single undo step that selects the result:
 *   - click (or Enter): at the centre of the viewport;
 *   - drag with a mouse/pen: native pointer events, a ghost follows the
 *     pointer and the release point on the board is the drop point. No
 *     dnd library — dropping anywhere that is not the canvas cancels.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PRESETS, PRESET_GROUPS, buildPreset, searchPresets } from '../store/presets.js';
import { exportToSvg } from '../editor/export/export.js';
import { actions, screenToBoardPoint, viewportCenter } from '../editor/actions.js';
import { DRAG_THRESHOLD, DEFAULT_STYLE } from '../editor/constants.js';
import { useBoardStore, useStyle } from '../store/index.js';
import { useUi } from './uiStore.js';
import { IconButton, Island } from './common.jsx';
import { IconClose, IconSearch } from './Icons.jsx';
import { t } from './strings.js';

/** No embedded fonts: an inline SVG uses the document's loaded faces. */
const NO_FONTS = { Virgil: '', 'Cascadia Code': '' };

function previewSvg(preset, style) {
  try {
    const els = buildPreset(preset, { x: 0, y: 0 }, style);
    return exportToSvg(els, { background: false, padding: 6, fonts: NO_FONTS });
  } catch (err) {
    console.warn('[library] preview failed', preset.id, err);
    return '';
  }
}

/** Is the client point over the drawing surface (not over a UI island)? */
function canvasUnder(clientX, clientY) {
  const el = document.elementFromPoint(clientX, clientY);
  if (!el) return null;
  const canvas = el.closest('[data-testid="canvas"]');
  return canvas;
}

function place(preset, at) {
  const els = buildPreset(preset, at, useBoardStore.getState().style);
  actions.insertElements(els, `library-${preset.id}`);
}

function LibraryItem({ preset, svg }) {
  const drag = useRef(null);
  const suppressClick = useRef(false);
  const [ghost, setGhost] = useState(null);

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    suppressClick.current = false;
    drag.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId, dragging: false, touch: e.pointerType === 'touch' };
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d || d.touch || d.pointerId !== e.pointerId) return;
    if (!d.dragging && Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_THRESHOLD * 2) {
      d.dragging = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* pointer gone */
      }
    }
    if (d.dragging) setGhost({ x: e.clientX, y: e.clientY });
  };
  const finish = (e, cancelled) => {
    const d = drag.current;
    drag.current = null;
    setGhost(null);
    if (!d || !d.dragging) return; // a plain click is handled by onClick
    // The release of a drag also produces a click on this button: swallow it.
    suppressClick.current = true;
    if (cancelled) return;
    const canvas = canvasUnder(e.clientX, e.clientY);
    if (!canvas) return; // dropped on the UI: cancel
    const r = canvas.getBoundingClientRect();
    place(preset, screenToBoardPoint({ x: e.clientX - r.left, y: e.clientY - r.top }));
  };

  return (
    <>
      <button
        type="button"
        className="lib-item"
        title={`${preset.label} — ${t.library.hint}`}
        aria-label={preset.label}
        data-preset={preset.id}
        onMouseDown={(e) => e.preventDefault() /* keep focus on the board: arrows then nudge what was placed */}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)}
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          place(preset, viewportCenter());
        }}
      >
        <span className="lib-item__preview" aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
        <span className="lib-item__label">{preset.label}</span>
      </button>
      {ghost ? (
        <div className="lib-ghost" style={{ left: ghost.x, top: ghost.y }} aria-hidden="true" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : null}
    </>
  );
}

export function LibraryPanel() {
  const open = useUi((s) => s.libraryOpen);
  const style = useStyle();
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  // Previews in the current style; rebuilt only when the style changes.
  const previews = useMemo(() => {
    if (!open) return null;
    const st = { ...DEFAULT_STYLE, ...style };
    return new Map(PRESETS.map((p) => [p.id, previewSvg(p, st)]));
  }, [open, style]);

  // Focus the search on desktop; on a phone that would pop the keyboard up.
  useEffect(() => {
    if (open && globalThis.matchMedia?.('(pointer: fine)').matches) searchRef.current?.focus({ preventScroll: true });
  }, [open]);

  const close = useCallback(() => useUi.getState().close('libraryOpen'), []);

  if (!open) return null;
  const found = searchPresets(query);
  const groups = PRESET_GROUPS.map((g) => ({ g, items: found.filter((p) => p.group === g) })).filter((x) => x.items.length);

  return (
    <Island as="aside" className="library-panel" aria-label={t.library.title} data-testid="library-panel">
      <header className="library-panel__head">
        <h2 className="library-panel__title">{t.library.title}</h2>
        <IconButton label={t.library.close} onClick={close}>
          <IconClose size={18} />
        </IconButton>
      </header>
      <label className="search-field">
        <IconSearch size={16} />
        <input
          ref={searchRef}
          type="search"
          value={query}
          placeholder={t.library.search}
          aria-label={t.library.search}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              if (query) setQuery('');
              else close();
            }
          }}
        />
      </label>
      <p className="library-panel__hint">{t.library.hint}</p>
      <div className="library-panel__body">
        {groups.length === 0 ? <p className="library-panel__empty">{t.library.empty}</p> : null}
        {groups.map(({ g, items }) => (
          <section key={g} className="lib-group">
            <h3 className="lib-group__title">{t.library.groups[g] ?? g}</h3>
            <div className="lib-grid">
              {items.map((p) => (
                <LibraryItem key={p.id} preset={p} svg={previews?.get(p.id) ?? ''} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </Island>
  );
}

export default LibraryPanel;
