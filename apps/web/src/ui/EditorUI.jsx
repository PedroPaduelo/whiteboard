/**
 * EditorUI.jsx — every floating island over the canvas, in Excalidraw's
 * layout:
 *
 *   top-left      MainMenu, then the PropertiesPanel under it
 *   top-centre    ToolIsland, the HintLine under it
 *   top-right     board title · people · Share · Library (sidebar below)
 *   bottom-left   zoom − NN% + · undo/redo
 *   bottom-right  help
 *   centre        WelcomeScreen on an empty board
 *   overlays      ContextMenu, Help/Export/Confirm/Nickname dialogs
 *
 * The layer itself ignores the pointer (the canvas below must get every
 * gesture); each island opts back in. On phones (≤ 640px) the CSS moves the
 * tool island to the bottom and turns the properties into a sheet.
 */

import React from 'react';
import { useError, useActions } from '../store/index.js';
import { MainMenu } from './MainMenu.jsx';
import { ToolIsland } from './ToolIsland.jsx';
import { HintLine } from './HintLine.jsx';
import { TopRight } from './TopRight.jsx';
import { PropertiesPanel } from './PropertiesPanel.jsx';
import { LibraryPanel } from './LibraryPanel.jsx';
import { Footer, HelpButton } from './Footer.jsx';
import { WelcomeScreen } from './WelcomeScreen.jsx';
import { ContextMenu } from './ContextMenu.jsx';
import { HelpDialog } from './HelpDialog.jsx';
import { ExportDialog } from './ExportDialog.jsx';
import { ConfirmDialog } from './ConfirmDialog.jsx';
import { NicknameDialog } from './NicknameGate.jsx';
import { IconAlert, IconClose } from './Icons.jsx';
import { t } from './strings.js';

function ErrorBanner() {
  const error = useError();
  const store = useActions();
  if (!error) return null;
  return (
    <div className="error-banner island" role="alert">
      <IconAlert size={16} />
      <span>{String(error)}</span>
      <button type="button" className="toast__close" aria-label={t.errors.dismiss} onClick={() => store.setError(null)}>
        <IconClose size={14} />
      </button>
    </div>
  );
}

export function EditorUI() {
  return (
    <div className="editor-ui" data-testid="editor-ui">
      <WelcomeScreen />
      <div className="top-bar">
        <div className="top-left">
          <MainMenu />
        </div>
        <div className="top-center">
          <ToolIsland />
          <HintLine />
          <ErrorBanner />
        </div>
        <TopRight />
      </div>
      <PropertiesPanel />
      <LibraryPanel />
      <div className="bottom-bar">
        <Footer />
        <HelpButton />
      </div>
      <ContextMenu />
      <HelpDialog />
      <ExportDialog />
      <ConfirmDialog />
      <NicknameDialog />
    </div>
  );
}

export default EditorUI;
