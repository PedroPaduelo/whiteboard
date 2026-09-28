/**
 * NicknameGate.jsx — the one thing you have to say before you see anything.
 *
 * This app has no accounts. The nickname IS the identity: it is what
 * `GET /boards?owner=` filters on and what a new board is created under. So
 * the gate is not a sign-up screen with a dismiss button, it is the thing the
 * board list depends on — which is why it is NOT dismissible and why there is
 * no "skip". Someone who picks "Not now" would be looking at a list filtered
 * by nothing, which is the fifteen-identical-boards list all over again.
 *
 * Both the first-run gate and the later "change your name" control are this
 * same form. One component, two entry points, so the two can never drift on
 * validation rules — the field rejects empty and over-long input the same way
 * in both places.
 *
 * The storage helper is imported rather than re-implemented: `queries.js` owns
 * the `localStorage` key, the try/catch and the in-memory fallback, so a
 * blocked `localStorage` (Safari private mode) degrades to a session-only
 * nickname instead of a broken app.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  NICKNAME_MAX,
  readNickname,
  validateNickname,
  writeNickname,
} from '../api/queries.js';
import { IconAlert, IconCheck, IconUsers } from './Icons.jsx';

/**
 * The form itself. Controlled by `onSubmit(value)`, which is responsible for
 * persisting — the gate lets the user through, the switcher tells the app the
 * name changed, and neither has to know how the other stores it.
 */
function NicknameForm({ initial = '', submitLabel = 'Continue', onSubmit, autoFocus = true, onCancel }) {
  const [draft, setDraft] = useState(initial);
  const [error, setError] = useState('');
  const inputRef = useRef(null);

  useEffect(() => {
    setDraft(initial);
  }, [initial]);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus();
  }, [autoFocus]);

  const commit = useCallback(
    (event) => {
      // A <form> gives us Enter-submits for free, and unlike a button with an
      // onClick it also submits from a single-line field in every browser
      // without a keydown handler duplicating what the form already does.
      if (event) event.preventDefault();

      // Validate BEFORE clearing the error, so a rejected value keeps the
      // field's text: wiping the draft on failure is how you lose what you
      // typed to a 65-character name.
      const check = validateNickname(draft);
      if (!check.ok) {
        setError(check.error);
        inputRef.current?.focus();
        return;
      }
      setError('');
      onSubmit?.(check.value);
    },
    [draft, onSubmit],
  );

  // `aria-invalid` + `aria-describedby` are what make the rejection
  // announced rather than only coloured.
  const tooLong = draft.trim().length > NICKNAME_MAX;

  return (
    <form onSubmit={commit} noValidate>
      <label
        htmlFor="nickname-input"
        style={{
          display: 'block',
          fontSize: 'var(--fs-sm)',
          fontWeight: 'var(--fw-semibold)',
          color: 'var(--color-text)',
          marginBottom: 'var(--sp-2)',
        }}
      >
        Your name
      </label>

      <input
        id="nickname-input"
        ref={inputRef}
        className="field"
        data-testid="nickname-input"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          // Clear the complaint as soon as they start fixing it; leaving a red
          // error under a field they are actively correcting reads as "still
          // broken".
          if (error) setError('');
        }}
        placeholder="e.g. ana"
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        aria-label="Your name"
        aria-invalid={error ? 'true' : 'false'}
        aria-describedby={error ? 'nickname-error' : 'nickname-hint'}
      />

      <p
        id="nickname-error"
        role={error ? 'alert' : undefined}
        data-testid="nickname-error"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--sp-2)',
          minHeight: error ? undefined : 20,
          margin: 'var(--sp-2) 0 0',
          fontSize: 'var(--fs-sm)',
          lineHeight: 'var(--lh-sm)',
          color: error ? 'var(--color-danger)' : 'var(--color-text-muted)',
        }}
      >
        {error ? (
          <>
            <span style={{ display: 'inline-flex', flex: 'none' }}>
              <IconAlert size={15} />
            </span>
            <span>{error}</span>
          </>
        ) : (
          <span id="nickname-hint">
            No account, no password — this name is how your boards are found.
          </span>
        )}
      </p>

      <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-4)' }}>
        {onCancel ? (
          <button type="button" className="btn btn--ghost" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="submit" className="btn btn--primary" style={{ flex: '1 1 auto' }} data-testid="nickname-submit">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}

/**
 * The blocking first-run gate.
 *
 * It renders INSTEAD of the app, not on top of it: there is no board list
 * behind it, no dimmed overlay you could click through, and no way to reach
 * the URL that shows boards without going through this form. That is the
 * difference between a gate and a modal — a modal leaves the thing it is
 * gating mounted and reachable in the DOM.
 */
export function NicknameGate() {
  const submit = useCallback((value) => {
    writeNickname(value);
  }, []);

  return (
    <div
      className="app-shell"
      data-screen="nickname-gate"
      data-testid="nickname-gate"
      style={{
        display: 'grid',
        placeItems: 'center',
        padding: 'var(--sp-5)',
        overflow: 'auto',
        background: 'var(--color-bg)',
      }}
    >
      <div
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="nickname-gate-title"
        style={{
          width: '100%',
          maxWidth: 420,
          padding: 'var(--sp-6)',
          display: 'grid',
          gap: 'var(--sp-2)',
        }}
      >
        <span
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 48,
            height: 48,
            borderRadius: 'var(--radius-pill)',
            background: 'var(--color-accent-soft)',
            color: 'var(--color-accent)',
            marginBottom: 'var(--sp-2)',
          }}
          aria-hidden="true"
        >
          <IconUsers size={22} />
        </span>

        <h1
          id="nickname-gate-title"
          className="panel__title"
          style={{ fontSize: 'var(--fs-xl)', lineHeight: 'var(--lh-2xl)' }}
        >
          What should we call you?
        </h1>
        <p
          style={{
            color: 'var(--color-text-muted)',
            fontSize: 'var(--fs-sm)',
            lineHeight: 'var(--lh-md)',
            margin: '0 0 var(--sp-3)',
          }}
        >
          Boards belong to a person, so the list needs to know whose. Type a name and you are in.
        </p>

        <NicknameForm initial="" submitLabel="Continue" onSubmit={submit} />
      </div>
    </div>
  );
}

/**
 * The "change your name" control, for the TopBar.
 *
 * A button, not a form: it opens a popover so the name is not a field
 * someone can lose focus out of on the way to opening a board. It is
 * collapsed to a chip showing the current name, because the current name is
 * the single most useful fact on the list screen — it is what tells you whose
 * boards you are looking at, and it makes a mis-set name obvious before you
 * wonder where your boards went.
 */
export function NicknameSwitcher() {
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState(() => readNickname());
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const submit = useCallback((value) => {
    writeNickname(value);
    setCurrent(value);
    setOpen(false);
  }, []);

  return (
    <div ref={rootRef} style={{ position: 'relative', flex: 'none' }}>
      <button
        type="button"
        className="btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="nickname-chip"
        title="Change your name"
        style={{ maxWidth: 160, gap: 'var(--sp-2)' }}
      >
        <span style={{ display: 'inline-flex', flex: 'none', color: 'var(--color-text-muted)' }}>
          <IconUsers size={15} />
        </span>
        <span
          style={{
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            maxWidth: 110,
          }}
        >
          {current || 'Set name'}
        </span>
      </button>

      {open ? (
        <div
          className="panel"
          role="dialog"
          aria-label="Change your name"
          data-testid="nickname-switcher"
          style={{
            top: 'calc(100% + var(--sp-2))',
            right: 0,
            width: 300,
            padding: 'var(--sp-4)',
          }}
        >
          <p
            style={{
              margin: '0 0 var(--sp-3)',
              fontSize: 'var(--fs-xs)',
              lineHeight: 'var(--lh-xs)',
              color: 'var(--color-text-muted)',
            }}
          >
            Changing your name switches the list to the boards owned by{' '}
            <strong>the new name</strong>, plus any that are still unclaimed.
          </p>
          <NicknameForm
            initial={current}
            submitLabel="Save"
            autoFocus={false}
            onSubmit={submit}
            onCancel={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}

export { NicknameForm };
export default NicknameGate;
