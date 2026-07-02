import { useEffect, useMemo, useState } from 'react';
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

/** Absolute, normalized-% highlight boxes over a rendered page/image. */
function Highlights({ findings }: { findings: Finding[] }) {
  return (
    <>
      {findings
        .filter((f) => f.bbox)
        .map((f) => (
          <div
            key={f.id}
            title={f.message}
            className="absolute border-2 border-red-500 bg-red-500/20"
            style={{
              left: `${f.bbox!.x * 100}%`,
              top: `${f.bbox!.y * 100}%`,
              width: `${f.bbox!.w * 100}%`,
              height: `${f.bbox!.h * 100}%`,
            }}
          />
        ))}
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
  const boxed = findings.filter((f) => f.bbox);

  const [numPages, setNumPages] = useState(0);
  const [pdfFailed, setPdfFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  useEffect(() => {
    setNumPages(0);
    setPdfFailed(false);
    setImgFailed(false);
  }, [documentId]);
  // Stable file object so react-pdf doesn't refetch on every render.
  const pdfFile = useMemo(() => ({ url: contentUrl, withCredentials: true }), [contentUrl]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle className="truncate">{fileName}</DialogTitle>
        </DialogHeader>

        {isImage && imgFailed ? (
          <p className="p-4 text-sm text-red-600">
            This document is unavailable (the file may be missing on the server).
          </p>
        ) : isImage ? (
          <div className="max-h-[65vh] overflow-auto">
            <div className="relative inline-block">
              <img
                src={contentUrl}
                alt={fileName}
                className="block max-w-full h-auto"
                onError={() => setImgFailed(true)}
              />
              <Highlights findings={findings} />
            </div>
          </div>
        ) : isPdf && !pdfFailed ? (
          <div className="max-h-[65vh] overflow-auto">
            <Document
              file={pdfFile}
              onLoadSuccess={(pdf: { numPages: number }) => setNumPages(pdf.numPages)}
              onLoadError={() => setPdfFailed(true)}
              loading={<p className="p-4 text-sm text-gray-500">Loading PDF…</p>}
              error={<p className="p-4 text-sm text-red-600">Could not render PDF.</p>}
            >
              {Array.from({ length: numPages }, (_, i) => {
                const page = i + 1;
                const pageFindings = boxed.filter((f) => (f.page ?? 1) === page);
                return (
                  <div key={page} className="relative mb-3 inline-block">
                    <Page
                      pageNumber={page}
                      width={PDF_PAGE_WIDTH}
                      renderTextLayer={false}
                      renderAnnotationLayer={false}
                    />
                    <Highlights findings={pageFindings} />
                  </div>
                );
              })}
            </Document>
          </div>
        ) : (
          <iframe src={contentUrl} title={fileName} className="w-full h-[65vh] border rounded" />
        )}

        <div className="mt-2 border-t pt-2">
          <p className="text-sm font-medium">
            {findings.length} finding{findings.length === 1 ? '' : 's'}
            {(isImage || isPdf) && boxed.length > 0 ? ` · ${boxed.length} highlighted` : ''}
          </p>
          <ul className="mt-1 max-h-32 overflow-auto space-y-0.5 text-xs text-gray-600">
            {findings.map((f) => (
              <li key={f.id}>
                {f.bbox ? '◉ ' : '• '}
                {f.message}
                {f.page ? ` (page ${f.page})` : ''}
              </li>
            ))}
          </ul>
        </div>
      </DialogContent>
    </Dialog>
  );
}
