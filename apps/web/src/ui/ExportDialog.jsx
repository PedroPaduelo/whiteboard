/**
 * ExportDialog.jsx — "Exportar imagem": live preview, background on/off,
 * dark mode, scale 1×/2×/3×, only-the-selection, then download PNG or SVG or
 * copy a PNG to the clipboard.
 *
 * Everything is drawn by editor/export/export.js (contract §6): the SVG with
 * the same roughjs shapes as the screen, the PNG by replaying the on-screen
 * renderer on an offscreen canvas. The preview is the SVG export itself.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  exportToSvg,
  exportToPngBlob,
  exportBounds,
  downloadBlob,
  copyBlobToClipboard,
  canCopyImageToClipboard,
} from '../editor/export/export.js';
import { fileBaseName } from '../editor/actions.js';
import { useBoard, useBoardStore } from '../store/index.js';
import { useUi } from './uiStore.js';
import { Dialog } from './Dialog.jsx';
import { toast } from './toast.js';
import { IconClipboard, IconDownload } from './Icons.jsx';
import { t } from './strings.js';

const PADDING = 10;
const SCALES = [1, 2, 3];

function Toggle({ checked, onChange, label, testId }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} data-testid={testId} />
      <span className="toggle__track" aria-hidden="true">
        <span className="toggle__thumb" />
      </span>
      <span className="toggle__label">{label}</span>
    </label>
  );
}

function ExportBody() {
  const all = useBoardStore((s) => s.elements);
  const selected = useBoardStore(useShallow((s) => (s.selection.size ? s.elements.filter((el) => s.selection.has(el.id)) : [])));
  const board = useBoard();
  const [background, setBackground] = useState(true);
  const [dark, setDark] = useState(false);
  const [scale, setScale] = useState(2);
  const [onlySelected, setOnlySelected] = useState(selected.length > 0);
  const [busy, setBusy] = useState(false);

  const elements = onlySelected && selected.length ? selected : all;
  const name = fileBaseName(board?.title);

  const svg = useMemo(() => {
    if (!elements.length) return '';
    try {
      return exportToSvg(elements, { background, dark, padding: PADDING, scale: 1 });
    } catch (err) {
      console.error('[export] preview failed', err);
      return '';
    }
  }, [elements, background, dark]);

  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!svg) {
      setUrl(null);
      return undefined;
    }
    const u = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [svg]);

  const size = useMemo(() => {
    const b = exportBounds(elements);
    if (!b) return null;
    return { w: Math.round((b.w + PADDING * 2) * scale), h: Math.round((b.h + PADDING * 2) * scale) };
  }, [elements, scale]);

  const opts = { background, dark, padding: PADDING, scale };

  const run = async (fn) => {
    if (!elements.length || busy) return;
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      // The error's own text is English (canvas, clipboard, fonts): console only.
      console.error('[export] failed', err);
      toast.error(t.toast.exportFailed);
    } finally {
      setBusy(false);
    }
  };

  const downloadPng = () => run(async () => downloadBlob(await exportToPngBlob(elements, opts), `${name}.png`, 'image/png'));
  const downloadSvg = () => run(async () => downloadBlob(exportToSvg(elements, opts), `${name}.svg`, 'image/svg+xml'));
  const copyPng = () =>
    run(async () => {
      if (!canCopyImageToClipboard()) {
        toast.info(t.toast.pngCopyUnsupported);
        return;
      }
      // Pass the promise: Safari needs the clipboard write inside the gesture.
      await copyBlobToClipboard(exportToPngBlob(elements, opts));
      toast.success(t.toast.pngCopied);
    });

  if (!all.length) {
    return <p className="export-empty">{t.export.empty}</p>;
  }

  return (
    <div className="export">
      <div className={`export__preview ${background ? '' : 'export__preview--transparent'}`} aria-label={t.export.preview}>
        {url ? <img src={url} alt={t.export.preview} /> : <span>{t.export.rendering}</span>}
      </div>
      <div className="export__side">
        <div className="export__options">
          <Toggle checked={background} onChange={setBackground} label={t.export.background} testId="export-background" />
          <Toggle checked={dark} onChange={setDark} label={t.export.dark} testId="export-dark" />
          {selected.length ? <Toggle checked={onlySelected} onChange={setOnlySelected} label={t.export.onlySelected} /> : null}
          <div className="export__scale">
            <span className="export__label">{t.export.scale}</span>
            <div className="options" role="radiogroup" aria-label={t.export.scale}>
              {SCALES.map((s) => (
                <button key={s} type="button" role="radio" aria-checked={scale === s} className="option option--text" onClick={() => setScale(s)}>
                  {s}×
                </button>
              ))}
            </div>
          </div>
          {size ? <p className="export__size">{t.export.size(size.w, size.h)}</p> : null}
        </div>
        <div className="export__actions">
          <button type="button" className="btn btn--primary" disabled={busy} onClick={downloadPng} data-testid="export-png">
            <IconDownload size={18} />
            {t.export.png}
          </button>
          <button type="button" className="btn btn--primary" disabled={busy} onClick={downloadSvg} data-testid="export-svg">
            <IconDownload size={18} />
            {t.export.svg}
          </button>
          <button type="button" className="btn" disabled={busy} onClick={copyPng}>
            <IconClipboard size={18} />
            {t.export.copy}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ExportDialog() {
  const open = useUi((s) => s.exportOpen);
  if (!open) return null;
  const close = () => useUi.getState().close('exportOpen');
  return (
    <Dialog title={t.export.title} onClose={close} size="lg" testId="export-dialog">
      <ExportBody />
    </Dialog>
  );
}

export default ExportDialog;
