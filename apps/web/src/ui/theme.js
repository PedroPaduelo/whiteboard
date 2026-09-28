/**
 * theme.js — light/dark theme: what is stored, what is applied.
 *
 * Rules (they fix the old "the board theme never applies" bug):
 *   - An explicit user choice (menu toggle, Alt+Shift+D) is persisted under
 *     `whiteboard:theme` and always wins.
 *   - Without a stored choice, the OS preference is the start value and a
 *     board's own `theme` is a DEFAULT: it is applied but NOT persisted, so
 *     the next board (or the OS) can still decide.
 *   - Applying a theme never writes storage by itself; only `persistTheme`
 *     does, and only a user action calls it.
 *
 * The UI chrome switches through `html[data-theme]` tokens (styles/tokens.css);
 * the canvas gets the theme as a prop and applies DARK_MODE_FILTER itself.
 */

export const THEME_KEY = 'whiteboard:theme';

const isTheme = (v) => v === 'light' || v === 'dark';

/** The persisted choice, or null when the user never picked one. */
export function storedTheme() {
  try {
    const v = globalThis.localStorage?.getItem(THEME_KEY);
    return isTheme(v) ? v : null;
  } catch {
    return null; // private mode / blocked storage
  }
}

export function hasStoredTheme() {
  return storedTheme() !== null;
}

/** Start value: the stored choice, else the OS preference, else light. */
export function initialTheme() {
  const stored = storedTheme();
  if (stored) return stored;
  try {
    if (globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches) return 'dark';
  } catch {
    /* no matchMedia (node) */
  }
  return 'light';
}

/** Put a theme on <html>. No storage side effect. */
export function applyTheme(theme) {
  if (typeof document === 'undefined') return;
  const value = isTheme(theme) ? theme : 'light';
  document.documentElement.dataset.theme = value;
  document.documentElement.style.colorScheme = value;
}

/** Remember an explicit user choice. */
export function persistTheme(theme) {
  if (!isTheme(theme)) return;
  try {
    globalThis.localStorage?.setItem(THEME_KEY, theme);
  } catch {
    /* storage is optional; the in-memory theme still applies */
  }
}
