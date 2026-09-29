/**
 * ToolIsland.jsx — the tool bar at the top centre (bottom on phones), built
 * from editor/tools.js TOOLBAR: the tool lock (Q) first, the main tools with
 * their digit badge bottom-right, then a "more tools" dropdown holding the
 * `more: true` tools and the library.
 *
 * The digit on each badge and the tooltip's shortcut come from the same
 * TOOLBAR entry the keyboard map is derived from, so they cannot disagree.
 */

import React, { useRef } from 'react';
import { TOOLBAR } from '../editor/tools.js';
import { actions } from '../editor/actions.js';
import { useBoardStore, useTool, useToolLocked, useActions } from '../store/index.js';
import { useUi } from './uiStore.js';
import { IconButton, Island, menuKeyNav, useMenuFocus, useOutsideClose } from './common.jsx';
import { ICONS, IconChevronDown, IconHand, IconLibrary, IconLock, IconShapes, IconUnlock } from './Icons.jsx';
import { toolChords, formatKeys } from './shortcuts.js';
import { t } from './strings.js';

const MAIN = TOOLBAR.filter((tool) => !tool.more);
const MORE = TOOLBAR.filter((tool) => tool.more);

const shortcutOf = (tool) => toolChords(tool).map(formatKeys).join(` ${t.help.or} `);

function ToolButton({ tool, active }) {
  const Icon = ICONS[tool.icon];
  return (
    <IconButton
      className="tool-btn"
      label={t.tools[tool.id] ?? tool.id}
      shortcut={shortcutOf(tool)}
      active={active}
      pressed={active}
      data-tool={tool.id}
      badge={tool.digit ?? undefined}
      onClick={() => actions.selectTool(tool.id)}
    >
      {Icon ? <Icon /> : null}
    </IconButton>
  );
}

function MoreTools({ tool, locked }) {
  const open = useUi((s) => s.moreToolsOpen);
  const libraryOpen = useUi((s) => s.libraryOpen);
  const ref = useRef(null);
  const menuRef = useMenuFocus(open);
  const close = () => useUi.getState().close('moreToolsOpen');
  useOutsideClose(ref, open, close);
  const activeMore = MORE.find((m) => m.id === tool);
  const ActiveIcon = activeMore ? ICONS[activeMore.icon] : IconShapes;

  return (
    <div className="more-tools" ref={ref}>
      <IconButton
        className={`tool-btn more-tools__btn ${tool === 'hand' ? 'more-tools__btn--hand' : ''}`}
        label={activeMore ? `${t.toolIsland.more}: ${t.tools[activeMore.id]}` : t.toolIsland.more}
        active={Boolean(activeMore) || open}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="more-tools"
        onClick={() => useUi.getState().toggle('moreToolsOpen')}
      >
        <ActiveIcon />
        <IconChevronDown size={11} className="more-tools__chevron" strokeWidth={2.5} />
      </IconButton>
      {open ? (
        <Island ref={menuRef} className="menu-panel more-tools__menu" role="menu" aria-label={t.toolIsland.more} onKeyDown={menuKeyNav}>
          {/* Narrow screens only (≤ 900px): the lock and the hand are hidden from the island. */}
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={locked}
            className={`menu-item mobile-only ${locked ? 'is-active' : ''}`}
            onClick={() => {
              close();
              useBoardStore.getState().toggleToolLocked();
            }}
          >
            <span className="menu-item__icon">{locked ? <IconLock size={18} /> : <IconUnlock size={18} />}</span>
            <span className="menu-item__label">{t.toolIsland.lock}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className={`menu-item mobile-only ${tool === 'hand' ? 'is-active' : ''}`}
            onClick={() => {
              close();
              actions.selectTool('hand');
            }}
          >
            <span className="menu-item__icon">
              <IconHand size={18} />
            </span>
            <span className="menu-item__label">{t.tools.hand}</span>
          </button>
          {MORE.map((m) => {
            const I = ICONS[m.icon];
            return (
              <button
                key={m.id}
                type="button"
                role="menuitem"
                className={`menu-item ${tool === m.id ? 'is-active' : ''}`}
                data-tool={m.id}
                onClick={() => {
                  close();
                  actions.selectTool(m.id);
                }}
              >
                <span className="menu-item__icon">{I ? <I size={18} /> : null}</span>
                <span className="menu-item__label">{t.tools[m.id]}</span>
                <span className="menu-item__hint">{shortcutOf(m)}</span>
              </button>
            );
          })}
          <div className="menu-sep" role="separator" />
          <button
            type="button"
            role="menuitem"
            className={`menu-item ${libraryOpen ? 'is-active' : ''}`}
            onClick={() => {
              close();
              useUi.getState().toggle('libraryOpen');
            }}
          >
            <span className="menu-item__icon">
              <IconLibrary size={18} />
            </span>
            <span className="menu-item__label">{t.toolIsland.library}</span>
          </button>
        </Island>
      ) : null}
    </div>
  );
}

export function ToolIsland() {
  const tool = useTool();
  const locked = useToolLocked();
  const store = useActions();

  return (
    <Island className="tool-island" role="toolbar" aria-label={t.toolIsland.label} data-testid="tool-island">
      <IconButton
        className="tool-btn tool-btn--lock"
        label={locked ? t.toolIsland.lockOn : t.toolIsland.lock}
        // The "on" label already says "Q para destravar": no second " — Q".
        shortcut={locked ? undefined : 'Q'}
        active={locked}
        pressed={locked}
        onClick={() => store.toggleToolLocked()}
      >
        {locked ? <IconLock /> : <IconUnlock />}
      </IconButton>
      <span className="island-divider" aria-hidden="true" />
      {MAIN.map((m) => (
        <ToolButton key={m.id} tool={m} active={tool === m.id} />
      ))}
      <span className="island-divider" aria-hidden="true" />
      <MoreTools tool={tool} locked={locked} />
    </Island>
  );
}

export default ToolIsland;
