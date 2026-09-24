import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ValidationStatus,
  validationStatusCardClass,
  validationStatusLabel,
  qrOutcomeLabel,
  qrOutcomeVariant,
  validationStatusVariant,
} from '@/lib/validationStatus';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Finding } from '@/lib/claimTypes';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { useAuthStore } from '@/stores/authStore';
import { ClaimHit, ClaimJumpBox } from '@/components/claims/ClaimJumpBox';
import { ALL_CHECK_KEYS, CheckPicker, checksPayload } from '@/components/claims/CheckPicker';
import { QrDataList } from '@/components/claims/QrDataList';

interface Status {
  id: string;
  name: string;
  isTerminal: boolean;
}
interface Remark {
  id: string;
  remarkText: string;
  createdAt: string;
  user: { id: string; fullName: string };
  statusBefore: Status | null;
  statusAfter: Status | null;
}
interface Assignee {
  id: string;
  fullName: string;
  username: string;
}
interface ClaimDetail {
  id: string;
  claimId: string;
  workflowStatus: Status;
  subCategory: {
    id: string;
    name: string;
    category: { id: string; name: string; projectId: string };
  };
  assignedTo: Assignee | null;
  folderPath: string | null;
  spellCheckStatus: string;
  qrStatus: string;
  qrOutcome?: string | null;
  duplicateStatus: string;
  dataCompareStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
  redFlagStatus: string;
  remarks: Remark[];
  createdAt: string;
}

interface DocItem {
  id: string;
  fileName: string;
  source: 'SCANNED' | 'UPLOADED';
  sizeBytes: number | null;
  createdAt: string;
  documentType: { id: string; name: string } | null;
}

function humanSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface ValResult {
  validatorKey: 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL' | 'REDFLAG' | 'DUP' | 'COMPARE';
  status: ValidationStatus;
  summary: string | null;
  findings?: Finding[];
  details?: {
    extracted?: {
      documentId: string;
      fileName: string;
      text: string;
      truncated?: boolean;
      properties?: Record<string, string>;
    }[];
    values?: string[];
    decoded?: { documentId: string; fileName: string; value: string; page?: number }[];
    present?: string[];
    provenance?: Record<string, string>;
  } | null;
}
interface ValRun {
  id: string;
  status: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED';
  trigger: 'AUTO' | 'MANUAL';
  finishedAt: string | null;
}
interface RuleEval {
  id: string;
  name: string;
  field: string;
  operator: string;
  value: string;
  passed: boolean;
  actual: string;
}
const OP_SYMBOL: Record<string, string> = { EQ: '=', NEQ: '≠', GTE: '≥', LTE: '≤', GT: '>', LT: '<' };

const VALIDATORS: { key: ValResult['validatorKey']; label: string; column: keyof ClaimDetail }[] = [
  { key: 'SPELL', label: 'Spell', column: 'spellCheckStatus' },
  { key: 'QR', label: 'QR', column: 'qrStatus' },
  { key: 'INTRA', label: 'Intra-Claim', column: 'intraClaimStatus' },
  { key: 'REDFLAG', label: 'Red Flags', column: 'redFlagStatus' },
  { key: 'FULL', label: 'Missing Docs', column: 'fullScanStatus' },
  { key: 'COMPARE', label: 'Data Compare', column: 'dataCompareStatus' },
  { key: 'DUP', label: 'Duplicate', column: 'duplicateStatus' },
];

export default function ClaimUpdate() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const navigate = useNavigate();
  // The claim ids the list was showing when this claim was opened, so a reviewer can walk
  // the list without going back to it. Carried in router state rather than re-queried,
  // because only the list knows the filters and sort the reviewer had applied.
  // ponytail: lost on a hard refresh, which just hides the arrows. If that becomes
  // annoying, add a /claims/:id/siblings endpoint that re-applies the same query.
  const siblings = (useLocation().state as { siblings?: string[] } | null)?.siblings ?? [];
  const siblingIndex = siblings.indexOf(id ?? '');
  const { user } = useAuthStore();
  const role = user?.role ?? 'USER';
  // Admin and user reach this page on different routes, so stepping has to stay on the one
  // the reviewer is actually on.
  const claimPath = (claimUuid: string) => `${role === 'ADMIN' ? '/admin' : ''}/claims/${claimUuid}`;
  const goToSibling = (delta: number) => {
    const next = siblings[siblingIndex + delta];
    if (next) navigate(claimPath(next), { state: { siblings } });
  };

  // No siblings passed on: a jumped-to claim did not come from the list, so the step arrows
  // have nothing to walk.
  const jumpToClaim = (claim: ClaimHit) => navigate(claimPath(claim.id));

  const [claim, setClaim] = useState<ClaimDetail | null>(null);
  const [statuses, setStatuses] = useState<Status[]>([]);
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [remarkText, setRemarkText] = useState('');
  const [newStatusId, setNewStatusId] = useState<string>('');
  const [newAssigneeId, setNewAssigneeId] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);

  const canEdit = useMemo(() => {
    if (!claim || !user) return false;
    if (role === 'ADMIN' || role === 'TEAM_LEAD') return true;
    return claim.assignedTo?.id === user.id;
  }, [claim, role, user]);

  const canReassign = role === 'TEAM_LEAD' || role === 'ADMIN';

  const fetchClaim = async () => {
    setIsLoading(true);
    try {
      const r = await api.get<{ data: ClaimDetail }>(`/claims/${id}`);
      setClaim(r.data);
      const s = await api.get<{ data: Status[] }>('/user/status-masters');
      setStatuses(s.data);
      if (canReassign) {
        const u = await api.get<{ data: Assignee[] }>('/user/users-in-scope');
        setAssignees(u.data);
      }
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setIsLoading(false);
    }
  };

  // Lightweight poll refresh: claim only (no status/assignee refetch, no spinner).
  const refreshClaim = async () => {
    try {
      const r = await api.get<{ data: ClaimDetail }>(`/claims/${id}`);
      setClaim(r.data);
    } catch {
      /* keep last good state during polling */
    }
  };

  useEffect(() => {
    fetchClaim();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const handleSave = async () => {
    if (!remarkText.trim())
      return toast({ title: 'Remark required', variant: 'destructive' });
    setIsSaving(true);
    try {
      const payload: Record<string, unknown> = { remarkText: remarkText.trim() };
      if (newStatusId && newStatusId !== claim?.workflowStatus.id)
        payload.newStatusId = newStatusId;
      if (canReassign && newAssigneeId !== '') {
        payload.newAssigneeId = newAssigneeId === '__unassign__' ? null : newAssigneeId;
      }
      await api.post(`/claims/${id}/remarks`, payload);
      toast({ title: 'Saved' });
      setRemarkText('');
      setNewStatusId('');
      setNewAssigneeId('');
      fetchClaim();
      fetchRemarks(1);
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Save failed',
      });
    } finally {
      setIsSaving(false);
    }
  };

  const [docs, setDocs] = useState<DocItem[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  // Which checks a run should perform. All of them, as the requirement asks, until the
  // reviewer says otherwise; the choice covers both Validate and an upload on this claim.
  const [checks, setChecks] = useState<string[]>(ALL_CHECK_KEYS);
  // The picker is BUILT and works end to end (Master sheet item 28), but it is additional to
  // what the client has signed off, so it stays out of sight until they ask for it. Hidden,
  // `checks` never leaves its default, so every run performs every check exactly as before.
  // Flip this to true to show it again — nothing else needs changing.
  const SHOW_CHECK_PICKER = false;

  const fetchDocs = async () => {
    try {
      const r = await api.get<{ data: DocItem[] }>(`/claims/${id}/documents`);
      setDocs(r.data);
    } catch {
      /* surfaced on the page as an empty list */
    }
  };

  useEffect(() => {
    if (claim) fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setIsUploading(true);
    try {
      const form = new FormData();
      Array.from(files).forEach((f) => form.append('files', f));
      // A form field, not JSON: the tick-boxes travel with the files they apply to.
      const picked = checksPayload(checks);
      if (picked) form.append('checks', picked.join(','));
      await api.postForm(`/claims/${id}/documents`, form);
      toast({ title: 'Uploaded' });
      fetchDocs();
    } catch (err) {
      toast({
        title: 'Upload failed',
        variant: 'destructive',
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setIsUploading(false);
      e.target.value = '';
    }
  };

  const handleSync = async () => {
    try {
      const r = await api.post<{ data: { created: number; skipped: number } }>(
        `/claims/${id}/documents/sync`,
        {}
      );
      toast({
        title: 'Sync complete',
        description: `Added ${r.data.created}, skipped ${r.data.skipped}`,
      });
      fetchDocs();
    } catch (err) {
      toast({
        title: 'Sync failed',
        variant: 'destructive',
        description: err instanceof Error ? err.message : '',
      });
    }
  };

  const handleDeleteDoc = async (docId: string) => {
    try {
      await api.delete(`/claims/${id}/documents/${docId}`);
      fetchDocs();
    } catch (err) {
      toast({
        title: 'Delete failed',
        variant: 'destructive',
        description: err instanceof Error ? err.message : '',
      });
    }
  };

  const [valRun, setValRun] = useState<ValRun | null>(null);
  const [valResults, setValResults] = useState<ValResult[]>([]);
  // Popup listing decoded QR values.
  const [qrView, setQrView] = useState<{ fileName: string; value: string; page?: number }[] | null>(
    null
  );
  const [isValidating, setIsValidating] = useState(false);

  const validatorStatuses = VALIDATORS.map((v) => String(claim?.[v.column] ?? 'PENDING'));
  const validationRunning =
    isValidating ||
    valRun?.status === 'RUNNING' ||
    valRun?.status === 'QUEUED' ||
    validatorStatuses.includes('IN_PROGRESS');
  const validatedOnce = validatorStatuses.some((s) => s !== 'PENDING' && s !== 'IN_PROGRESS');

  const fetchValidation = async () => {
    try {
      const r = await api.get<{ data: { run: ValRun | null; results: ValResult[] } }>(
        `/claims/${id}/validation`
      );
      setValRun(r.data.run);
      setValResults(r.data.results);
    } catch {
      /* none yet */
    }
  };

  useEffect(() => {
    if (claim) fetchValidation();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id]);

  useEffect(() => {
    const runActive = valRun && valRun.status !== 'COMPLETED' && valRun.status !== 'FAILED';
    if (!runActive && !validatorStatuses.includes('IN_PROGRESS')) return;
    const t = setInterval(() => {
      fetchValidation();
      refreshClaim();
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valRun?.status, validatorStatuses.includes('IN_PROGRESS')]);

  const handleValidate = async () => {
    setIsValidating(true);
    try {
      await api.post(`/claims/${id}/validate`, { checks: checksPayload(checks) });
      toast({ title: 'Validation started' });
      await fetchValidation();
    } catch (err) {
      toast({
        title: 'Could not start validation',
        variant: 'destructive',
        description: err instanceof Error ? err.message : '',
      });
    } finally {
      setIsValidating(false);
    }
  };

  const resultFor = (key: ValResult['validatorKey']) => valResults.find((r) => r.validatorKey === key);

  // Badge click → toggle the matching validator card below (scroll into view on open).
  const openCard = (key: ValResult['validatorKey']) => {
    const el = document.getElementById(`val-card-${key}`);
    if (!el) return;
    if (el instanceof HTMLDetailsElement) {
      el.open = !el.open;
      if (!el.open) return;
    }
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Group findings per validator → per document once (null docId = claim-level), plus a
  // docId→fileName lookup, instead of rebuilding them on every render inside the map.
  const nameByDocId = useMemo(() => new Map(docs.map((d) => [d.id, d.fileName])), [docs]);
  const findingsByValidator = useMemo(() => {
    const byKey = new Map<string, Map<string | null, Finding[]>>();
    for (const res of valResults) {
      const groups = new Map<string | null, Finding[]>();
      for (const f of res.findings ?? []) {
        const list = groups.get(f.documentId);
        if (list) list.push(f);
        else groups.set(f.documentId, [f]);
      }
      byKey.set(res.validatorKey, groups);
    }
    return byKey;
  }, [valResults]);

  // The viewer is a separate tab, so it re-fetches its own findings — a tab has no shared
  // React state with its opener. `validatorKey` scopes it to the card that was clicked:
  // opening a file from Spell Check must show the spelling findings, not every finding the
  // document has under every check. Target name includes the key so each card gets its own
  // tab instead of stealing the one another card opened.
  // No feature string: with one, browsers open a popup window instead of a tab.
  const openDoc = (documentId: string, validatorKey?: ValResult['validatorKey']) =>
    window.open(
      `/claims/${id}/documents/${documentId}${validatorKey ? `?v=${validatorKey}` : ''}`,
      `doc-${documentId}-${validatorKey ?? 'all'}`
    );

  // Hidden (decision of 2026-09-24): six of its ten rows restate the check badges above, and it
  // cannot express Red Flags / Duplicate / Data Compare. Evaluation, routes and the admin page
  // stay in place. Flip this to true to show the panel again — nothing else needs changing.
  const SHOW_CLAIM_RULES = false;
  const [rules, setRules] = useState<RuleEval[]>([]);
  const [rulesPassed, setRulesPassed] = useState({ passed: 0, total: 0 });

  const fetchRules = async () => {
    try {
      const r = await api.get<{ data: { rules: RuleEval[]; passedCount: number; total: number } }>(
        `/claims/${id}/rules`
      );
      setRules(r.data.rules);
      setRulesPassed({ passed: r.data.passedCount, total: r.data.total });
    } catch {
      /* none */
    }
  };

  useEffect(() => {
    if (claim && SHOW_CLAIM_RULES) fetchRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id, valRun?.status]);

  // Paginated timeline so claims with >20 remarks don't lose history.
  const REMARKS_LIMIT = 20;
  const [timeline, setTimeline] = useState<Remark[]>([]);
  const [remarksTotal, setRemarksTotal] = useState(0);
  const [remarksPage, setRemarksPage] = useState(1);

  const fetchRemarks = async (page: number) => {
    try {
      const r = await api.get<{ data: Remark[]; pagination: { total: number } }>(
        `/claims/${id}/remarks?page=${page}&limit=${REMARKS_LIMIT}`
      );
      setTimeline((prev) => (page === 1 ? r.data : [...prev, ...r.data]));
      setRemarksTotal(r.pagination.total);
      setRemarksPage(page);
    } catch {
      /* keep current timeline on a transient error */
    }
  };

  useEffect(() => {
    if (claim) fetchRemarks(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claim?.id]);

  if (isLoading || !claim) return <div className="p-6">Loading...</div>;

  return (
    <div>
      <div className="mb-4 flex items-center gap-2">
        <Button
          variant="ghost"
          onClick={() => navigate(role === 'ADMIN' ? '/admin/claims' : '/claims')}
        >
          <ArrowLeft className="h-4 w-4 mr-1" />
          Back to Claims
        </Button>

        {/* Jump straight to a claim by its id, instead of Back → find it → open. */}
        <div className="ml-auto">
          <ClaimJumpBox onPick={jumpToClaim} />
        </div>

        {siblings.length > 1 && (
          <div className="flex items-center gap-1">
            <span className="mr-1 text-xs tabular-nums text-gray-500">
              {siblingIndex + 1} of {siblings.length}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={siblingIndex <= 0}
              onClick={() => goToSibling(-1)}
              title="Previous claim"
              aria-label="Previous claim"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={siblingIndex < 0 || siblingIndex >= siblings.length - 1}
              onClick={() => goToSibling(1)}
              title="Next claim"
              aria-label="Next claim"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>

      <div className="bg-white border rounded-md p-6 mb-6">
        <div className="flex items-start justify-between">
          <div>
            <h1 className="text-2xl font-bold">{claim.claimId}</h1>
            <p className="text-sm text-gray-500 mt-1">
              {claim.subCategory.category.name} / {claim.subCategory.name}
            </p>
          </div>
          <Badge variant={claim.workflowStatus.isTerminal ? 'secondary' : 'default'}>
            {claim.workflowStatus.name}
          </Badge>
        </div>
        <div className="grid grid-cols-2 gap-4 mt-4 text-sm">
          <div>
            <span className="text-gray-500">Folder Path: </span>
            {claim.folderPath ?? '-'}
          </div>
          <div>
            <span className="text-gray-500">Assigned To: </span>
            {claim.assignedTo?.fullName ?? 'Unassigned'}
          </div>
        </div>
        <div className="flex items-center justify-between mt-4">
          <div className="flex flex-wrap gap-2">
            {VALIDATORS.map((v) => {
              const colVal = String(claim[v.column]);
              const res = resultFor(v.key);
              // QR shows its bifurcated outcome instead of the bare status (row 19); the
              // other five have no such distinction to draw.
              const qrOut =
                v.key === 'QR' && claim.qrOutcome && colVal !== 'PENDING' && colVal !== 'IN_PROGRESS'
                  ? claim.qrOutcome
                  : null;
              return (
                <Badge
                  key={v.key}
                  variant={qrOut ? qrOutcomeVariant(qrOut) : validationStatusVariant(colVal)}
                  title={res?.summary ?? ''}
                  className="cursor-pointer"
                  onClick={() => openCard(v.key)}
                >
                  {v.label}: {qrOut ? qrOutcomeLabel(qrOut) : validationStatusLabel(colVal)}
                </Badge>
              );
            })}
          </div>
          {canEdit && (
            <div className="flex items-center gap-2">
              {SHOW_CHECK_PICKER && (
                <CheckPicker selected={checks} onChange={setChecks} disabled={validationRunning} />
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={handleValidate}
                disabled={validationRunning}
              >
                {validationRunning ? 'Validating…' : validatedOnce ? 'Re-validate' : 'Validate'}
              </Button>
            </div>
          )}
        </div>
      </div>

      {valResults.length > 0 && (
        <div className="grid grid-cols-2 gap-4 mb-6">
          {VALIDATORS.map((v) => {
            const res = resultFor(v.key);
            if (!res) return null;
            const findings = res.findings ?? [];
            const groups = findingsByValidator.get(v.key) ?? new Map<string | null, Finding[]>();
            const cardClass = validationStatusCardClass(String(claim[v.column]));
            // QR shows a popup with the decoded QR values (old runs only stored bare values).
            const qrButton = v.key === 'QR' && (
              <Button
                size="sm"
                variant="outline"
                className="ml-2 h-6 px-2 text-xs shrink-0"
                onClick={() =>
                  setQrView(
                    res.details?.decoded ??
                      (res.details?.values ?? []).map((value) => ({ fileName: 'QR code', value }))
                  )
                }
              >
                View QR Data
              </Button>
            );
            const header = (
              <>
                <h2 className="inline text-lg font-semibold">{v.label}</h2>
                <div className="mt-1 text-sm text-gray-600">{res.summary}</div>
                {v.key === 'FULL' && (res.details?.present?.length ?? 0) > 0 && (
                  <div className="mt-1 text-sm text-green-700">
                    {res.details!.present!.map((name) => {
                      const where = res.details?.provenance?.[name];
                      return where ? `${name} (${where})` : name;
                    }).join(', ')}
                  </div>
                )}
              </>
            );
            return (
              <details
                key={v.key}
                id={`val-card-${v.key}`}
                // Every card is the same half-width cell. Missing Docs used to span both
                // columns for its document list, which pushed the card after it into a row
                // of its own — a full-width card, then a half-width one against empty space.
                className={`group ${cardClass} border rounded-md`}
              >
                <summary className="flex cursor-pointer select-none items-start justify-between gap-2 p-6 list-none [&::-webkit-details-marker]:hidden">
                  <div>{header}</div>
                  <ChevronDown className="h-4 w-4 mt-1.5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" />
                </summary>
                {(findings.length === 0 || v.key === 'FULL') && docs.length > 0 && (
                  <ul className="-mt-3 px-6 pb-6 space-y-1 text-sm text-gray-500">
                    {docs.map((d) => (
                      <li key={d.id}>
                        <button
                          type="button"
                          className="text-blue-600 hover:underline"
                          onClick={() => openDoc(d.id, v.key)}
                        >
                          {d.fileName}
                        </button>
                        {qrButton}
                      </li>
                    ))}
                  </ul>
                )}
                {findings.length > 0 && (
                <ul className="-mt-3 px-6 pb-6 space-y-2 text-sm text-gray-500">
                  {[...groups.entries()].map(([docId, fs]) => {
                    const name = docId ? nameByDocId.get(docId) ?? 'Document' : 'Claim-level';
                    return (
                      <li key={docId ?? 'claim'}>
                        {docId ? (
                          <button
                            type="button"
                            className="text-blue-600 hover:underline"
                            onClick={() => openDoc(docId, v.key)}
                          >
                            {name}
                          </button>
                        ) : (
                          <span className="font-medium">{name}</span>
                        )}{' '}
                        — {fs.length} finding{fs.length > 1 ? 's' : ''}:
                        <ul className="mt-1 ml-5 list-disc space-y-0.5">
                          {fs.slice(0, 5).map((f, i) => (
                            <li key={i}>{f.message}</li>
                          ))}
                          {fs.length > 5 && <li>…(+{fs.length - 5} more)</li>}
                        </ul>
                      </li>
                    );
                  })}
                </ul>
                )}
                {findings.length > 0 && qrButton && (
                  <div className="-mt-3 px-6 pb-6">{qrButton}</div>
                )}
              </details>
            );
          })}
        </div>
      )}

      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">Update Claim</h2>
        {!canEdit && (
          <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded p-3 mb-4">
            You can view this claim, but only the assignee or a supervisor can update it.
          </p>
        )}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label>Change Status (optional)</Label>
            <Select value={newStatusId} onValueChange={setNewStatusId} disabled={!canEdit}>
              <SelectTrigger>
                <SelectValue placeholder="Keep current status" />
              </SelectTrigger>
              <SelectContent>
                {statuses
                  .filter((s) => s.id !== claim.workflowStatus.id)
                  .map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>
          {canReassign && (
            <div className="space-y-1">
              <Label>Reassign (optional)</Label>
              <Select
                value={newAssigneeId}
                onValueChange={setNewAssigneeId}
                disabled={!canEdit}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Keep assignment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__unassign__">Unassigned</SelectItem>
                  {assignees.map((a) => (
                    <SelectItem key={a.id} value={a.id}>
                      {a.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        <div className="space-y-1 mt-4">
          <Label>Remark</Label>
          <Textarea
            value={remarkText}
            onChange={(e) => setRemarkText(e.target.value)}
            disabled={!canEdit}
            placeholder="Required"
            // Matches the server validator on /claims/:id/remarks.
            maxLength={2000}
          />
        </div>
        <div className="flex justify-end mt-4">
          <Button onClick={handleSave} disabled={!canEdit || isSaving || !remarkText.trim()}>
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

      {SHOW_CLAIM_RULES && (
      <div className="bg-white border rounded-md p-6 mb-6">
        <h2 className="text-lg font-semibold mb-4">
          Claim Rules{' '}
          {rules.length > 0 && (
            <span className="text-sm font-normal text-gray-500">
              ({rulesPassed.passed} of {rulesPassed.total} passed)
            </span>
          )}
        </h2>
        {rules.length === 0 ? (
          <p className="text-sm text-gray-400">No rules configured for this sub-category.</p>
        ) : (
          <div className="space-y-2">
            {rules.map((r) => (
              <div key={r.id} className="flex items-center justify-between text-sm border rounded px-3 py-2">
                <span>
                  <span className="font-medium">{r.name}</span>{' '}
                  <span className="text-gray-500">
                    ({r.field} {OP_SYMBOL[r.operator] ?? r.operator} {r.value})
                  </span>
                </span>
                <span className={r.passed ? 'text-green-600' : 'text-destructive'}>
                  {r.passed ? '✓' : '✗'} {r.actual}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      )}

      <div className="bg-white border rounded-md p-6 mb-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Documents</h2>
          {canEdit && (
            <div className="flex items-center gap-2">
              {claim.folderPath && (
                <Button variant="outline" size="sm" onClick={handleSync}>
                  Sync from folder
                </Button>
              )}
              <label className="inline-flex items-center px-3 py-1.5 text-sm border rounded-md cursor-pointer hover:bg-gray-50">
                {isUploading ? 'Uploading...' : 'Upload'}
                <input
                  type="file"
                  multiple
                  className="hidden"
                  onChange={handleUpload}
                  disabled={isUploading}
                />
              </label>
            </div>
          )}
        </div>
        {docs.length === 0 ? (
          <p className="text-sm text-gray-400">No documents yet.</p>
        ) : (
          <div className="space-y-2">
            {docs.map((d) => (
              <div
                key={d.id}
                className="flex items-center justify-between text-sm border rounded px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <a
                    href={`/api/claims/${id}/documents/${d.id}/content`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-2 hover:underline truncate"
                  >
                    {d.fileName}
                  </a>
                  <Badge variant={d.documentType ? 'default' : 'outline'}>
                    {d.documentType?.name ?? 'Unclassified'}
                  </Badge>
                  <Badge variant="secondary">
                    {d.source === 'SCANNED' ? 'Scanned' : 'Uploaded'}
                  </Badge>
                </div>
                <div className="flex items-center gap-3 text-gray-500 shrink-0">
                  <span>{humanSize(d.sizeBytes)}</span>
                  <span>{new Date(d.createdAt).toLocaleDateString()}</span>
                  {canEdit && (
                    <button
                      className="text-destructive hover:underline"
                      onClick={() => handleDeleteDoc(d.id)}
                    >
                      Delete
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="bg-white border rounded-md p-6">
        <h2 className="text-lg font-semibold mb-4">
          Remarks Timeline{' '}
          {remarksTotal > 0 && (
            <span className="text-sm font-normal text-gray-500">({remarksTotal})</span>
          )}
        </h2>
        <div className="space-y-3">
          {timeline.length === 0 && (
            <p className="text-sm text-gray-400">No remarks yet.</p>
          )}
          {timeline.map((r) => (
            <div key={r.id} className="border-l-2 border-gray-200 pl-4 py-1">
              <div className="flex items-center gap-2 text-sm">
                <span className="font-medium">{r.user.fullName}</span>
                <span className="text-gray-400">
                  {new Date(r.createdAt).toLocaleString()}
                </span>
                {r.statusBefore && r.statusAfter && (
                  <Badge variant="outline">
                    {r.statusBefore.name} → {r.statusAfter.name}
                  </Badge>
                )}
              </div>
              <p className="text-sm text-gray-700 mt-1 whitespace-pre-wrap">{r.remarkText}</p>
            </div>
          ))}
        </div>
        {timeline.length < remarksTotal && (
          <div className="flex justify-center mt-4">
            <Button variant="outline" size="sm" onClick={() => fetchRemarks(remarksPage + 1)}>
              Load {remarksTotal - timeline.length} older
            </Button>
          </div>
        )}
      </div>

      <Dialog open={!!qrView} onOpenChange={(o) => !o && setQrView(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>QR Data</DialogTitle>
          </DialogHeader>
          {qrView &&
            (qrView.length === 0 ? (
              <p className="text-sm text-gray-500">No QR codes were decoded for this claim.</p>
            ) : (
              <div className="max-h-[70vh] overflow-y-auto">
                <QrDataList entries={qrView} />
              </div>
            ))}
        </DialogContent>
      </Dialog>

    </div>
  );
}
