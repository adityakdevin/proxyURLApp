import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Document, Page, pdfjs } from 'react-pdf';
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
  /** Scroll to this 1-based page when it changes. Bump `gotoNonce` to re-issue the same
   *  page (clicking "Page 3" twice must scroll back both times). */
  gotoPage?: number | null;
  gotoNonce?: number;
  /** Selection is owned by the page, because the findings list lives in the sidebar while
   *  the highlight boxes live here — both have to agree on which finding is active. */
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Bumped by the page each time the reviewer PICKS a finding. Only a bump zooms in —
   *  the auto-selection of the first finding must leave the document at 100%. */
  selectNonce?: number;
  /** Finding id → badge number, so the number on the page matches the sidebar row. */
  numberOf: Map<string, number>;
}

const IMAGE_RE = /\.(png|jpe?g|gif|bmp|webp|tiff?)$/i;
const PDF_RE = /\.pdf$/i;
// Floor only. At zoom 1 a page fills the container instead of sitting at a fixed 760px with
// dead margin either side — the reason the document looked small in a wide window.
const PDF_MIN_PAGE_WIDTH = 320;
const PDF_PAGE_GUTTER = 16;
// 0.5 was too high a floor on a bundle: at 100% one page already fills the container, so a
// reviewer skimming an 8-page claim could not pull back far enough to see a page whole.
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 5;
const CLICK_ZOOM = 2.5; // zoom level a clicked finding snaps to, so the word is legible
const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

// Word boxes come back tight against the glyphs, which reads as a cramped sticker stuck to
// the word. Padding them out — proportionally, so it scales with the text size — makes the
// highlight legible without hiding the characters underneath.
const BOX_PAD_X = 0.35; // × the box's own width
const BOX_PAD_Y = 0.45; // × the box's own height
const pct = (v: number) => `${Math.max(0, Math.min(1, v)) * 100}%`;

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
          // Severity owns the colour in every state. The selected box used to turn yellow,
          // which lost the one thing the reviewer is deciding on: is this a red flag or
          // only an advisory? Selection is shown with a ring and a pulse instead.
          // Outline only, never a fill: a tint over the word is exactly what the reviewer is
          // trying to read, and on a scanned page it turns grey text to mud.
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
          const { x, y, w, h } = f.bbox!;
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
  // Counts pages whose canvas has actually painted. react-pdf reports numPages long
  // before it renders them, and until a page paints its container is ~0px tall — so a
  // scroll issued at that moment lands at the top of the document instead of on the
  // finding. Re-running the scroll as each page paints is what makes "jump to the first
  // mistake" work on a multi-page bundle, where the flagged page is typically page 5+.
  const [renderedPages, setRenderedPages] = useState(0);
  const [missing, setMissing] = useState(false);
  // Width the scroll container gives us, so a page can fill it. Re-measured on resize
  // because this view lives in a tab the reviewer resizes freely.
  const [fitWidth, setFitWidth] = useState(0);
  const [zoom, setZoom] = useState(1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Pending scroll adjustment so Ctrl-wheel zoom stays anchored under the cursor.
  const anchor = useRef<{ ax: number; ay: number; ratio: number; cx: number; cy: number } | null>(null);

  useEffect(() => {
    setNumPages(0);
    setPdfFailed(false);
    setImgFailed(false);
    setImgLoaded(false);
    setRenderedPages(0);
    setZoom(1);
  }, [documentId]);

  // One HEAD probe tells us the file is gone BEFORE a render branch falls back to an
  // iframe, which would otherwise paint the API's raw {"error":"File not found"} JSON.
  useEffect(() => {
    let cancelled = false;
    fetch(contentUrl, { method: 'HEAD', credentials: 'include' })
      .then((r) => !cancelled && setMissing(!r.ok))
      .catch(() => !cancelled && setMissing(true));
    return () => {
      cancelled = true;
    };
  }, [contentUrl]);

  // CLICKING a finding snaps to a legible zoom, then centers its box. Keyed on the caller's
  // pick counter, not on activeId: the document also auto-selects its first finding (on open,
  // and again whenever the check filter re-derives the list), and landing at 250% with no
  // click behind it reads as the viewer being broken.
  const lastPick = useRef(selectNonce);
  useEffect(() => {
    if (selectNonce === lastPick.current) return;
    lastPick.current = selectNonce;
    setZoom((z) => Math.max(z, CLICK_ZOOM));
  }, [selectNonce]);

  // Scroll the selected box to center when it, the zoom, or the page count changes.
  useEffect(() => {
    if (!activeId) return;
    scrollRef.current
      ?.querySelector(`[data-fid="${CSS.escape(activeId)}"]`)
      ?.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    // imgLoaded / renderedPages matter: before the page paints, the overlay has no
    // height to scroll to, so the scroll has to be re-issued once it does.
  }, [activeId, zoom, numPages, imgLoaded, renderedPages]);

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
    // renderedPages: a page that has not painted yet has no height to scroll to.
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
            <button
              type="button"
              onClick={() => setZoom(1)}
              className="h-7 rounded-md border px-2.5 text-xs text-gray-600 hover:bg-gray-100"
            >
              Reset
            </button>
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
                onSelect={onSelect}
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
                const pageWidth = Math.max(PDF_MIN_PAGE_WIDTH, fitWidth - PDF_PAGE_GUTTER) * zoom;
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
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                      onRenderSuccess={() => setRenderedPages((n) => n + 1)}
                    />
                    <Highlights
                      findings={pageFindings}
                      activeId={activeId}
                      numberOf={numberOf}
                      onSelect={onSelect}
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
