import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
import { RotateCcw, RotateCw } from 'lucide-react';
import { Finding } from '@/lib/claimTypes';

// Bundle the pdfjs worker via Vite (react-pdf v9 uses pdfjs-dist v4).
pdfjs.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.min.mjs',
  import.meta.url
).toString();

interface DocumentViewerProps {
  claimId: string;
  documentId: string;
  fileName: string;
  findings: Finding[];
  gotoPage?: number | null;
  gotoNonce?: number;
  activeId: string | null;
  onSelect: (id: string) => void;
  selectNonce?: number;
  numberOf: Map<string, number>;
}

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;
const PDF_MIN_PAGE_WIDTH = 320;
const PDF_PAGE_GUTTER = 16;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const CLICK_ZOOM = 2.5; 
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
const BOX_PAD_X = 0.35; 
const BOX_PAD_Y = 0.45; 
const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

type Box = { x: number; y: number; w: number; h: number };
function rotateBox({ x, y, w, h }: Box, deg: number): Box {
  if (deg === 90) return { x: 1 - y - h, y: x, w: h, h: w };
  if (deg === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  if (deg === 270) return { x: y, y: 1 - x - w, w: h, h: w };
  return { x, y, w, h };
}

/** Absolute, normalized-% highlight boxes over a rendered page/image. */
function Highlights({
  findings,
  activeId,
  numberOf,
  onSelect,
  rotation = 0,
}: {
  findings: Finding[];
  activeId: string | null;
  numberOf: Map<string, number>;
  onSelect: (id: string) => void;
  rotation?: number;
}) {
  return (
    <>
      {findings
        .filter((f) => f.bbox)
        .map((f) => {
          const active = f.id === activeId;
          const soft = f.severity !== 'ERROR'; // doubtful / advisory — amber, not red
          const cls = active
            ? soft
              ? 'border-2 border-amber-500 ring-2 ring-amber-300/70 z-10'
              : 'border-2 border-red-600 ring-2 ring-red-300/70 z-10'
            : activeId
            ? // Something else is selected — fade this one so the active box stands out.
              soft
              ? 'border-2 border-dashed border-amber-500/40'
              : 'border-2 border-red-500/40'
            : soft
            ? 'border-2 border-dashed border-amber-500'
            : 'border-2 border-red-500';
          const { x, y, w, h } = rotateBox(f.bbox!, rotation);
          const padX = w * BOX_PAD_X;
          const padY = h * BOX_PAD_Y;
          return (
            <div
              key={f.id}
              data-fid={f.id}
              title={f.message}
              onClick={() => onSelect(f.id)}
              className={`absolute cursor-pointer rounded-sm ${cls}`}
              style={{
                left: pct(x - padX),
                top: pct(y - padY),
                width: pct(w + padX * 2),
                height: pct(h + padY * 2),
              }}
            >
              <span
                className={`absolute -top-4 -left-0.5 rounded px-1 text-[10px] font-semibold leading-4 text-white ${
                  soft ? 'bg-amber-500' : 'bg-red-600'
                } ${active ? 'ring-1 ring-white' : ''}`}
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
 * Document viewer with highlight overlays, sized to fill whatever container holds it.
 * Images and PDFs render with normalized ([0..1]) highlight boxes drawn as CSS % (so they
 * track any rendered size). If PDF rendering fails, it falls back to an iframe. Other file
 * types use the iframe too.
 *
 * Rendered by the standalone /claims/:id/documents/:documentId window — a reviewer needs
 * the document open beside the claim form, which a modal cannot do.
 */
export function DocumentViewerPanel({
  claimId,
  documentId,
  fileName,
  findings,
  gotoPage,
  gotoNonce,
  activeId,
  onSelect,
  selectNonce = 0,
  numberOf,
}: DocumentViewerProps) {
  const contentUrl = `/api/claims/${claimId}/documents/${documentId}/content`;
  const isImage = IMAGE_RE.test(fileName);
  const isPdf = PDF_RE.test(fileName);
  // Memoize on `findings` so the derived maps below don't rebuild every render
  // (they feed zoom re-renders, which fire rapidly on Ctrl-wheel).
  const boxed = useMemo(() => findings.filter((f) => f.bbox), [findings]);

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
  const [renderedPages, setRenderedPages] = useState(0);
  const [missing, setMissing] = useState(false);
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [imgSize, setImgSize] = useState({ w: 0, h: 0 });
  const scrollRef = useRef<HTMLDivElement>(null);
  const anchor = useRef<{ ax: number; ay: number; ratio: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    setNumPages(0);
    setPdfFailed(false);
    setImgFailed(false);
    setImgLoaded(false);
    setRenderedPages(0);
    setZoom(1);
    setRotation(0);
    setImgSize({ w: 0, h: 0 });
  }, [documentId]);

  useEffect(() => {
    let cancelled = false;
    fetch(contentUrl, { method: 'HEAD', credentials: 'include' })
      .then((r) => !cancelled && setMissing(!r.ok))
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  const lastPick = useRef(selectNonce);
  useEffect(() => {
    if (selectNonce === lastPick.current) return;
    lastPick.current = selectNonce;
    setZoom((z) => Math.max(z, CLICK_ZOOM));
  }, [selectNonce]);

  useEffect(() => {
    if (!activeId) return;
    scrollRef.current
      ?.querySelector(`[data-fid="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
  }, [activeId, zoom, rotation, numPages, imgLoaded, renderedPages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setFitWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isImage, isPdf, pdfFailed, imgFailed, missing]);

  // Jump to a page on request (a field group's "Page 3" chip). Clearing the active finding
  // first stops the finding-scroll effect from yanking the view straight back to it.
  useEffect(() => {
    if (!gotoPage) return;
    scrollRef.current
      ?.querySelector(`[data-page="${gotoPage}"]`)
      ?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [gotoPage, gotoNonce, renderedPages]);

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

  const contentWidth = Math.max(PDF_MIN_PAGE_WIDTH, fitWidth - PDF_PAGE_GUTTER) * zoom;
  const swapped = rotation % 180 !== 0;
  const imgRatio = imgSize.w && imgSize.h ? imgSize.h / imgSize.w : 0;
  const imgW = swapped && imgRatio ? contentWidth / imgRatio : contentWidth;
  const imgH = imgW * imgRatio;

  return (
    <div className="flex h-full min-h-0 flex-col">
        {!missing && ((isImage && !imgFailed) || (isPdf && !pdfFailed)) && (
          <div className="mb-2 flex shrink-0 items-center gap-2 border-b pb-2 text-sm">
            <div className="flex items-center overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => setZoom((z) => clampZoom(z / 1.2))}
                className="h-7 w-7 text-gray-600 hover:bg-gray-100"
                aria-label="Zoom out"
              >
                −
              </button>
              <span className="w-14 border-x py-0.5 text-center text-xs tabular-nums text-gray-600">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => setZoom((z) => clampZoom(z * 1.2))}
                className="h-7 w-7 text-gray-600 hover:bg-gray-100"
                aria-label="Zoom in"
              >
                +
              </button>
            </div>
            <div className="flex items-center overflow-hidden rounded-md border">
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 270) % 360)}
                className="flex h-7 w-7 items-center justify-center text-gray-600 hover:bg-gray-100"
                aria-label="Rotate anticlockwise"
                title="Rotate anticlockwise"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => setRotation((r) => (r + 90) % 360)}
                className="flex h-7 w-7 items-center justify-center border-l text-gray-600 hover:bg-gray-100"
                aria-label="Rotate clockwise"
                title="Rotate clockwise"
              >
                <RotateCw className="h-3.5 w-3.5" />
              </button>
            </div>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setRotation(0);
              }}
              className="h-7 rounded-md border px-2.5 text-xs text-gray-600 hover:bg-gray-100"
            >
              Reset
            </button>
            {rotation !== 0 && (
              <span className="text-xs tabular-nums text-gray-500">{rotation}°</span>
            )}
            {numPages > 0 && (
              <span className="text-xs tabular-nums text-gray-500">
                {numPages} page{numPages === 1 ? '' : 's'}
              </span>
            )}
            <span className="ml-auto text-xs text-gray-400">Ctrl/⌘ + scroll to zoom</span>
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
            <div
              className="relative mx-auto"
              style={{
                width: swapped ? imgH : imgW,
                height: swapped ? imgW : imgH,
                maxWidth: 'none',
              }}
            >
              <img
                src={contentUrl}
                alt={fileName}
                className="absolute left-1/2 top-1/2 block"
                style={{
                  width: imgW,
                  height: imgH || 'auto',
                  transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
                }}
                onLoad={(e) => {
                  const el = e.currentTarget;
                  setImgSize({ w: el.naturalWidth, h: el.naturalHeight });
                  setImgLoaded(true);
                }}
                onError={() => setImgFailed(true)}
              />
              <Highlights
                findings={findings}
                activeId={activeId}
                numberOf={numberOf}
                onSelect={onSelect}
                rotation={rotation}
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
                const pageWidth = contentWidth;
                return (
                  <div
                    key={page}
                    data-page={page}
                    className="relative mb-3 mx-auto"
                    style={{ width: pageWidth }}
                  >
                    <Page
                      pageNumber={page}
                      width={pageWidth}
                      rotate={rotation === 0 ? undefined : rotation}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onRenderSuccess={() => setRenderedPages((n) => n + 1)}
                    />
                    <Highlights
                      findings={pageFindings}
                      activeId={activeId}
                      numberOf={numberOf}
                      onSelect={onSelect}
                      rotation={rotation}
                    />
                  </div>
                );
              })}
            </Document>
          </div>
        ) : (
          <iframe src={contentUrl} title={fileName} className="w-full flex-1 min-h-0 border rounded" />
        )}

    </div>
  );
}
