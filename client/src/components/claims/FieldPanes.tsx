import { useMemo, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronUp,
  CornerDownLeft,
  Copy,
  FileText,
  ListChecks,
  Search,
} from 'lucide-react';
import { Finding } from '@/lib/claimTypes';

export interface DocField {
  label: string;
  value: string | null;
}

export type FieldDocType = 'PAN' | 'AADHAR' | 'INVOICE' | 'INSURANCE';

export interface FieldGroup {
  type: FieldDocType;
  /** 1-based pages this group came from; empty for a claim validated before page texts
   *  were stored, where the whole file yields one group. */
  pages: number[];
  fields: DocField[];
}

const TYPE_LABEL: Record<FieldDocType, string> = {
  PAN: 'PAN Card',
  AADHAR: 'Aadhaar',
  INVOICE: 'Invoice',
  INSURANCE: 'Insurance Policy',
};

// One accent per document type, so a reviewer scanning a long bundle finds the section they
// want by colour before they read the heading.
const TYPE_ACCENT: Record<FieldDocType, string> = {
  PAN: 'bg-violet-50 text-violet-700 ring-violet-200',
  AADHAR: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
  INVOICE: 'bg-sky-50 text-sky-700 ring-sky-200',
  INSURANCE: 'bg-amber-50 text-amber-700 ring-amber-200',
};

/** Values that are identifiers read better in a monospace face — digits stop wobbling and
 *  a transposed character is visible at a glance. */
const isIdentifier = (label: string) => /number|no\b|id\b|vid|chassis|engine|policy|pan/i.test(label);

const pageRange = (pages: number[]): string | null => {
  if (pages.length === 0) return null;
  if (pages.length === 1) return `Page ${pages[0]}`;
  return `Pages ${pages[0]}–${pages[pages.length - 1]}`;
};

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
        void navigator.clipboard.writeText(text).then(() => {
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

/** One field row: label, value, and a copy button on hover. */
function FieldRow({ label, value }: DocField) {
  return (
    <div className="group flex items-start gap-3 border-b border-gray-100 py-2 last:border-0">
      <span className="w-28 shrink-0 pt-0.5 text-xs font-medium text-gray-500">{label}</span>
      {value ? (
        <>
          {/* Identifiers get a smaller monospace face rather than a mid-token line break:
              "UK401K20250020 / 4" split across two lines reads as two different numbers,
              which is the one thing a reviewer comparing IDs must not see. */}
          <span
            className={`min-w-0 flex-1 break-words text-sm text-gray-900 ${
              isIdentifier(label) ? 'font-mono text-[13px] leading-5 tracking-tight' : ''
            }`}
          >
            {value}
          </span>
          <CopyButton text={value} what={label} />
        </>
      ) : (
        // Absent fields stay visible — "the document does not carry this" is information —
        // but muted, so they never compete with the values that are actually there.
        <span className="flex-1 text-sm italic text-gray-300">Not found</span>
      )}
    </div>
  );
}

function GroupCard({ group, onJumpToPage }: { group: FieldGroup; onJumpToPage?: (page: number) => void }) {
  const range = pageRange(group.pages);
  const filled = group.fields.filter((f) => f.value).length;

  return (
    <section className="mb-3 overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
      <header className="flex items-center gap-2 border-b bg-gray-50/80 px-3 py-2">
        <span className={`rounded px-2 py-0.5 text-xs font-semibold ring-1 ${TYPE_ACCENT[group.type]}`}>
          {TYPE_LABEL[group.type] ?? group.type}
        </span>
        {range &&
          (onJumpToPage ? (
            <button
              type="button"
              onClick={() => onJumpToPage(group.pages[0])}
              className="rounded px-1.5 py-0.5 text-xs text-blue-600 hover:bg-blue-50 hover:underline"
              title="Scroll the document to this page"
            >
              {range}
            </button>
          ) : (
            <span className="text-xs text-gray-500">{range}</span>
          ))}
        <span className="ml-auto text-xs tabular-nums text-gray-400">
          {filled}/{group.fields.length} read
        </span>
      </header>
      <div className="px-3 py-1">
        {group.fields.map((f) => (
          <FieldRow key={f.label} {...f} />
        ))}
      </div>
    </section>
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
}: {
  findings: Finding[];
  numberOf: Map<string, number>;
  activeId: string | null;
  onSelect: (id: string) => void;
  onJumpToPage?: (page: number) => void;
}) {
  const [sev, setSev] = useState<SevFilter>('ALL');
  const [query, setQuery] = useState('');

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

        {findings.some((f) => f.bbox) && (
          <div className="ml-auto flex items-center gap-0.5">
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
          </div>
        )}
      </header>

      {/* Filters only appear when they would actually narrow something down. */}
      {findings.length > 5 && (
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

      {findings.length === 0 ? (
        <p className="px-3 py-3 text-xs text-gray-400">Nothing flagged on this document for this check.</p>
      ) : visible.length === 0 ? (
        <p className="px-3 py-3 text-xs text-gray-400">No finding matches this filter.</p>
      ) : (
        // No horizontal padding: rows run edge to edge so a selected row fills the card.
        <div className="max-h-[26rem] overflow-auto pb-1">
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
                        onClick={() => f.bbox && onSelect(f.id)}
                        disabled={!f.bbox}
                        title={f.bbox ? 'Zoom to this on the document' : undefined}
                        className={`flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left text-xs leading-snug ${
                          active
                            ? 'font-semibold text-blue-950'
                            : f.bbox
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
 * Everything about the document that is not the document: its findings, and the fields read
 * off it — one card per document type, because a claim document is routinely a bundle
 * (invoice, then policy, then PAN, then Aadhaar in one PDF).
 *
 * No DMS or digital-verification pane. There is no DMS feed in this system, and PAN and
 * Aadhaar QR payloads are issuer-encrypted, so nothing could populate a verification
 * column — both rendered a permanent placeholder and were removed.
 */
export function FieldPanes({
  groups,
  findings,
  numberOf,
  activeId,
  onSelect,
  onJumpToPage,
  showFields,
}: {
  groups: FieldGroup[];
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
        <h2 className="text-sm font-semibold text-gray-800">{showFields ? 'Document details' : 'Findings'}</h2>
        {showFields && groups.length > 0 && (
          <span className="ml-auto text-xs text-gray-400">
            {groups.length} document{groups.length === 1 ? '' : 's'} in this file
          </span>
        )}
      </header>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {/* On the QR view the fields are the point, so an empty findings card is pure noise
            and it is hidden. On every other check the findings ARE the panel, so the empty
            state has to stay — otherwise the panel would render blank with no explanation. */}
        {(!showFields || findings.length > 0) && (
          <FindingsCard
            findings={findings}
            numberOf={numberOf}
            activeId={activeId}
            onSelect={onSelect}
            onJumpToPage={onJumpToPage}
          />
        )}

        {showFields &&
          (groups.length === 0 ? (
            <div className="rounded-lg border border-dashed border-gray-300 bg-white p-6 text-center">
              <FileText className="mx-auto mb-2 h-6 w-6 text-gray-300" />
              <p className="text-sm font-medium text-gray-600">No fields to show</p>
              <p className="mt-1 text-xs text-gray-400">
                This file is not a PAN, Aadhaar, invoice or insurance document — or its text could not
                be read. Run Validate on the claim if it has not been scanned yet.
              </p>
            </div>
          ) : (
            groups.map((g) => (
              <GroupCard key={`${g.type}-${g.pages[0] ?? 0}`} group={g} onJumpToPage={onJumpToPage} />
            ))
          ))}
      </div>
    </div>
  );
}
