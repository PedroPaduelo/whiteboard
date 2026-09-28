/**
 * image.js — turning a picked, dropped or pasted image file into an element.
 *
 * Images live INSIDE the board as data URLs (the server accepts
 * `data:image/...;base64` up to LIMITS.MAX_IMAGE_CHARS), so a photo straight
 * from a phone camera must be shrunk first: we draw it onto a canvas no larger
 * than IMAGE_MAX_SIDE and re-encode it, stepping JPEG quality (and then the
 * size) down until the data URL fits IMAGE_MAX_CHARS. PNGs and other formats
 * with transparency stay PNG when they fit, so a logo keeps its alpha.
 *
 * The inserted element is shown at a comfortable size (longest side at most
 * IMAGE_DISPLAY_MAX board units) centred on the drop/click point; its
 * naturalWidth/naturalHeight record the encoded bitmap's size.
 */

import { IMAGE_MAX_SIDE, IMAGE_MAX_CHARS } from './constants.js';
import { createElement } from './elements.js';
import { useBoardStore } from '../store/boardStore.js';

/** Longest side, in board units, an image is first shown at. */
export const IMAGE_DISPLAY_MAX = 480;

/** MIME types we accept (what the validator's data-URL pattern allows). */
const ACCEPTED = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/;

export function isImageFile(file) {
  return Boolean(file) && typeof file.type === 'string' && ACCEPTED.test(file.type);
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('could not read the file'));
    r.readAsDataURL(file);
  });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('could not decode the image'));
    img.src = src;
  });
}

/** Encode `img` scaled to fit `maxSide`, trying formats/qualities until it fits. */
function encode(img, maxSide, preferPng) {
  const nw = img.naturalWidth || img.width || 1;
  const nh = img.naturalHeight || img.height || 1;
  let side = Math.min(maxSide, Math.max(nw, nh));
  for (let attempt = 0; attempt < 8; attempt++) {
    const scale = side / Math.max(nw, nh);
    const w = Math.max(1, Math.round(nw * scale));
    const h = Math.max(1, Math.round(nh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    if (preferPng) {
      const png = canvas.toDataURL('image/png');
      if (png.length <= IMAGE_MAX_CHARS) return { src: png, w, h };
    }
    // JPEG has no alpha: paint white behind transparent pixels first.
    const flat = document.createElement('canvas');
    flat.width = w;
    flat.height = h;
    const fctx = flat.getContext('2d');
    fctx.fillStyle = '#ffffff';
    fctx.fillRect(0, 0, w, h);
    fctx.drawImage(canvas, 0, 0);
    for (const q of [0.9, 0.8, 0.7, 0.55]) {
      const jpg = flat.toDataURL('image/jpeg', q);
      if (jpg.length <= IMAGE_MAX_CHARS) return { src: jpg, w, h };
    }
    side = Math.round(side * 0.7);
    if (side < 16) break;
  }
  throw new Error('a imagem é grande demais');
}

/**
 * Build a validated `image` element from a File, centred on `at` (board
 * units), downscaled to IMAGE_MAX_SIDE and encoded under IMAGE_MAX_CHARS.
 *
 * @param {File|Blob} file
 * @param {{x:number, y:number}} at
 * @param {object} [style]  store.style (only opacity applies to images)
 * @returns {Promise<object>} the element (not yet in the store)
 */
export async function fileToImageElement(file, at, style) {
  if (!isImageFile(file)) throw new Error('formato de imagem não suportado');
  const original = await readAsDataUrl(file);
  const img = await loadImage(original);
  const preferPng = !/jpe?g/.test(file.type);
  const { src, w, h } = encode(img, IMAGE_MAX_SIDE, preferPng);
  const k = Math.min(1, IMAGE_DISPLAY_MAX / Math.max(w, h));
  const dw = w * k;
  const dh = h * k;
  const c = at ?? { x: 0, y: 0 };
  return createElement('image', { x: c.x - dw / 2, y: c.y - dh / 2, w: dw, h: dh, src, naturalWidth: w, naturalHeight: h }, style);
}

/**
 * Ask the user for one image file. Resolves null when the dialog is
 * cancelled (where the browser tells us) — never rejects.
 * @returns {Promise<File|null>}
 */
export function openImagePicker() {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve(null);
      return;
    }
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/png,image/jpeg,image/gif,image/webp,image/svg+xml';
    input.style.display = 'none';
    let settled = false;
    const done = (file) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file ?? null);
    };
    input.addEventListener('change', () => done(input.files && input.files[0]));
    input.addEventListener('cancel', () => done(null));
    document.body.appendChild(input);
    input.click();
  });
}

/**
 * Insert image files at a board point as ONE undo step: each becomes an image
 * element (later ones offset so they do not stack exactly), the new elements
 * are selected and the tool returns to `select` (unless the tool is locked).
 * Files that are not images are skipped; returns the created elements.
 *
 * @param {File[]} files
 * @param {{x:number, y:number}} at  board units
 * @returns {Promise<object[]>}
 */
export async function insertImageFiles(files, at) {
  const list = [...(files ?? [])].filter(isImageFile);
  if (list.length === 0) return [];
  const style = useBoardStore.getState().style;
  const created = [];
  for (let i = 0; i < list.length; i++) {
    const p = { x: at.x + i * 24, y: at.y + i * 24 };
    created.push(await fileToImageElement(list[i], p, style));
  }
  const s = useBoardStore.getState();
  s.commit(`image:${created[0].id}`);
  s.addElements(created);
  if (s.tool !== 'select' && !s.toolLocked) s.setTool('select');
  const after = useBoardStore.getState();
  if (after.tool === 'select') after.select(created.map((el) => el.id));
  return created;
}
