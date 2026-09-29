/**
 * BoardNotFound.jsx — what a board URL shows when the server has no such
 * board: a mistyped or truncated link, a board someone deleted (also while it
 * was open here), or a dev server that restarted with in-memory storage.
 *
 * It REPLACES the editor. Drawing on a board that does not exist looked like
 * normal work and was silently thrown away (nothing can be saved to a missing
 * board), and the Share button's "tentando reconectar" promised a recovery
 * that never came. When there is something on screen from before the board
 * vanished, it can still be saved to a file.
 */

import React from 'react';
import { useBoardStore } from '../store/index.js';
import { actions } from '../editor/actions.js';
import { IconAlert, IconBoards, IconSave } from './Icons.jsx';
import { t } from './strings.js';

const T = t.notFound;

/**
 * @param {object} props
 * @param {string} props.boardId        the id that was asked for
 * @param {boolean} [props.deleted]     the board existed in this session and is gone now
 * @param {() => void} props.onBoards   back to the list
 */
export function BoardNotFound({ boardId, deleted = false, onBoards }) {
  const count = useBoardStore((s) => s.elements.length);
  return (
    <div className="screen screen--center" data-screen="board-not-found">
      <div className="island error-card not-found" role="alert" data-testid="board-not-found">
        <div className="error-card__head">
          <span className="error-card__icon">
            <IconAlert size={22} />
          </span>
          <div>
            <h1 className="error-card__title">{deleted ? T.deletedTitle : T.title}</h1>
            <p className="error-card__text">{deleted ? T.deletedText : T.text}</p>
            {boardId ? <p className="not-found__id">{T.id(boardId)}</p> : null}
          </div>
        </div>
        <div className="form-actions">
          {count > 0 ? (
            <button type="button" className="btn" data-testid="not-found-save" onClick={() => actions.saveToFile()}>
              <IconSave size={17} />
              {T.save(count)}
            </button>
          ) : null}
          <button type="button" className="btn btn--primary" data-testid="not-found-boards" onClick={onBoards}>
            <IconBoards size={17} />
            {T.boards}
          </button>
        </div>
      </div>
    </div>
  );
}

export default BoardNotFound;
