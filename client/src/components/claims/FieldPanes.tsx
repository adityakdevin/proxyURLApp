import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  ChevronsDownUp,
  ChevronsUpDown,
  CornerDownLeft,
  Copy,
  FileText,
  ListChecks,
  Search,
} from 'lucide-react';
import { Finding } from '@/lib/claimTypes';
import { copyText } from '@/lib/utils';
import { QrDataList, QrEntry } from '@/components/claims/QrDataList';

/**
 * Copy one line to the clipboard, with a tick to confirm it landed.
 *
 * Copy-per-line is what the client asked for in the 28 Jul review. The viewer renders the
 * PDF to a canvas, so there is no selectable text there — copying off the extracted value
 * or the finding message is the affordance that actually works.
 */
function CopyButton({ text, what }: { text: string; what: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={(e) => {
        // The finding row wraps this in its own click target; without this the copy would
        // also re-select the finding and scroll the document.
        e.stopPropagation();
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      title={`Copy ${what}`}
      aria-label={`Copy ${what}`}
      className="shrink-0 rounded p-1 text-gray-400 opacity-0 transition hover:bg-gray-200 hover:text-gray-700 focus:opacity-100 group-hover:opacity-100"
    >
      {copied ? <Check className="h-3.5 w-3.5 text-green-600" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

/** Severity buckets the filter offers. ERROR and WARNING are what the validators emit;
 *  INFO findings are notes that a check ran and sit under "All". */
type SevFilter = 'ALL' | 'ERROR' | 'WARNING';

/**
 * The findings list, which used to sit under the document and stole vertical space from it.
 * Clicking a row zooms the viewer to that highlight.
 *
 * A spell check on a bundle routinely returns 30+ findings, so the list is grouped by page,
 * filterable by severity, and steppable — a flat scroll of 29 identical amber rows is not
 * something a reviewer can work through.
 */
function FindingsCard({
  findings,
  numberOf,
  activeId,
  onSelect,
  onJumpToPage,
  capHeight,
}: {
  findings: Finding[];
  numberOf: Map<string, number>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onJumpToPage?: (page: number) => void;
  /** Cap the list so the field cards below it stay reachable. Off when findings are the
   *  whole panel — a cap there cuts the list mid-row and leaves the rest of the panel blank. */
  capHeight?: boolean;
}) {
  const [sev, setSev] = useState<SevFilter>('ALL');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(true);

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter(
      (f) => (sev === 'ALL' || f.severity === sev) && (!q || f.message.toLowerCase().includes(q))
    );
  }, [findings, sev, query]);

  // Page groups, in page order, with un-paged findings last under "Document".
  const byPage = useMemo(() => {
    const m = new Map<number | null, Finding[]>();
    for (const f of visible) {
      const k = f.page ?? null;
      const list = m.get(k);
      if (list) list.push(f);
      else m.set(k, [f]);
    }
    return [...m.entries()].sort((a, b) => (a[0] ?? Infinity) - (b[0] ?? Infinity));
  }, [visible]);

  // Stepper: walk the visible list in order, wrapping at both ends.
  const step = (delta: number) => {
    const boxed = visible.filter((f) => f.bbox);
    if (boxed.length === 0) return;
    const i = boxed.findIndex((f) => f.id === activeId);
    onSelect(boxed[(i + delta + boxed.length) % boxed.length].id);
  };

  const position = (() => {
    const boxed = visible.filter((f) => f.bbox);
    const i = boxed.findIndex((f) => f.id === activeId);
    return i >= 0 ? `${i + 1}/${boxed.length}` : `${boxed.length}`;
  })();

  const chip = (key: SevFilter, label: string, count: number, tone: string) => (
    <button
      type="button"
      onClick={() => setSev(key)}
      className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
        sev === key ? tone : 'text-gray-500 hover:bg-gray-100'
      }`}
    >
      {label} {count}
    </button>
  );

  return (
    <section className="mb-3 flex min-h-0 flex-col overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <header className="flex items-center gap-2 border-b bg-gray-50/80 px-3 py-2">
        <ListChecks className="h-3.5 w-3.5 text-gray-400" />
        <span className="text-xs font-semibold uppercase tracking-wide text-gray-600">Findings</span>
        <span className="rounded-full bg-gray-100 px-1.5 text-[11px] font-semibold tabular-nums text-gray-600">
          {findings.length}
        </span>

        <div className="ml-auto flex items-center gap-0.5">
          {open && findings.some((f) => f.bbox) && (
            <>
              <span className="mr-1 text-[11px] tabular-nums text-gray-400">{position}</span>
            <button
              type="button"
              onClick={() => step(-1)}
              title="Previous finding"
              aria-label="Previous finding"
              className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
            >
              <ChevronUp className="h-3.5 w-3.5" />
            </button>
              <button
                type="button"
                onClick={() => step(1)}
                title="Next finding"
                aria-label="Next finding"
                className="rounded p-0.5 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
              >
                <ChevronDown className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          {/* Double chevron, not single: the single ones directly to its left step THROUGH
              the findings, and two controls that look alike but do different things is how a
              reviewer ends up scrolling the document when they meant to fold the list. */}
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            title={open ? 'Collapse the findings list' : 'Expand the findings list'}
            aria-expanded={open}
            className="-mr-1 rounded p-0.5 text-gray-400 transition hover:bg-gray-200 hover:text-gray-700"
          >
            {open ? <ChevronsDownUp className="h-3.5 w-3.5" /> : <ChevronsUpDown className="h-3.5 w-3.5" />}
            <span className="sr-only">{open ? 'Collapse' : 'Expand'} findings</span>
          </button>
        </div>
      </header>

      {/* Filters only appear when they would actually narrow something down. */}
      {open && findings.length > 5 && (
        <div className="flex items-center gap-1 border-b bg-white px-2 py-1.5">
          {chip('ALL', 'All', findings.length, 'bg-gray-200 text-gray-800')}
          {errors > 0 && chip('ERROR', 'Red flags', errors, 'bg-red-100 text-red-700')}
          {warnings > 0 && chip('WARNING', 'Advisory', warnings, 'bg-amber-100 text-amber-700')}
          <div className="relative ml-auto">
            <Search className="pointer-events-none absolute left-1.5 top-1.5 h-3 w-3 text-gray-300" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter…"
              aria-label="Filter findings"
              className="w-24 rounded border border-gray-200 py-0.5 pl-6 pr-1 text-[11px] focus:w-32 focus:outline-none focus:ring-1 focus:ring-blue-300"
            />
          </div>
        </div>
      )}

      {!open ? null : findings.length === 0 ? (
        <p className="px-3 py-3 text-xs text-gray-400">Nothing flagged on this document for this check.</p>
      ) : visible.length === 0 ? (
        <p className="px-3 py-3 text-xs text-gray-400">No finding matches this filter.</p>
      ) : (
        // No horizontal padding: rows run edge to edge so a selected row fills the card.
        <div className={`overflow-auto pb-1 ${capHeight ? 'max-h-[26rem]' : ''}`}>
          {byPage.map(([page, list]) => (
            <div key={page ?? 'none'} className="group/page">
              {/* Sticky, so the reviewer always knows which page the rows below are on.
                  Also the fastest way to get the document to that page. */}
              <button
                type="button"
                disabled={!page || !onJumpToPage}
                onClick={() => page && onJumpToPage?.(page)}
                title={page && onJumpToPage ? `Scroll the document to page ${page}` : undefined}
                className={`sticky top-0 z-10 flex w-full items-center gap-1 border-b border-gray-100 bg-white/95 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wide backdrop-blur ${
                  page && onJumpToPage
                    ? 'cursor-pointer text-gray-500 hover:bg-blue-50 hover:text-blue-600'
                    : 'cursor-default text-gray-400'
                }`}
              >
                {page ? `Page ${page}` : 'Document'}
                <span className="text-gray-300">·</span>
                <span className="tabular-nums">{list.length}</span>
                {page && onJumpToPage && <CornerDownLeft className="ml-auto h-3 w-3 opacity-0 group-hover/page:opacity-100" />}
              </button>
              <ul className="divide-y divide-gray-50">
                {list.map((f) => {
                  const active = f.id === activeId;
                  return (
                    // The copy button cannot nest inside the select button (invalid HTML, and
                    // the click would do both), so the row is a flex holding the two.
                    <li
                      key={f.id}
                      // Full-bleed row with a left accent bar for the selection. Selected is
                      // blue, not yellow: on this screen colour means severity, so the
                      // selection tint must not read as a third severity.
                      className={`group flex items-start gap-1 border-l-4 pr-2 transition-colors ${
                        active
                          ? 'border-blue-600 bg-blue-100/80 shadow-inner'
                          : 'border-transparent hover:border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <button
                        type="button"
                        // No box (a long address, or a page read without word coordinates)
                        // still has a page: going there beats a dead row.
                        onClick={() =>
                          f.bbox ? onSelect(f.id) : f.page && onJumpToPage?.(f.page)
                        }
                        disabled={!f.bbox && !(f.page && onJumpToPage)}
                        title={
                          f.bbox
                            ? 'Zoom to this on the document'
                            : f.page && onJumpToPage
                            ? `Scroll the document to page ${f.page}`
                            : undefined
                        }
                        className={`flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-xs leading-snug ${
                          active
                            ? 'font-semibold text-blue-950'
                            : f.bbox || (f.page && onJumpToPage)
                            ? 'cursor-pointer text-gray-600'
                            : 'cursor-default text-gray-500'
                        }`}
                      >
                        {f.bbox ? (
                          <span
                            // Same colour as the box on the document, in every state.
                            className={`mt-px inline-flex h-4 min-w-4 shrink-0 items-center justify-center rounded px-1 text-[10px] font-semibold text-white ${
                              f.severity !== 'ERROR' ? 'bg-amber-500' : 'bg-red-600'
                            } ${active ? 'ring-2 ring-blue-500 ring-offset-1' : ''}`}
                          >
                            {numberOf.get(f.id)}
                          </span>
                        ) : (
                          <span className="mt-px shrink-0 text-gray-300">—</span>
                        )}
                        <span className="min-w-0 break-words">{f.message}</span>
                      </button>
                      <span className="pt-1">
                        <CopyButton text={f.message} what="this finding" />
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Everything about the document that is not the document: its findings and, on the QR
 * check, the decoded QR codes — rendered by the same component as the claim page's
 * "View QR Data" dialog, so the two screens always show the same details.
 */
export function FieldPanes({
  qrEntries,
  findings,
  numberOf,
  activeId,
  onSelect,
  onJumpToPage,
  showFields,
}: {
  /** QR codes decoded from this document. */
  qrEntries: QrEntry[];
  findings: Finding[];
  numberOf: Map<string, number>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onJumpToPage?: (page: number) => void;
  showFields: boolean;
}) {
  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-gray-200 bg-gray-50">
      <header className="flex items-center gap-2 rounded-t-lg border-b bg-white px-3 py-2.5">
        <FileText className="h-4 w-4 text-gray-400" />
        <h2 className="text-sm font-semibold text-gray-800">{showFields ? 'QR Data' : 'Findings'}</h2>
        {showFields && qrEntries.length > 0 && (
          <span className="ml-auto text-xs text-gray-400">
            {qrEntries.length} QR code{qrEntries.length === 1 ? '' : 's'}
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* On the QR view the QR data is the point, so an empty findings card is pure noise
            and it is hidden. On every other check the findings ARE the panel, so the empty
            state has to stay — otherwise the panel would render blank with no explanation. */}
        {(!showFields || findings.length > 0) && (
          <FindingsCard
            findings={findings}
            numberOf={numberOf}
            activeId={activeId}
            onSelect={onSelect}
            onJumpToPage={onJumpToPage}
            capHeight={showFields}
          />
        )}

        {showFields &&
          (qrEntries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center">
              <FileText className="mx-auto mb-2 h-6 w-6 text-gray-300" />
              <p className="text-sm font-medium text-gray-600">No QR code found</p>
              <p className="mt-1 text-xs text-gray-400">
                No QR code was read from this document. PAN and Aadhaar Secure QR codes are
                encrypted by the issuer and cannot be read in-app. Run Validate on the claim if it
                has not been scanned yet.
              </p>
            </div>
          ) : (
            <section className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm">
              <QrDataList entries={qrEntries} onJumpToPage={onJumpToPage} />
            </section>
          ))}
      </div>
    </div>
  );
}
