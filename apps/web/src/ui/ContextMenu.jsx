/**
 * ContextMenu.jsx — right-click menu on the board (opened by the Canvas'
 * `onContextMenu`, which has already selected what was under the pointer).
 *
 * On a selection: clipboard, duplicate/delete, layer order, group, lock.
 * On empty canvas: paste (at the click point), select all, zoom to fit, grid.
 * Every item is an editor action; the menu closes after it runs.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { actions, groupAvailability } from '../editor/actions.js';
import { useBoardStore, useSnapEnabled } from '../store/index.js';
import { useUi } from './uiStore.js';
import { Island, focusFirstMenuItem, menuKeyNav, useOutsideClose } from './common.jsx';
import { shortcutHint } from './shortcuts.js';
import { t } from './strings.js';

const MARGIN = 8;

function Item({ label, hint, onSelect, danger, disabled }) {
  return (
    <button
      type="button"
      role="menuitem"
      className={`menu-item menu-item--compact ${danger ? 'menu-item--danger' : ''}`}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="menu-item__label">{label}</span>
      {hint ? <span className="menu-item__hint">{hint}</span> : null}
    </button>
  );
}

const Sep = () => <div className="menu-sep" role="separator" />;

const CLOSED_SUMMARY = { count: 0, allLocked: false, canGroup: false, canUngroup: false, empty: true };

export function ContextMenu() {
  const menu = useUi((s) => s.contextMenu);
  // Only computed while the menu is open (the group structure is a walk
  // over the whole board).
  const summary = useBoardStore(
    useShallow((s) => {
      if (!menu) return CLOSED_SUMMARY;
      let locked = 0;
      let count = 0;
      if (s.selection.size) {
        for (const el of s.elements) {
          if (!s.selection.has(el.id)) continue;
          count += 1;
          if (el.locked) locked += 1;
        }
      }
      const { canGroup, canUngroup } = groupAvailability(s);
      return { count, allLocked: count > 0 && locked === count, canGroup, canUngroup, empty: s.elements.length === 0 };
    }),
  );
  const grid = useSnapEnabled();
  const ref = useRef(null);
  const [pos, setPos] = useState(null);
  const close = () => useUi.getState().closeContextMenu();
  useOutsideClose(ref, Boolean(menu), close);

  // Keep the menu inside the window (flip left/up near the edges).
  useLayoutEffect(() => {
    if (!menu || !ref.current) {
      setPos(null);
      return;
    }
    const r = ref.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let x = menu.x;
    let y = menu.y;
    if (x + r.width + MARGIN > vw) x = Math.max(MARGIN, x - r.width);
    if (y + r.height + MARGIN > vh) y = Math.max(MARGIN, vh - r.height - MARGIN);
    setPos({ x, y });
  }, [menu]);

  // Focus the first item once the menu is placed and VISIBLE. Doing it in the
  // effect above ran while the menu was still `visibility: hidden`, the
  // browser ignored it, focus stayed on the page, and arrow keys nudged the
  // selection under the open menu instead of moving through it.
  useEffect(() => {
    if (menu && pos) focusFirstMenuItem(ref.current);
  }, [menu, pos]);

  if (!menu) return null;
  const run = (fn) => () => {
    close();
    fn();
  };
  const has = summary.count > 0;
  const at = menu.at ?? null;
  // Where the browser will not let the page read the clipboard, the paste
  // toast points at the keyboard — when there is one (not on a phone).
  const pasteKeys = globalThis.matchMedia?.('(pointer: fine)').matches ? shortcutHint('edit.paste') : '';
  const paste = run(() => void actions.paste(null, at, { keyHint: pasteKeys }));

  return (
    <Island
      ref={ref}
      className="menu-panel context-menu"
      role="menu"
      aria-label={t.contextMenu.label}
      data-testid="context-menu"
      style={{ left: (pos ?? menu).x, top: (pos ?? menu).y, visibility: pos ? 'visible' : 'hidden' }}
      onKeyDown={menuKeyNav}
      onContextMenu={(e) => e.preventDefault()}
    >
        {has ? (
          <>
            <Item label={t.actions.copy} hint={shortcutHint('edit.copy')} onSelect={run(() => void actions.copy())} />
            {/* Locked elements are never removed, so cutting or deleting a
                selection that is all locked would do nothing: disabled. */}
            <Item
              label={t.actions.cut}
              hint={shortcutHint('edit.cut')}
              disabled={summary.allLocked}
              onSelect={run(() => void actions.cut())}
            />
            <Item label={t.actions.paste} hint={shortcutHint('edit.paste')} onSelect={paste} />
            <Sep />
            <Item label={t.actions.duplicate} hint={shortcutHint('edit.duplicate')} onSelect={run(() => actions.duplicateSelection())} />
            <Item label={t.actions.delete} hint="Delete" danger disabled={summary.allLocked} onSelect={run(() => actions.deleteSelection())} />
            <Sep />
            <Item label={t.actions.bringForward} hint={shortcutHint('edit.forward')} onSelect={run(() => actions.bringForward())} />
            <Item label={t.actions.sendBackward} hint={shortcutHint('edit.backward')} onSelect={run(() => actions.sendBackward())} />
            <Sep />
            {summary.canGroup ? <Item label={t.actions.group} hint={shortcutHint('edit.group')} onSelect={run(() => actions.group())} /> : null}
            {summary.canUngroup ? <Item label={t.actions.ungroup} hint={shortcutHint('edit.ungroup')} onSelect={run(() => actions.ungroup())} /> : null}
            <Item
              label={summary.allLocked ? t.actions.unlock : t.actions.lock}
              hint={shortcutHint('edit.lock')}
              onSelect={run(() => actions.toggleLock())}
            />
            <Sep />
            <Item label={t.actions.selectAll} hint={shortcutHint('edit.selectAll')} onSelect={run(() => actions.selectAll())} />
            <Item label={t.actions.zoomToFit} hint={shortcutHint('view.zoomFit')} onSelect={run(() => actions.zoomToFit())} />
          </>
        ) : (
          <>
            <Item label={t.actions.paste} hint={shortcutHint('edit.paste')} onSelect={paste} />
            <Sep />
            <Item label={t.actions.selectAll} hint={shortcutHint('edit.selectAll')} disabled={summary.empty} onSelect={run(() => actions.selectAll())} />
            <Item label={t.actions.zoomToFit} hint={shortcutHint('view.zoomFit')} onSelect={run(() => actions.zoomToFit())} />
            <Item label={grid ? t.menu.gridOff : t.menu.gridOn} hint={shortcutHint('view.grid')} onSelect={run(() => actions.toggleGrid())} />
          </>
        )}
    </Island>
  );
}

export default ContextMenu;
