/**
 * fonts.js — loads the two bundled web fonts and tells the renderer when they
 * are ready.
 *
 * Canvas text does not wait for fonts: `fillText` with a family that has not
 * loaded yet silently paints the fallback, and every width measured meanwhile
 * belongs to the fallback too. So the fonts are loaded explicitly through the
 * FontFace API, and whoever caches text layout subscribes with
 * `onFontsLoaded` to throw those caches away and repaint once they are in.
 *
 * Each font file is fetched ONCE as bytes. The same bytes become the FontFace
 * (for the screen) and a base64 data URL (for the SVG export, which must embed
 * the font or the exported drawing opens in a system font elsewhere).
 *
 * In node (unit tests) there is no FontFace/document: `loadFonts` resolves
 * immediately and `fontDataUrl` returns null, so the export falls back to the
 * family name.
 */

/** The bundled faces. `key` is the element `fontFamily` value that uses it. */
export const FONT_FACES = Object.freeze([
  Object.freeze({ key: 'hand', family: 'Virgil', file: 'Virgil-Regular.woff2' }),
  Object.freeze({ key: 'code', family: 'Cascadia Code', file: 'CascadiaCode-Regular.woff2' }),
]);

/** Vite's public base ('/' in this app); absent in node. */
const BASE = (() => {
  try {
    return import.meta.env?.BASE_URL || '/';
  } catch {
    return '/';
  }
})();

/** URL of a bundled font file, e.g. `/fonts/Virgil-Regular.woff2`. */
export function fontUrl(file) {
  return `${BASE.endsWith('/') ? BASE : `${BASE}/`}fonts/${file}`;
}

let loading = null;
let done = false;
const dataUrls = new Map(); // family -> data:font/woff2;base64,...
const listeners = new Set();

/**
 * Load Virgil and Cascadia Code. Idempotent: every call returns the same
 * promise. It never rejects — a font that fails to load is logged and the
 * fallback stack in FONT_FAMILIES takes over.
 * @returns {Promise<void>}
 */
export function loadFonts() {
  if (loading) return loading;
  const canLoad =
    typeof document !== 'undefined' &&
    typeof FontFace !== 'undefined' &&
    typeof fetch !== 'undefined' &&
    document.fonts;
  if (!canLoad) {
    done = true;
    loading = Promise.resolve();
    return loading;
  }
  loading = Promise.all(FONT_FACES.map(loadFace)).then(() => {
    done = true;
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (err) {
        console.error('[fonts] onFontsLoaded listener failed', err);
      }
    }
  });
  return loading;
}

async function loadFace({ family, file }) {
  try {
    const res = await fetch(fontUrl(file));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const face = new FontFace(family, buf, { style: 'normal', weight: '400', display: 'swap' });
    await face.load();
    document.fonts.add(face);
    dataUrls.set(family, `data:font/woff2;base64,${bytesToBase64(new Uint8Array(buf))}`);
  } catch (err) {
    console.warn(`[fonts] could not load ${family} (${file}); using the fallback font`, err);
  }
}

/**
 * Subscribe to "fonts finished loading" (fires once, after `loadFonts`
 * settles, whether or not every face loaded). Returns an unsubscribe function.
 * A subscriber added after that moment is not called: nothing it could have
 * cached was measured with a fallback font.
 * @param {() => void} cb
 * @returns {() => void}
 */
export function onFontsLoaded(cb) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** True once `loadFonts` has settled. */
export function fontsReady() {
  return done;
}

/**
 * The embeddable data URL of a loaded face (by CSS family name), or null when
 * it is not loaded (yet) or we are in node.
 * @param {string} family e.g. 'Virgil'
 * @returns {string|null}
 */
export function fontDataUrl(family) {
  return dataUrls.get(family) ?? null;
}

/** Base64 of raw bytes, without blowing the call stack on big files. */
export function bytesToBase64(bytes) {
  if (typeof Buffer !== 'undefined' && typeof window === 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}
