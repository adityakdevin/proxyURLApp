import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
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
import { useAuthStore } from '@/stores/authStore';
import { ClaimHit, ClaimJumpBox } from '@/components/claims/ClaimJumpBox';

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
/** A claim either side of this one in the list, with the document to open it on. */
type Neighbour = { id: string; claimId: string; documentId: string | null } | null;
const RUNNING_STATES = new Set(['QUEUED', 'RUNNING']);

const CHECK_LABEL: Record<string, string> = {
  SPELL: 'Spell',
  QR: 'QR',
  INTRA: 'Intra-Claim',
  FULL: 'Full Scan',
  REDFLAG: 'Red Flags',
  DUP: 'Duplicate',
};

// Switcher order, matching the cards on the claim page. 'ALL' drops the ?v= filter.
// META is not here: it is the extraction step, not a verdict. It still runs.
const CHECK_TABS = ['ALL', 'SPELL', 'QR', 'INTRA', 'FULL', 'REDFLAG', 'DUP'] as const;

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
  // The claim page lives on a different route for an admin, and this window is opened
  // straight from a URL, so it has to pick the route the reviewer belongs on itself.
  const isAdmin = useAuthStore().user?.role === 'ADMIN';
  const claimPath = (claimUuid: string) => `${isAdmin ? '/admin' : ''}/claims/${claimUuid}`;
  const claimHref = claimPath(id ?? '');
  const navigate = useNavigate();

  // Stepping claims without leaving the viewer: the neighbours come from the server because
  // this window is opened by URL and so has no list state to walk.
  const [neighbours, setNeighbours] = useState<{ prev: Neighbour; next: Neighbour }>({
    prev: null,
    next: null,
  });

  /** Open a claim in THIS window, staying on its documents and on the current check. A claim
   *  with no documents has nothing for the viewer to show, so it falls back to its page. */
  // Not memoized: nothing reads its identity (no dependency array references it), so a
  // useCallback here bought nothing except an exhaustive-deps suppression on a function that
  // will keep growing.
  const goToClaim = (claimUuid: string, docId: string | null) => {
    navigate(
      docId
        ? `/claims/${claimUuid}/documents/${docId}${check ? `?v=${check}` : ''}`
        : claimPath(claimUuid)
    );
  };

  /** A jumped-to claim opens on its first document — the viewer has nothing else to show. */
  const jumpToClaim = async (claim: ClaimHit) => {
    const docs = await api
      .get<{ data: { id: string }[] }>(`/claims/${claim.id}/documents`)
      .catch(() => ({ data: [] as { id: string }[] }));
    goToClaim(claim.id, docs.data[0]?.id ?? null);
  };
  // The QR check gets the split layout: document beside the fields read off it.
  const compare = check === 'QR';
  const [fileName, setFileName] = useState('');
  const [claimLabel, setClaimLabel] = useState('');
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
    // Stepping to another claim swaps the document under the same component: hold the
    // loading state until its findings arrive, or the header names the new file while the
    // panes still show the old claim's findings.
    setLoading(true);
    Promise.all([
      api.get<{ data: { id: string; fileName: string }[] }>(`/claims/${id}/documents`),
      // The claim id is what a reviewer works in; the file name only says which of its
      // documents is on screen.
      api.get<{ data: { claimId: string } }>(`/claims/${id}`),
      loadValidation(),
    ])
      .then(([docsRes, claimRes]) => {
        if (cancelled) return;
        setFileName(docsRes.data.find((d) => d.id === documentId)?.fileName ?? '');
        setClaimLabel(claimRes.data.claimId);
      })
      .catch(() => {
        /* the panel reports an unreadable file on its own; findings just stay empty */
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [id, documentId, loadValidation]);

  useEffect(() => {
    let cancelled = false;
    // Clear FIRST. This effect is not behind the loading gate, so between stepping to a new
    // claim and its neighbours landing the arrows still held the PREVIOUS claim's prev/next:
    // one click of Back then skipped a claim entirely, and Next was a no-op onto the claim
    // already on screen. Both were silent — the wrong claim, no error.
    setNeighbours({ prev: null, next: null });
    api
      .get<{ data: { prev: Neighbour; next: Neighbour } }>(`/claims/${id}/adjacent`)
      .then((r) => !cancelled && setNeighbours(r.data))
      .catch(() => !cancelled && setNeighbours({ prev: null, next: null }));
    return () => {
      cancelled = true;
    };
  }, [id]);

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

  // Name the tab after the CLAIM and the check, so a reviewer with several open — often the
  // same claim under different checks — can tell them apart from the tab strip alone.
  useEffect(() => {
    if (claimLabel) document.title = checkLabel ? `${claimLabel} — ${checkLabel}` : claimLabel;
  }, [claimLabel, checkLabel]);

  const errors = findings.filter((f) => f.severity === 'ERROR').length;
  const warnings = findings.filter((f) => f.severity === 'WARNING').length;

  return (
    <div className="flex h-screen min-h-0 flex-col overflow-x-hidden bg-gray-100">
      {/* Sticky identity bar: which claim, under which check. The file name lives in the
          viewer panel — with six tabs open it is the claim id that tells them apart. */}
      <header className="flex shrink-0 items-center gap-3 border-b bg-white px-4 py-2.5 shadow-sm">
        <h1 className="min-w-0 shrink truncate text-base font-semibold text-gray-900" title={claimLabel}>
          {claimLabel || 'Claim'}
        </h1>
        {/* Check switcher. Was a static badge, which meant going back to the claim page and
            reopening the same file to see it under another check. */}
        {/* The tab strip is the one part of the bar that may shrink: it scrolls on a narrow
            window so the actions on the right stay on screen instead of the page going wide. */}
        <nav className="flex min-w-0 shrink items-center gap-0.5 overflow-x-auto rounded-lg bg-gray-100 p-0.5">
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
                className={`flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition ${
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
          {/* Three groups, in the order a reviewer needs them: GO somewhere (step, jump),
              DO something to this claim (re-validate, open it), then how the page LOOKS.
              Stepping leads because a batch is walked far more often than a claim is jumped
              to by id; the panel toggle is pinned last, where a view control is looked for. */}
          <div className="flex items-center">
            <button
              type="button"
              disabled={!neighbours.prev}
              onClick={() => neighbours.prev && goToClaim(neighbours.prev.id, neighbours.prev.documentId)}
              title={neighbours.prev ? `Previous claim — ${neighbours.prev.claimId}` : 'No previous claim'}
              aria-label="Previous claim"
              className="rounded-l border border-r-0 p-1.5 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!neighbours.next}
              onClick={() => neighbours.next && goToClaim(neighbours.next.id, neighbours.next.documentId)}
              title={neighbours.next ? `Next claim — ${neighbours.next.claimId}` : 'No next claim'}
              aria-label="Next claim"
              className="rounded-r border p-1.5 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
          {/* Jump straight to a claim by its id, instead of stepping to it. Lands on that
              claim's first document, under the check already selected here. */}
          <ClaimJumpBox
            onPick={jumpToClaim}
            collapsible
            inputClassName="h-7 w-44 rounded-md border border-gray-200 pl-7 pr-8 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-blue-600"
          />

          <span className="mx-0.5 h-5 w-px bg-gray-200" />

          {/* Re-run every check on this claim without going back to the claim page — the
              reviewer who just fixed a scan wants the new findings in the tab they are in. */}
          <button
            type="button"
            onClick={revalidate}
            disabled={running}
            title={running ? 'Validation in progress…' : 'Re-validate this claim'}
            aria-label={running ? 'Validation in progress' : 'Re-validate this claim'}
            className="flex items-center rounded border p-1.5 text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RotateCw className="h-3.5 w-3.5" />
            )}
            {/* Icon-only in the bar; the tooltip carries the meaning and the label stays in
                the accessibility tree. */}
            <span className="sr-only">{running ? 'Validating…' : 'Re-validate'}</span>
          </button>
          <a
            href={claimHref}
            target={`claim-${id}`}
            title="Open claim"
            className="flex items-center rounded border p-1.5 text-blue-600 hover:bg-blue-50"
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="sr-only">Open claim</span>
          </a>

          <span className="mx-0.5 h-5 w-px bg-gray-200" />
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

      {/* Stepping to another claim announces itself — the only other signal was
          document.title, which a screen reader does not read on an in-page navigation. */}
      <p className="sr-only" role="status" aria-live="polite">
        {loading ? 'Loading claim…' : claimLabel ? `Claim ${claimLabel}` : ''}
      </p>

      {/* The loading state swaps the BODY only. Returning a full-page spinner unmounted the
          header, and with it the step arrow the reviewer had just activated — so walking a
          batch by keyboard dropped focus onto <body> on every single step. */}
      {loading ? (
        <main className="flex min-h-0 flex-1 items-center justify-center gap-2 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading document…
        </main>
      ) : (
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
      )}
    </div>
  );
}
