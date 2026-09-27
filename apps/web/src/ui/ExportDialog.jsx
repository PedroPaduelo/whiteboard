/**
 * ExportDialog.jsx — SVG / PNG / JSON export, and JSON import.
 *
 * The heavy lifting is the canvas agent's `export.js`: it owns the SVG writer,
 * the rasteriser and the wire format, because the same functions back the
 * on-canvas renderer. This dialog owns the parts that are a *product*
 * concern: a live preview so the user can see what they are about to get, an
 * honest file-size readout, and an import flow that validates and reports
 * BEFORE it touches the board.
 *
 * The import is the part worth reading twice. It never replaces the board in
 * the same gesture that reads the file: read → validate → show what was
 * found → confirm. A board is someone's afternoon of work; "import" must
 * never be the button that loses it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  downloadBlob,
  exportBounds,
  exportJSON,
  exportPNG,
  exportSVG,
  importJSON,
} from '../canvas/export.js';
import { useStore, getStoreApi } from './store.js';
import { toast } from './Toasts.jsx';
import { IconAlert, IconCheck, IconClose, IconDownload, IconUpload } from './Icons.jsx';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

const SCALES = [1, 2, 3, 4];
const FORMATS = [
  { id: 'svg', name: 'SVG', desc: 'Vector, infinitely scalable. Best for print and further editing.' },
  { id: 'png', name: 'PNG', desc: 'Raster image at a chosen resolution. Best for slides and chat.' },
  { id: 'json', name: 'JSON', desc: 'The full element list, re-importable. Best for backup and scripting.' },
];

function safeName(title) {
  const base = String(title || 'board')
    .trim()
    .replace(/[^\w\-. ]+/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 60);
  return base || 'board';
}

function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function useFocusTrap(open, onClose, ref) {
  useEffect(() => {
    if (!open) return undefined;
    const restore = document.activeElement;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose?.();
        return;
      }
      if (event.key !== 'Tab') return;
      const node = ref.current;
      const items = node ? [...node.querySelectorAll(FOCUSABLE)] : [];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    ref.current?.querySelector(FOCUSABLE)?.focus();
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      if (restore && typeof restore.focus === 'function' && document.contains(restore)) restore.focus();
    };
  }, [open, onClose, ref]);
}

export function ExportDialog({ open, onClose }) {
  const elements = useStore((s) => s.elements ?? []);
  const board = useStore((s) => s.board);
  const theme = useStore(() =>
    document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light',
  );

  const store = getStoreApi();
  const dialogRef = useRef(null);
  const fileRef = useRef(null);
  const [format, setFormat] = useState('svg');
  const [scale, setScale] = useState(2);
  const [transparent, setTransparent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [previewUrl, setPreviewUrl] = useState(null);
  const [previewMeta, setPreviewMeta] = useState(null);
  const [importReport, setImportReport] = useState(null);
  const [pendingImport, setPendingImport] = useState(null);
  const [confirmReplace, setConfirmReplace] = useState(false);

  useFocusTrap(open, onClose, dialogRef);

  const bounds = useMemo(() => exportBounds(elements), [elements]);
  const empty = elements.length === 0;

  /* --- live preview -------------------------------------------------------
     Built on every change to the elements / options, in a rAF so dragging a
     shape does not synchronously re-serialise the whole board on every
     pointermove. The previous object URL is always revoked, including on
     unmount, or a long editing session leaks one blob per render.
     ------------------------------------------------------------------- */
  useEffect(() => {
    if (!open || empty) {
      setPreviewUrl(null);
      return undefined;
    }
    let cancelled = false;
    let url = null;
    const raf = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        const svg = exportSVG(elements, {
          background: transparent ? 'none' : undefined,
          theme,
          title: board?.title,
        });
        url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setPreviewUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setPreviewMeta({
          boardW: Math.round(bounds.w),
          boardH: Math.round(bounds.h),
          bytes: new Blob([svg]).size,
          pngW: Math.round(bounds.w * scale),
          pngH: Math.round(bounds.h * scale),
        });
      } catch (e) {
        setPreviewUrl(null);
        setPreviewMeta(null);
        toast.error(e?.message || 'Could not build a preview');
      }
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
      if (url) URL.revokeObjectURL(url);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, elements, transparent, theme, board?.title, scale, bounds.w, bounds.h]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  // Reset the import report when the dialog is reopened.
  useEffect(() => {
    if (open) {
      setImportReport(null);
      setPendingImport(null);
      setConfirmReplace(false);
    }
  }, [open]);

  /* --- export -------------------------------------------------------------- */
  const runExport = useCallback(async () => {
    if (empty) {
      toast.error('There is nothing on the board to export');
      return;
    }
    const name = safeName(board?.title);
    setBusy(true);
    try {
      if (format === 'svg') {
        const svg = exportSVG(elements, {
          background: transparent ? 'none' : undefined,
          theme,
          title: board?.title,
        });
        downloadBlob(svg, `${name}.svg`);
        toast.success(`Exported ${name}.svg`);
      } else if (format === 'png') {
        const svg = exportSVG(elements, {
          background: transparent ? 'none' : undefined,
          theme,
          title: board?.title,
        });
        const blob = await exportPNG(svg, {
          scale,
          background: transparent ? 'none' : undefined,
        });
        downloadBlob(blob, `${name}@${scale}x.png`);
        toast.success(`Exported ${name}@${scale}x.png`);
      } else {
        const json = exportJSON(elements, { board: board ?? null, now: Date.now() });
        downloadBlob(json, `${name}.json`);
        toast.success(`Exported ${name}.json`);
      }
    } catch (e) {
      toast.error(e?.message || 'Export failed');
    } finally {
      setBusy(false);
    }
  }, [elements, board, format, scale, transparent, theme, empty]);

  /* --- import -------------------------------------------------------------- */
  const onPickFile = useCallback(async (event) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!file) return;
    setImportReport(null);
    setPendingImport(null);
    setConfirmReplace(false);
    try {
      const text = await file.text();
      const res = importJSON(text);
      if (!res.ok) {
        setImportReport({ ok: false, error: res.error, index: res.index });
        return;
      }
      const byType = res.elements.reduce((acc, el) => {
        acc[el.type] = (acc[el.type] ?? 0) + 1;
        return acc;
      }, {});
      setImportReport({
        ok: true,
        count: res.elements.length,
        byType,
        title: res.board?.title,
        filename: file.name,
      });
      setPendingImport(res.elements);
    } catch (e) {
      setImportReport({ ok: false, error: e?.message || 'Could not read the file' });
    }
  }, []);

  const applyImport = useCallback(() => {
    if (!pendingImport) return;
    const count = pendingImport.length;
    // commit() BEFORE mutating — that is the history contract, and without
    // it this replacement is the one edit the user cannot undo.
    store.commit('import');
    store.replaceAll(pendingImport);
    store.clearSelection();
    setPendingImport(null);
    setConfirmReplace(false);
    setImportReport(null);
    toast.success(`Imported ${count} ${count === 1 ? 'element' : 'elements'}`);
  }, [pendingImport, store]);

  if (!open) return null;

  const onBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose?.();
  };

  return (
    <div className="backdrop" onMouseDown={onBackdrop}>
      <div
        ref={dialogRef}
        className="panel dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        style={{ width: 'min(640px, 100%)' }}
      >
        <div className="dialog__header">
          <h2 id="export-title" className="panel__title" style={{ fontSize: 'var(--fs-lg)' }}>
            Export &amp; import
          </h2>
          <button
            type="button"
            className="btn btn--icon"
            onClick={onClose}
            aria-label="Close"
            title="Close  (Esc)"
          >
            <IconClose size={17} />
          </button>
        </div>

        <div className="dialog__body" style={{ padding: 'var(--sp-4)' }}>
          <div className="export-options">
            {FORMATS.map((f) => (
              <button
                key={f.id}
                type="button"
                className="export-option"
                aria-pressed={format === f.id}
                style={
                  format === f.id
                    ? { borderColor: 'var(--color-accent)', background: 'var(--color-accent-soft)' }
                    : undefined
                }
                onClick={() => setFormat(f.id)}
              >
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 18,
                    height: 18,
                    borderRadius: 'var(--radius-pill)',
                    border: `1.5px solid ${
                      format === f.id ? 'var(--color-accent)' : 'var(--color-border-strong)'
                    }`,
                    color: 'var(--color-accent-contrast)',
                    background: format === f.id ? 'var(--color-accent)' : 'transparent',
                    flex: 'none',
                  }}
                >
                  {format === f.id ? <IconCheck size={12} /> : null}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontWeight: 'var(--fw-semibold)' }}>{f.name}</span>
                  <span className="export-option__desc">{f.desc}</span>
                </span>
              </button>
            ))}
          </div>

          {/* --- options -------------------------------------------------- */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
            {format === 'png' ? (
              <div>
                <span className="field__label">Resolution</span>
                <div className="segmented" role="radiogroup" aria-label="PNG scale" style={{ width: 176 }}>
                  {SCALES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      role="radio"
                      aria-checked={scale === s}
                      className="segmented__item"
                      onClick={() => setScale(s)}
                    >
                      {s}×
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <label
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--sp-2)',
                cursor: 'pointer',
                fontSize: 'var(--fs-sm)',
                alignSelf: 'flex-end',
                paddingBottom: 6,
              }}
            >
              <input
                type="checkbox"
                checked={transparent}
                onChange={(e) => setTransparent(e.target.checked)}
                style={{ accentColor: 'var(--color-accent)', width: 15, height: 15 }}
              />
              Transparent background
            </label>
          </div>

          {/* --- preview --------------------------------------------------- */}
          <div style={{ marginTop: 'var(--sp-4)' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: 'var(--sp-2)',
              }}
            >
              <span className="field__label" style={{ margin: 0 }}>
                Preview
              </span>
              {previewMeta ? (
                <span
                  className="mono"
                  style={{ fontSize: 'var(--fs-xs)', color: 'var(--color-text-muted)' }}
                >
                  {format === 'png'
                    ? `${previewMeta.pngW} × ${previewMeta.pngH} px`
                    : `${previewMeta.boardW} × ${previewMeta.boardH} units`}{' '}
                  · {formatBytes(previewMeta.bytes)}
                </span>
              ) : null}
            </div>

            <div
              style={{
                position: 'relative',
                display: 'grid',
                placeItems: 'center',
                minHeight: 160,
                maxHeight: 260,
                padding: 'var(--sp-3)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--color-border)',
                overflow: 'hidden',
                // Checkerboard so a transparent export visibly IS transparent.
                background: transparent
                  ? 'var(--color-surface)'
                  : 'var(--color-surface-sunken)',
                backgroundImage: transparent
                  ? 'linear-gradient(45deg, var(--color-border) 25%, transparent 25%), linear-gradient(-45deg, var(--color-border) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--color-border) 75%), linear-gradient(-45deg, transparent 75%, var(--color-border) 75%)'
                  : undefined,
                backgroundSize: transparent ? '16px 16px' : undefined,
                backgroundPosition: transparent ? '0 0, 0 8px, 8px -8px, -8px 0' : undefined,
              }}
            >
              {empty ? (
                <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                  The board is empty — there is nothing to export yet.
                </p>
              ) : previewUrl ? (
                <img
                  src={previewUrl}
                  alt="Export preview"
                  style={{ maxWidth: '100%', maxHeight: 220, objectFit: 'contain' }}
                />
              ) : (
                <p style={{ color: 'var(--color-text-muted)', fontSize: 'var(--fs-sm)' }}>
                  Building preview…
                </p>
              )}
            </div>
          </div>

          {/* --- import ---------------------------------------------------- */}
          <div
            style={{
              marginTop: 'var(--sp-5)',
              paddingTop: 'var(--sp-4)',
              borderTop: '1px solid var(--color-border)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-3)' }}>
              <div style={{ minWidth: 0, flex: '1 1 auto' }}>
                <span className="field__label" style={{ margin: 0 }}>
                  Import a JSON file
                </span>
                <span
                  style={{
                    display: 'block',
                    color: 'var(--color-text-muted)',
                    fontSize: 'var(--fs-xs)',
                    lineHeight: 'var(--lh-xs)',
                  }}
                >
                  Replaces everything currently on this board.
                </span>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => fileRef.current?.click()}
              >
                <IconUpload size={15} />
                Choose file
              </button>
              <input
                ref={fileRef}
                type="file"
                accept="application/json,.json"
                onChange={onPickFile}
                className="sr-only"
                aria-label="Import a JSON file"
              />
            </div>

            {importReport?.ok ? (
              <div
                role="status"
                style={{
                  marginTop: 'var(--sp-3)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-success-soft)',
                  borderLeft: '3px solid var(--color-success)',
                }}
              >
                <p style={{ fontSize: 'var(--fs-sm)', display: 'flex', alignItems: 'center', gap: 6 }}>
                  <IconCheck size={15} />
                  <strong>
                    {importReport.count}{' '}
                    {importReport.count === 1 ? 'element' : 'elements'}
                  </strong>{' '}
                  found in {importReport.filename}
                </p>
                <p
                  style={{
                    marginTop: 'var(--sp-1)',
                    fontSize: 'var(--fs-xs)',
                    color: 'var(--color-text-muted)',
                  }}
                >
                  {Object.entries(importReport.byType)
                    .map(([type, n]) => `${n} ${type}`)
                    .join(' · ')}
                </p>
                {confirmReplace ? (
                  <div style={{ display: 'flex', gap: 'var(--sp-2)', marginTop: 'var(--sp-3)' }}>
                    <button
                      type="button"
                      className="btn btn--danger"
                      onClick={applyImport}
                    >
                      Replace {elements.length} {elements.length === 1 ? 'element' : 'elements'}
                    </button>
                    <button
                      type="button"
                      className="btn btn--ghost"
                      onClick={() => setConfirmReplace(false)}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn btn--primary"
                    style={{ marginTop: 'var(--sp-3)' }}
                    onClick={() => setConfirmReplace(true)}
                  >
                    Replace the board
                  </button>
                )}
              </div>
            ) : importReport?.ok === false ? (
              <div
                role="alert"
                style={{
                  marginTop: 'var(--sp-3)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-danger-soft)',
                  borderLeft: '3px solid var(--color-danger)',
                  color: 'var(--color-danger)',
                  fontSize: 'var(--fs-sm)',
                  display: 'flex',
                  gap: 6,
                  alignItems: 'flex-start',
                }}
              >
                <IconAlert size={15} />
                <span>
                  <strong>That file could not be imported.</strong>
                  <br />
                  {importReport.error}
                  {importReport.index != null
                    ? ' Nothing on the board has been changed.'
                    : ''}
                </span>
              </div>
            ) : null}
          </div>
        </div>

        <div className="panel__footer">
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={runExport}
            disabled={busy || empty}
          >
            <IconDownload size={15} />
            {busy ? 'Working…' : `Download ${format.toUpperCase()}`}
          </button>
        </div>
      </div>
    </div>
  );
}

export default ExportDialog;
