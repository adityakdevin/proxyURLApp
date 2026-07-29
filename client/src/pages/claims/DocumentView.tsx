import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ExternalLink,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  RotateCw,
} from 'lucide-react';
import { DocumentViewerPanel } from '@/components/claims/DocumentViewer';
import { FieldPanes, FieldGroup, QrFieldCheck } from '@/components/claims/FieldPanes';
import { api } from '@/lib/api';
import { Finding } from '@/lib/claimTypes';

interface ValResult {
  validatorKey: string;
  findings?: Finding[];
  /** QR carries per-field verdicts against the page the code is printed on, and the
   *  codes it decoded — the QR tab counts codes, not findings. */
  details?: {
    comparisons?: (QrFieldCheck & { documentId: string })[];
    decoded?: { documentId: string; page?: number }[];
  } | null;
}
interface ValRun {
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
}
const RUNNING_STATES = new Set(['QUEUED', 'RUNNING']);

const CHECK_LABEL: Record<string, string> = {
  META: 'Meta',
  SPELL: 'Spell',
  QR: 'QR',
  INTRA: 'Intra-Claim',
  FULL: 'Full Scan',
  REDFLAG: 'Red Flags',
};

// Switcher order, matching the cards on the claim page. 'ALL' drops the ?v= filter.
const CHECK_TABS = ['ALL', 'SPELL', 'QR', 'META', 'INTRA', 'FULL', 'REDFLAG'] as const;

/**
 * Standalone document tab, opened by the claim page with window.open so a reviewer can keep
 * the document beside the claim form. Findings are re-fetched here rather than handed over
 * from the opener — a separate tab has no shared state, and the validation endpoint already
 * returns every finding with its document, page and box.
 */
export default function DocumentView() {
  const { id, documentId } = useParams<{ id: string; documentId: string }>();
  // ?v=SPELL scopes the viewer to one check. Without it, every finding on the document is
  // shown — which is what the documents list wants, but not what a check card wants.
  // Switching is done in place: a reviewer looking at a spelling hit wants the red flags on
  // the SAME document, not another tab of the same file.
  const [params, setParams] = useSearchParams();
  const check = params.get('v');
  // The QR check gets the split layout: document beside the fields read off it.
  const compare = check === 'QR';
  const [fileName, setFileName] = useState('');
  const [results, setResults] = useState<ValResult[]>([]);
  const [groups, setGroups] = useState<FieldGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [panelOpen, setPanelOpen] = useState(true);
  const [running, setRunning] = useState(false);
  // Selection lives here because the findings list is in the sidebar while the highlight
  // boxes are in the viewer; both read the same active id.
  const [activeId, setActiveId] = useState<string | null>(null);
  // Counts REVIEWER picks only. The viewer zooms in on a pick; the auto-selection below
  // must not, or opening a document lands at 250% with nothing having been clicked.
  const [pickNonce, setPickNonce] = useState(0);
  const pickFinding = useCallback((fid: string) => {
    setActiveId(fid);
    setPickNonce((n) => n + 1);
  }, []);
  // nonce so clicking the same page chip twice scrolls back both times.
  const [goto, setGoto] = useState<{ page: number; nonce: number } | null>(null);
  const jumpToPage = useCallback((page: number) => {
    setActiveId(null); // else the finding-scroll effect yanks the view straight back
    setGoto((g) => ({ page, nonce: (g?.nonce ?? 0) + 1 }));
  }, []);

  // Findings for THIS document, narrowed to the selected check. Derived rather than stored,
  // so switching check is instant instead of a refetch.
  const findings = useMemo(
    () =>
      results
        .filter((r) => !check || r.validatorKey === check)
        .flatMap((r) => (r.findings ?? []).filter((f) => f.documentId === documentId)),
    [results, check, documentId]
  );

  // How many findings each check has on this document, so the switcher shows where to look
  // instead of making the reviewer try every tab.
  const countByCheck = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of results) {
      m.set(r.validatorKey, (r.findings ?? []).filter((f) => f.documentId === documentId).length);
    }
    return m;
  }, [results, documentId]);

  // Number every boxed finding so the badge on the page matches its row in the sidebar.
  const numberOf = useMemo(() => {
    const m = new Map<string, number>();
    findings.filter((f) => f.bbox).forEach((f, i) => m.set(f.id, i + 1));
    return m;
  }, [findings]);

  // Open ON the first mistake instead of at the top of the document — a reviewer opening a
  // Spell Check result wants the first flagged word, not page 1.
  useEffect(() => {
    setActiveId(findings.find((f) => f.bbox)?.id ?? null);
  }, [findings]);

  // Document + validation: fetched once per document, NOT per check — the check switcher
  // only re-filters what is already here.
  const loadValidation = useCallback(async () => {
    const r = await api.get<{ data: { run: ValRun | null; results: ValResult[] } }>(
      `/claims/${id}/validation`
    );
    setResults(r.data.results);
    setRunning(RUNNING_STATES.has(r.data.run?.status ?? ''));
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get<{ data: { id: string; fileName: string }[] }>(`/claims/${id}/documents`),
      loadValidation(),
    ])
      .then(([docsRes]) => {
        if (cancelled) return;
        setFileName(docsRes.data.find((d) => d.id === documentId)?.fileName ?? '');
      })
      .catch(() => {
        /* the panel reports an unreadable file on its own; findings just stay empty */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, documentId, loadValidation]);

  // While a run is in flight, poll so the findings on screen become the NEW ones without the
  // reviewer reloading the tab. Stops as soon as the run leaves QUEUED/RUNNING.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => loadValidation().catch(() => undefined), 2000);
    return () => clearInterval(t);
  }, [running, loadValidation]);

  const revalidate = async () => {
    setRunning(true);
    try {
      await api.post(`/claims/${id}/validate`, {});
      await loadValidation();
    } catch {
      setRunning(false); // the run never started — let the reviewer try again
    }
  };

  // Field panes are only rendered for the QR check, so they are only fetched for it.
  useEffect(() => {
    if (!compare) return;
    let cancelled = false;
    api
      .get<{ data: { groups: FieldGroup[] } }>(`/claims/${id}/documents/${documentId}/fields`)
      .then((r) => !cancelled && setGroups(r.data.groups))
      .catch(() => {
        /* the pane shows its own "no fields to show" state */
      });
    return () => {
      cancelled = true;
    };
  }, [id, documentId, compare]);

  // Pages of THIS document that a QR code was actually read from.
  const qrPages = useMemo(
    () =>
      (results.find((r) => r.validatorKey === 'QR')?.details?.decoded ?? []).filter(
        (d) => d.documentId === documentId
      ),
    [results, documentId]
  );

  // The QR tab shows only the documents a QR was FOUND on — an invoice with no code has
  // nothing for this check to say, and listing it invites the reader to look for a verdict
  // that can never appear. Groups with no page info (a plain image, or a claim validated
  // before per-page text was stored) are kept: there is no page to match them on.
  const qrGroups = useMemo(
    () =>
      groups.filter(
        (g) =>
          g.pages.length === 0 ||
          qrPages.some((d) => d.page === undefined || g.pages.includes(d.page))
      ),
    [groups, qrPages]
  );

  // QR verdicts for THIS document, shown against the matching rows of the field panes.
  const qrChecks = useMemo(
    () =>
      (results.find((r) => r.validatorKey === 'QR')?.details?.comparisons ?? []).filter(
        (c) => c.documentId === documentId
      ),
    [results, documentId]
  );

  // QR codes decoded in THIS document. The other tabs count findings — i.e. problems — but
  // a QR check with nothing wrong still has a result worth showing: how many codes it read.
  const qrCount = useMemo(
    () =>
      (results.find((r) => r.validatorKey === 'QR')?.details?.decoded ?? []).filter(
        (d) => d.documentId === documentId
      ).length,
    [results, documentId]
  );

  const checkLabel = check ? CHECK_LABEL[check] ?? check : null;

  // Name the tab after the file and the check, so a reviewer with several open — often the
  // same document under different checks — can tell them apart from the tab strip alone.
  useEffect(() => {
    if (fileName) document.title = checkLabel ? `${fileName} — ${checkLabel}` : fileName;
  }, [fileName, checkLabel]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center gap-2 text-sm text-gray-500">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading document…
      </div>
    );
  }

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;

  return (
    <div className="flex h-screen min-h-0 flex-col bg-gray-100">
      {/* Sticky identity bar: which file, under which check, on which claim. Without it a
          reviewer with six tabs open cannot tell them apart from the page itself. */}
      <header className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-2.5 shadow-sm">
        <h1 className="min-w-0 truncate text-base font-semibold text-gray-900" title={fileName}>
          {fileName || 'Document'}
        </h1>
        {/* Check switcher. Was a static badge, which meant going back to the claim page and
            reopening the same file to see it under another check. */}
        <nav className="flex shrink-0 items-center gap-0.5 rounded-lg bg-gray-100 p-0.5">
          {CHECK_TABS.map((key) => {
            const activeTab = key === (check ?? 'ALL');
            const count = key === 'ALL' ? null : key === 'QR' ? qrCount : countByCheck.get(key) ?? 0;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setParams(key === 'ALL' ? {} : { v: key }, { replace: true })}
                title={
                  key === 'ALL'
                    ? 'Every finding on this document'
                    : key === 'QR'
                      ? `${qrCount} QR code${qrCount === 1 ? '' : 's'} read from this document`
                      : `${countByCheck.get(key) ?? 0} finding(s) on this document`
                }
                className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
                  activeTab
                    ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200'
                    : 'text-gray-500 hover:text-gray-800'
                }`}
              >
                {key === 'ALL' ? 'All' : CHECK_LABEL[key]}
                {!!count && (
                  <span
                    className={`rounded-full px-1 text-[10px] tabular-nums ${
                      activeTab ? 'bg-gray-100 text-gray-600' : 'bg-gray-200 text-gray-500'
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {errors > 0 && (
            <span className="flex items-center gap-1 rounded bg-red-50 px-2 py-0.5 text-xs font-medium text-red-700 ring-1 ring-red-200">
              <AlertTriangle className="h-3 w-3" />
              {errors} red flag{errors === 1 ? '' : 's'}
            </span>
          )}
          {warnings > 0 && (
            <span className="rounded bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
              {warnings} advisory
            </span>
          )}
          {/* Re-run every check on this claim without going back to the claim page — the
              reviewer who just fixed a scan wants the new findings in the tab they are in. */}
          <button
            type="button"
            onClick={revalidate}
            disabled={running}
            title={running ? 'Validation in progress…' : 'Re-validate this claim'}
            aria-label={running ? 'Validation in progress' : 'Re-validate this claim'}
            className="flex items-center gap-1 rounded border px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {running ? 'Validating…' : 'Re-validate'}
          </button>
          <a
            href={`/claims/${id}`}
            target={`claim-${id}`}
            className="flex items-center gap-1 rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 hover:underline"
          >
            Open claim
            <ExternalLink className="h-3 w-3" />
          </a>
          <button
            type="button"
            onClick={() => setPanelOpen((o) => !o)}
            title={panelOpen ? 'Hide the panel — give the document the full width' : 'Show the panel'}
            className="flex items-center rounded border p-1.5 text-gray-600 hover:bg-gray-100"
          >
            {panelOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" />
            )}
            {/* The icon carries the meaning and the tooltip spells it out; the label stays in
                the accessibility tree so the button is still announced. */}
            <span className="sr-only">{panelOpen ? 'Hide panel' : 'Show panel'}</span>
          </button>
        </div>
      </header>

      {/* The document is what the reviewer reads; the fields are a reference sidebar at a
          fixed width, so every extra pixel of a wide window goes to the document. */}
      <main
        className={`min-h-0 flex-1 gap-3 p-3 ${
          panelOpen ? 'grid grid-cols-[minmax(0,1fr)_340px]' : 'flex'
        }`}
      >
        <div className="min-h-0 flex-1 rounded-lg border border-gray-200 bg-white p-2 shadow-sm">
          <DocumentViewerPanel
            claimId={id!}
            documentId={documentId!}
            fileName={fileName}
            findings={findings}
            numberOf={numberOf}
            activeId={activeId}
            onSelect={pickFinding}
            selectNonce={pickNonce}
            gotoPage={goto?.page ?? null}
            gotoNonce={goto?.nonce}
          />
        </div>
        {panelOpen && (
          <FieldPanes
            groups={qrGroups}
            findings={findings}
            numberOf={numberOf}
            activeId={activeId}
            onSelect={pickFinding}
            onJumpToPage={jumpToPage}
            showFields={compare}
            qrChecks={qrChecks}
          />
        )}
      </main>
    </div>
  );
}
