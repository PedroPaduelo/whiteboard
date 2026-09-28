/**
 * NicknameGate.jsx — the name you type before seeing anything, and the
 * controls to change it later.
 *
 * This app has no accounts: the nickname IS the identity. It is what
 * `GET /boards?owner=` filters on, what a new board is created under and the
 * name collaborators see next to your cursor. So the gate is not dismissible;
 * App renders it INSTEAD of the app (not over it) until a name exists.
 *
 * One form (`NicknameForm`) serves the gate, the board list's switcher and the
 * board's "Alterar nome" dialog, so validation cannot drift between them.
 * Storage lives in api/queries.js (localStorage with an in-memory fallback).
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { NICKNAME_MAX, readNickname, useNickname, validateNickname, writeNickname } from '../api/queries.js';
import { useUi } from './uiStore.js';
import { Dialog } from './Dialog.jsx';
import { useOutsideClose } from './common.jsx';
import { toast } from './toast.js';
import { IconAlert, IconUser } from './Icons.jsx';
import { t } from './strings.js';

/** Portuguese message for a rejected value (the validator's own text is English). */
function errorFor(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return t.nickname.errEmpty;
  if (value.length > NICKNAME_MAX) return t.nickname.errLong(value.length, NICKNAME_MAX);
  return t.nickname.errEmpty;
}

export function NicknameForm({ initial = '', submitLabel = t.nickname.continue, onSubmit, autoFocus = true, onCancel, idPrefix = 'nickname' }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => setDraft(initial), [initial]);
  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(
    (event) => {
      event?.preventDefault();
      // Validate before clearing the error, so a rejected value keeps its text.
      const check = validateNickname(draft);
      if (!check.ok) {
        setError(errorFor(draft));
        inputRef.current?.focus();
        return;
      }
      setError('');
      onSubmit?.(check.value);
    },
    [draft, onSubmit],
  );

  const inputId = `${idPrefix}-input`;
  const errorId = `${idPrefix}-error`;
  return (
    <form onSubmit={commit} noValidate className="nickname-form">
      <label htmlFor={inputId} className="field-label">
        {t.nickname.label}
      </label>
      <input
        id={inputId}
        ref={inputRef}
        className="field"
        data-testid="nickname-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          if (error) setError('');
        }}
        placeholder={t.nickname.placeholder}
        autoComplete="nickname"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={errorId}
      />
      <p id={errorId} role={error ? 'alert' : undefined} data-testid="nickname-error" className={`field-help ${error ? 'field-help--error' : ''}`}>
        {error ? (
          <>
            <IconAlert size={15} />
            <span>{error}</span>
          </>
        ) : (
          <span>{t.nickname.hint}</span>
        )}
      </p>
      <div className="form-actions">
        {onCancel ? (
          <button type="button" className="btn" onClick={onCancel}>
            {t.nickname.cancel}
          </button>
        ) : null}
        <button type="submit" className="btn btn--primary btn--grow" data-testid="nickname-submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/** The blocking first-run gate (rendered instead of the app). */
export function NicknameGate() {
  const submit = useCallback((value) => writeNickname(value), []);
  return (
    <div className="screen screen--center" data-screen="nickname-gate" data-testid="nickname-gate">
      <div className="gate island" role="dialog" aria-modal="true" aria-labelledby="nickname-gate-title">
        <div className="gate__logo" aria-hidden="true">
          {t.app.name}
        </div>
        <h1 id="nickname-gate-title" className="gate__title">
          {t.nickname.gateTitle}
        </h1>
        <p className="gate__text">{t.nickname.gateText}</p>
        <NicknameForm initial="" submitLabel={t.nickname.continue} onSubmit={submit} />
      </div>
    </div>
  );
}

/** "Change your name" chip + popover, for the board list header. */
export function NicknameSwitcher() {
  const [open, setOpen] = useState(false);
  const current = useNickname() || readNickname();
  const rootRef = useRef(null);
  useOutsideClose(rootRef, open, () => setOpen(false));

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const submit = useCallback((value) => {
    writeNickname(value);
    setOpen(false);
    toast.success(t.toast.nameChanged(value));
  }, []);

  return (
    <div ref={rootRef} className="nickname-switcher">
      <button
        type="button"
        className="btn nickname-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="nickname-chip"
        title={t.nickname.change}
      >
        <IconUser size={16} />
        <span className="nickname-chip__name">{current || t.nickname.setName}</span>
      </button>
      {open ? (
        <div className="popover island" role="dialog" aria-label={t.nickname.change} data-testid="nickname-switcher">
          <p className="popover__text">{t.nickname.switcherText}</p>
          <NicknameForm initial={current} submitLabel={t.nickname.save} autoFocus onSubmit={submit} onCancel={() => setOpen(false)} idPrefix="nickname-switch" />
        </div>
      ) : null}
    </div>
  );
}

/** The board's "Alterar nome" dialog (main menu). Presence follows the new name. */
export function NicknameDialog() {
  const open = useUi((s) => s.nicknameOpen);
  const current = useNickname();
  if (!open) return null;
  const close = () => useUi.getState().close('nicknameOpen');
  return (
    <Dialog title={t.nickname.change} onClose={close} size="sm" testId="nickname-dialog" initialFocus="input">
      <NicknameForm
        initial={current}
        submitLabel={t.nickname.save}
        idPrefix="nickname-dialog"
        onCancel={close}
        onSubmit={(value) => {
          writeNickname(value);
          close();
          toast.success(t.toast.nameChanged(value));
        }}
      />
    </Dialog>
  );
}

export default NicknameGate;
