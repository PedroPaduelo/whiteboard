/**
 * WelcomeScreen.jsx — what an empty board shows (Excalidraw's welcome
 * screen): handwritten hints with sketchy arrows pointing at the menu, the
 * tool island, the library and help, and a few quick actions in the centre.
 *
 * Only on an EMPTY, LOADED board with the select/hand tool: the moment a
 * drawing tool is picked or anything exists, it gets out of the way. It never
 * takes pointer events except on its own buttons, so drawing "through" it
 * works.
 */

import React from 'react';
import { useBoardStore } from '../store/index.js';
import { useUi } from './uiStore.js';
import { openBoardFile } from './commands.js';
import { shortcutHint } from './shortcuts.js';
import { IconFolder, IconHelp, IconLibrary } from './Icons.jsx';
import { t } from './strings.js';

function Arrow({ d, head, width = 60, height = 60 }) {
  return (
    <svg className="welcome-arrow" width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" aria-hidden="true">
      <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <path d={head} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function WelcomeScreen() {
  const visible = useBoardStore(
    (s) => Boolean(s.board) && s.elements.length === 0 && (s.tool === 'select' || s.tool === 'hand') && !s.editingId,
  );
  const libraryOpen = useUi((s) => s.libraryOpen);
  const textDraft = useUi((s) => s.textDraftOpen);
  if (!visible || textDraft) return null;
  const ui = useUi.getState;
  return (
    <div className="welcome" data-testid="welcome-screen">
      <div className="welcome-hint welcome-hint--menu">
        <Arrow d="M50 56 C 34 54 16 42 11 10" head="M4 17 L11 7 L18 15" />
        <span>{t.welcome.menuHint}</span>
      </div>
      <div className="welcome-hint welcome-hint--toolbar">
        <Arrow width={40} height={56} d="M20 54 C 27 38 13 24 20 5" head="M13 12 L20 4 L27 11" />
        <span>{t.welcome.toolbarHint}</span>
      </div>
      {libraryOpen ? null : (
        <div className="welcome-hint welcome-hint--library">
          <Arrow d="M10 56 C 26 54 44 42 49 10" head="M42 15 L49 7 L56 17" />
          <span>{t.welcome.libraryHint}</span>
        </div>
      )}
      <div className="welcome-hint welcome-hint--help">
        <span>{t.welcome.helpHint}</span>
        <Arrow d="M8 6 C 30 8 46 22 50 50" head="M42 45 L50 53 L56 43" />
      </div>

      <div className="welcome-center">
        <div className="welcome-logo">{t.welcome.title}</div>
        <p className="welcome-subtitle">{t.welcome.subtitle}</p>
        <div className="welcome-actions">
          <button type="button" className="welcome-action" onClick={() => void openBoardFile()}>
            <IconFolder size={18} />
            <span>{t.welcome.open}</span>
            <kbd className="kbd">{shortcutHint('board.open')}</kbd>
          </button>
          <button type="button" className="welcome-action" onClick={() => ui().open('libraryOpen')}>
            <IconLibrary size={18} />
            <span>{t.welcome.library}</span>
          </button>
          <button type="button" className="welcome-action" onClick={() => ui().open('helpOpen')}>
            <IconHelp size={18} />
            <span>{t.welcome.help}</span>
            <kbd className="kbd">?</kbd>
          </button>
        </div>
      </div>
    </div>
  );
}

export default WelcomeScreen;
