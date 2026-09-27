/**
 * Colour helpers shared by the renderer and the SVG/PNG export.
 *
 * Values on the board are CSS colour strings (hex or rgb()). Turning a hex into
 * rgba() with a given alpha is needed for selection overlays and shadow
 * effects, and doing it by hand with string surgery is how you end up with
 * `#fff` handling that quietly breaks. `normalizeHex` is the one place that
 * expands shorthand, so both the renderer and the exporter agree.
 */

/** @typedef {string} Color */

/**
 * Expand `#rgb` / `#rgba` to `#rrggbb` / `#rrggbbaa`. Anything else is
 * returned untouched.
 * @param {Color} c
 * @returns {Color}
 */
export function normalizeHex(c) {
  if (typeof c !== 'string') return c;
  const s = c.trim();
  if (!s.startsWith('#')) return s;
  const hex = s.slice(1);
  if (hex.length === 3 || hex.length === 4) {
    return '#' + [...hex].map((ch) => ch + ch).join('');
  }
  if (hex.length === 6 || hex.length === 8) return '#' + hex;
  return s;
}

/**
 * Convert any supported colour to `rgba(r, g, b, a)`. Used for translucent
 * selection halos and the eraser hit preview.
 * @param {Color} c
 * @param {number} [alpha] 0..1, multiplies any alpha already in `c`.
 * @returns {string}
 */
export function withAlpha(c, alpha = 1) {
  const s = normalizeHex(c);
  if (typeof s !== 'string') return s;
  if (s.startsWith('#')) {
    const hex = s.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const base = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha * base)})`;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    const [r, g, b] = parts;
    const base = parts.length > 3 ? Number(parts[3]) : 1;
    return `rgba(${r}, ${g}, ${b}, ${clamp01(alpha * base)})`;
  }
  return s;
}

/** @param {Color} c @returns {{r:number,g:number,b:number,a:number}} */
export function parseColor(c) {
  const s = normalizeHex(c);
  if (typeof s === 'string' && s.startsWith('#')) {
    const hex = s.slice(1);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  const m = typeof s === 'string' ? s.match(/^rgba?\(([^)]+)\)$/) : null;
  if (m) {
    const parts = m[1].split(/[,\s/]+/).filter(Boolean);
    return { r: +parts[0], g: +parts[1], b: +parts[2], a: parts.length > 3 ? +parts[3] : 1 };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

/**
 * Relative luminance per WCAG 2.1, used to pick readable label text on a
 * sticky note: white on a yellow note is unreadable, and this is how the
 * renderer decides without hardcoding a table of "light" colours.
 * @param {Color} c
 * @returns {number} 0 (black) .. 1 (white)
 */
export function luminance(c) {
  const { r, g, b } = parseColor(c);
  const f = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Black or white, whichever reads better on `bg`. */
export function readableTextOn(bg, light = '#ffffff', dark = '#111827') {
  return luminance(bg) > 0.45 ? dark : light;
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Blend two colours in sRGB. Used to render connector "routing" tints and the
 * presence halo behind a peer's cursor.
 * @param {Color} a @param {Color} b @param {number} t 0..1
 */
export function mix(a, b, t) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  const u = clamp01(t);
  const ch = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  const r = ch(ca.r + (cb.r - ca.r) * u);
  const g = ch(ca.g + (cb.g - ca.g) * u);
  const bl = ch(ca.b + (cb.b - ca.b) * u);
  return `#${r}${g}${bl}`;
}

/**
 * Deterministic per-peer colour. Two peers on the same board must always get
 * the same colour for the same id, without the server assigning and persisting
 * anything — a hash of the id is enough and survives a server restart.
 * @param {string} id
 * @returns {Color}
 */
export function colorForPeer(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = Math.abs(h) % 360;
  return `hsl(${hue} 72% 45%)`;
}
