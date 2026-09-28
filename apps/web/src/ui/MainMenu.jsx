/**
 * MainMenu.jsx — the hamburger in the top-left corner (Excalidraw's main
 * menu): files, export, share, clear, boards, name, theme, grid, help.
 *
 * Every item calls the same action/command the keyboard map uses; the menu
 * itself only decides what to show and closes after an item runs.
 */

import React, { useRef } from 'react';
import { useNickname } from '../api/queries.js';
import { useBoardId, useSnapEnabled } from '../store/index.js';
import { actions } from '../editor/actions.js';
import { useUi } from './uiStore.js';
import { copyShareLink } from './share.js';
import { openBoardFile, confirmClearCanvas } from './commands.js';
import { shortcutHint } from './shortcuts.js';
import { IconButton, Island, menuKeyNav, useOutsideClose } from './common.jsx';
import {
  IconBoards,
  IconCheck,
  IconExportImage,
  IconFolder,
  IconGrid,
  IconHelp,
  IconLink,
  IconMenu,
  IconMoon,
  IconSave,
  IconSun,
  IconTrash,
  IconUser,
} from './Icons.jsx';
import { t } from './strings.js';

function Item({ icon: I, label, hint, onSelect, danger, checked, role = 'menuitem' }) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={role === 'menuitemcheckbox' ? Boolean(checked) : undefined}
      className={`menu-item ${danger ? 'menu-item--danger' : ''}`}
      onClick={onSelect}
    >
      <span className="menu-item__icon">{I ? <I size={18} /> : null}</span>
      <span className="menu-item__label">{label}</span>
      {role === 'menuitemcheckbox' ? (
        <span className="menu-item__check" aria-hidden="true">
          {checked ? <IconCheck size={16} /> : null}
        </span>
      ) : hint ? (
        <span className="menu-item__hint">{hint}</span>
      ) : null}
    </button>
  );
}

export function MainMenu() {
  const open = useUi((s) => s.menuOpen);
  const theme = useUi((s) => s.theme);
  const boardId = useBoardId();
  const grid = useSnapEnabled();
  const nickname = useNickname();
  const ref = useRef(null);

  const ui = useUi.getState;
  const close = () => ui().close('menuOpen');
  useOutsideClose(ref, open, close, '[data-menu-trigger="main"]');

  const run = (fn) => () => {
    close();
    fn();
  };

  return (
    <div className="main-menu" ref={ref}>
      <Island className="island--button">
        <IconButton
          label={t.menu.button}
          data-menu-trigger="main"
          aria-haspopup="menu"
          aria-expanded={open}
          active={open}
          onClick={() => ui().toggle('menuOpen')}
        >
          <IconMenu />
        </IconButton>
      </Island>
      {open ? (
        <Island className="menu-panel" role="menu" aria-label={t.menu.button} onKeyDown={menuKeyNav}>
          <Item icon={IconFolder} label={t.menu.open} hint={shortcutHint('board.open')} onSelect={run(() => void openBoardFile())} />
          <Item icon={IconSave} label={t.menu.save} hint={shortcutHint('board.save')} onSelect={run(() => actions.saveToFile())} />
          <Item
            icon={IconExportImage}
            label={t.menu.exportImage}
            hint={shortcutHint('board.export')}
            onSelect={run(() => ui().open('exportOpen'))}
          />
          <Item icon={IconLink} label={t.menu.share} onSelect={run(() => void copyShareLink(boardId))} />
          <Item icon={IconTrash} label={t.menu.clear} danger onSelect={run(() => void confirmClearCanvas())} />
          <div className="menu-sep" role="separator" />
          <Item icon={IconBoards} label={t.menu.boards} onSelect={run(() => ui().navigate?.(null))} />
          <Item icon={IconUser} label={t.menu.changeName} onSelect={run(() => ui().open('nicknameOpen'))} />
          <div className="menu-sep" role="separator" />
          <Item
            icon={theme === 'dark' ? IconSun : IconMoon}
            label={theme === 'dark' ? t.menu.themeLight : t.menu.themeDark}
            hint={shortcutHint('view.theme')}
            onSelect={run(() => ui().toggleTheme())}
          />
          <Item
            icon={IconGrid}
            role="menuitemcheckbox"
            checked={grid}
            label={grid ? t.menu.gridOff : t.menu.gridOn}
            onSelect={run(() => actions.toggleGrid())}
          />
          <Item icon={IconHelp} label={t.menu.help} hint="?" onSelect={run(() => ui().open('helpOpen'))} />
          {nickname ? <div className="menu-foot">{t.menu.signedAs(nickname)}</div> : null}
        </Island>
      ) : null}
    </div>
  );
}

export default MainMenu;
