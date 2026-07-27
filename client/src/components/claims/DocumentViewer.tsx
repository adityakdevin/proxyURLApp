import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Finding } from '@/lib/claimTypes';

// Bundle the pdfjs worker via Vite (react-pdf v9 uses pdfjs-dist v4).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface DocumentViewerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  claimId: string;
  documentId: string;
  fileName: string;
  findings: Finding[];
}

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;
const PDF_PAGE_WIDTH = 760;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 5;
const CLICK_ZOOM = 2.5; // zoom level a clicked finding snaps to, so the word is legible
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/** Absolute, normalized-% highlight boxes over a rendered page/image. */
function Highlights({
  findings,
  activeId,
  numberOf,
  onSelect,
}: {
  findings: Finding[];
  activeId: string | null;
  numberOf: Map<string, number>;
  onSelect: (id: string) => void;
}) {
  return (
    <>
      {findings
        .filter((f) => f.bbox)
        .map((f) => {
          const active = f.id === activeId;
          const soft = f.severity !== 'ERROR'; // doubtful / advisory — amber, not red
          // When something is selected, fade the others so the active box stands out.
          const cls = active
            ? 'border-2 border-yellow-500 ring-2 ring-yellow-400 bg-yellow-300/40 animate-pulse z-10'
            : activeId
            ? soft
              ? 'border-2 border-dashed border-amber-500/40 bg-amber-400/10'
              : 'border-2 border-red-500/30 bg-red-500/10'
            : soft
            ? 'border-2 border-dashed border-amber-500 bg-amber-400/20'
            : 'border-2 border-red-500 bg-red-500/20';
          return (
            <div
              key={f.id}
              data-fid={f.id}
              title={f.message}
              onClick={() => onSelect(f.id)}
              className={`absolute cursor-pointer ${cls}`}
              style={{
                left: `${f.bbox!.x * 100}%`,
                top: `${f.bbox!.y * 100}%`,
                width: `${f.bbox!.w * 100}%`,
                height: `${f.bbox!.h * 100}%`,
              }}
            >
              <span
                className={`absolute -top-4 -left-0.5 rounded px-1 text-[10px] font-semibold leading-4 text-white ${
                  active ? 'bg-yellow-600' : soft ? 'bg-amber-500' : 'bg-red-600'
                }`}
              >
                {numberOf.get(f.id)}
              </span>
            </div>
          );
        })}
    </>
  );
}

/**
 * In-app document viewer with highlight overlays. Images and PDFs render with normalized
 * ([0..1]) highlight boxes drawn as CSS % (so they track any rendered size). If PDF
 * rendering fails, it falls back to an iframe. Other file types use the iframe too.
 */
export function DocumentViewer({
  open,
  onOpenChange,
  claimId,
  documentId,
  fileName,
  findings,
}: DocumentViewerProps) {
  const contentUrl = `/api/claims/${claimId}/documents/${documentId}/content`;
  const isImage = IMAGE_RE.test(fileName);
  const isPdf = PDF_RE.test(fileName);
  // Memoize on `findings` so the derived maps below don't rebuild every render
  // (they feed zoom re-renders, which fire rapidly on Ctrl-wheel).
  const boxed = useMemo(() => findings.filter((f) => f.bbox), [findings]);

  // Number every boxed finding so its label on the doc matches its row in the list.
  const numberOf = useMemo(() => {
    const m = new Map<string, number>();
    boxed.forEach((f, i) => m.set(f.id, i + 1));
    return m;
  }, [boxed]);

  // Group boxed findings by page once, instead of re-filtering per page in the render loop.
  const byPage = useMemo(() => {
    const m = new Map<number, Finding[]>();
    boxed.forEach((f) => {
      const p = f.page ?? 1;
      (m.get(p) ?? m.set(p, []).get(p)!).push(f);
    });
    return m;
  }, [boxed]);

  const [numPages, setNumPages] = useState(0);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [missing, setMissing] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pending scroll adjustment so Ctrl-wheel zoom stays anchored under the cursor.
  const anchor = useRef<{ ax: number; ay: number; ratio: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    setNumPages(0);
    setPdfFailed(false);
    setImgFailed(false);
    setImgLoaded(false);
    setZoom(1);
    // Open ON the first mistake instead of at the top of the document — a reviewer
    // opening a Spell Check result wants the first flagged word, not page 1.
    setActiveId(boxed[0]?.id ?? null);
  }, [documentId, boxed]);

  // One HEAD probe tells us the file is gone BEFORE a render branch falls back to an
  // iframe, which would otherwise paint the API's raw {"error":"File not found"} JSON.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch(contentUrl, { method: 'HEAD', credentials: 'include' })
      .then((r) => !cancelled && setMissing(!r.ok))
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [contentUrl, open]);

  // Clicking a finding snaps to a legible zoom, then centers its box.
  const selectFinding = (id: string) => {
    setZoom((z) => Math.max(z, CLICK_ZOOM));
    setActiveId(id);
  };

  // Scroll the selected box to center when it, the zoom, or the page count changes.
  useEffect(() => {
    if (!activeId) return;
    scrollRef.current
      ?.querySelector(`[data-fid="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    // imgLoaded matters: before the image paints, the overlay has no height to scroll to.
  }, [activeId, zoom, numPages, imgLoaded]);

  // Keep the cursor's document point fixed while Ctrl/Cmd-wheel zooming.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const a = anchor.current;
    if (!el || !a) return;
    el.scrollLeft = a.ax * a.ratio - a.cx;
    el.scrollTop = a.ay * a.ratio - a.cy;
    anchor.current = null;
  }, [zoom]);

  // Native non-passive wheel listener (React's onWheel is passive → can't preventDefault).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      setZoom((z) => {
        const nz = clampZoom(z * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
        anchor.current = { ax: cx + el.scrollLeft, ay: cy + el.scrollTop, ratio: nz / z, cx, cy };
        return nz;
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [isImage, isPdf, pdfFailed, imgFailed]);
  // Stable file object so react-pdf doesn't refetch on every render.
  const pdfFile = useMemo(() => ({ url: contentUrl, withCredentials: true }), [contentUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col"
        style={{ width: '95vw', maxWidth: '95vw', height: '95vh' }}
      >
        <DialogHeader>
          <DialogTitle className="truncate">{fileName}</DialogTitle>
        </DialogHeader>

        {!missing && ((isImage && !imgFailed) || (isPdf && !pdfFailed)) && (
          <div className="flex items-center gap-1 text-sm">
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z / 1.2))}
              className="h-7 w-7 rounded border hover:bg-gray-100"
              aria-label="Zoom out"
            >
              −
            </button>
            <span className="w-12 text-center tabular-nums text-gray-600">{Math.round(zoom * 100)}%</span>
            <button
              type="button"
              onClick={() => setZoom((z) => clampZoom(z * 1.2))}
              className="h-7 w-7 rounded border hover:bg-gray-100"
              aria-label="Zoom in"
            >
              +
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="ml-1 h-7 rounded border px-2 hover:bg-gray-100"
            >
              Fit
            </button>
            <span className="ml-2 text-xs text-gray-400">Ctrl/⌘ + scroll to zoom</span>
          </div>
        )}

        {missing ? (
          <p className="p-4 text-sm text-red-600">
            This document could not be opened — the file is no longer readable at its stored
            location on the server. The findings below came from an earlier scan, when the
            file was still there.
          </p>
        ) : isImage && imgFailed ? (
          <p className="p-4 text-sm text-red-600">
            This document is unavailable (the file may be missing on the server).
          </p>
        ) : isImage ? (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
            <div className="relative mx-auto" style={{ width: `${zoom * 100}%`, maxWidth: 'none' }}>
              <img
                src={contentUrl}
                alt={fileName}
                className="block w-full h-auto"
                onLoad={() => setImgLoaded(true)}
                onError={() => setImgFailed(true)}
              />
              <Highlights
                findings={findings}
                activeId={activeId}
                numberOf={numberOf}
                onSelect={selectFinding}
              />
            </div>
          </div>
        ) : isPdf && !pdfFailed ? (
          <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
            <Document
              file={pdfFile}
              onLoadSuccess={(pdf: { numPages: number }) => setNumPages(pdf.numPages)}
              onLoadError={() => setPdfFailed(true)}
              loading={<p className="p-4 text-sm text-gray-500">Loading PDF…</p>}
              error={<p className="p-4 text-sm text-red-600">Could not render PDF.</p>}
            >
              {Array.from({ length: numPages }, (_, i) => {
                const page = i + 1;
                const pageFindings = byPage.get(page) ?? [];
                const pageWidth = PDF_PAGE_WIDTH * zoom;
                return (
                  <div
                    key={page}
                    className="relative mb-3 mx-auto"
                    style={{ width: pageWidth }}
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                    />
                    <Highlights
                      findings={pageFindings}
                      activeId={activeId}
                      numberOf={numberOf}
                      onSelect={selectFinding}
                    />
                  </div>
                );
              })}
            </Document>
          </div>
        ) : (
          <iframe src={contentUrl} title={fileName} className="w-full flex-1 min-h-0 border rounded" />
        )}

        <div className="mt-2 border-t pt-2 shrink-0">
          <p className="text-sm font-medium">
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {(isImage || isPdf) && boxed.length > 0 ? ` · ${boxed.length} highlighted` : ''}
          </p>
          <ul className="mt-1 max-h-32 overflow-auto space-y-0.5 text-xs text-gray-600">
            {findings.map((f) => {
              const active = f.id === activeId;
              return (
                <li key={f.id}>
                  <button
                    type="button"
                    onClick={() => f.bbox && selectFinding(f.id)}
                    disabled={!f.bbox}
                    className={`flex w-full items-start gap-1.5 rounded px-1 py-0.5 text-left ${
                      active ? 'bg-yellow-100' : f.bbox ? 'cursor-pointer hover:bg-gray-100' : 'cursor-default'
                    }`}
                  >
                    {f.bbox ? (
                      <span
                        className={`mt-px inline-flex h-4 min-w-4 items-center justify-center rounded px-1 text-[10px] font-semibold text-white ${
                          active ? 'bg-yellow-600' : f.severity !== 'ERROR' ? 'bg-amber-500' : 'bg-red-600'
                        }`}
                      >
                        {numberOf.get(f.id)}
                      </span>
                    ) : (
                      <span className="mt-px text-gray-400">—</span>
                    )}
                    <span>
                      {f.message}
                      {f.page ? ` (page ${f.page})` : ''}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
