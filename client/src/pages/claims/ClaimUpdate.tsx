import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, ChevronDown, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  ValidationStatus,
  validationStatusCardClass,
  validationStatusLabel,
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
  validatorKey: 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL' | 'REDFLAG';
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

/** Parse "Label: value" fields out of a document's extracted body text (invoice/form
 *  fields like "Customer Id: C2025…", "Bill To: …"). Skips time-style colons. Returns
 *  [] when the text isn't field-shaped so the caller falls back to raw text. */
function parseKeyValues(text: string): [string, string][] {
  const clean = text.replace(/\s+/g, ' ').trim();
  const re = /([A-Z][A-Za-z0-9 .*%/&()'-]{2,45}?)\s*:(?!\d)\s*/g;
  const labels: { label: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(clean)) !== null) {
    const keep = m[1].trim().split(' ').slice(-4);
    while (keep.length > 1 && (/\d/.test(keep[0]) || /\.$/.test(keep[0]) || !/^[A-Z(]/.test(keep[0]))) {
      keep.shift();
    }
    const label = keep.join(' ');
    if (!/^[A-Z]/.test(label) || label.length < 2) continue;
    labels.push({ label, start: m.index + m[1].lastIndexOf(label), end: re.lastIndex });
  }
  const pairs: [string, string][] = [];
  for (let i = 0; i < labels.length; i++) {
    const value = clean.slice(labels[i].end, labels[i + 1]?.start ?? clean.length).trim();
    if (value) pairs.push([labels[i].label, value]);
  }
  return pairs;
}
/** Policy QR payloads are "Label:Value" fields joined by "|" (or ","). Split each
 *  field at its label colon — skipping time colons like "11:43AM" — or, for fields
 *  whose colon was omitted ("OD period02 Jul 2025…"), at the first digit. Returns
 *  [] when the payload isn't field-shaped so the caller falls back to raw text. */
function parseQrFields(value: string): [string, string][] {
  // Aadhaar QRs carry XML (<PrintLetterBarcodeData uid="…" name="…"/>) —
  // show its attributes as rows.
  if (value.trimStart().startsWith('<')) {
    const attrs = [...value.matchAll(/([A-Za-z_][\w-]*)="([^"]*)"/g)].map(
      (m): [string, string] => [m[1], m[2]]
    );
    return attrs.length >= 2 ? attrs : [];
  }
  const sep = value.includes('|') ? '|' : ',';
  const pairs: [string, string][] = [];
  for (const part of value.split(sep)) {
    const p = part.trim();
    if (!p) continue;
    // First colon that isn't a time colon ("11:43AM" — digit on BOTH sides).
    const colon = /(?<!\d):|:(?!\d)/.exec(p);
    if (colon && colon.index > 0) {
      pairs.push([p.slice(0, colon.index).trim(), p.slice(colon.index + 1).trim()]);
      continue;
    }
    const digit = /^([A-Za-z. ]{2,}?)\s*(\d.*)$/.exec(p);
    if (digit) pairs.push([digit[1].trim(), digit[2].trim()]);
    else pairs.push(['', p]);
  }
  return pairs.filter(([label]) => label).length >= 2 ? pairs : [];
}

/** PAN / Aadhaar Secure QR payloads are issuer-encrypted binary; qrValue() base64s them
 *  with a `binary:` prefix. Showing that blob to a reviewer is useless — say what to do. */
const OPAQUE_QR_PREFIX = 'binary:';
const OPAQUE_QR_HELP =
  'This QR code is encrypted by the issuing authority, so its contents cannot be expanded here. ' +
  'For a PAN card please use the PAN QR Code Reader App, and for Aadhaar the Aadhaar QR Scanner App, ' +
  'to generate the QR code result.';

const VALIDATORS: { key: ValResult['validatorKey']; label: string; column: keyof ClaimDetail }[] = [
  { key: 'SPELL', label: 'Spell', column: 'spellCheckStatus' },
  { key: 'QR', label: 'QR', column: 'qrStatus' },
  { key: 'META', label: 'Meta', column: 'metaExtractionStatus' },
  { key: 'INTRA', label: 'Intra-Claim', column: 'intraClaimStatus' },
  { key: 'REDFLAG', label: 'Red Flags', column: 'redFlagStatus' },
  { key: 'FULL', label: 'Full Scan', column: 'fullScanStatus' },
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

  const [jumpQuery, setJumpQuery] = useState('');
  const [jumpError, setJumpError] = useState('');

  /** Look the typed claim id up through the same search the list uses, then open it. An
   *  exact id wins; otherwise a single partial match is good enough to jump to. */
  const jumpToClaim = async () => {
    const q = jumpQuery.trim();
    if (!q) return;
    setJumpError('');
    try {
      const r = await api.get<{ data: { id: string; claimId: string }[] }>(
        `/claims?search=${encodeURIComponent(q)}&limit=10`
      );
      const hits = r.data;
      const exact = hits.find((c) => c.claimId.toLowerCase() === q.toLowerCase());
      const target = exact ?? (hits.length === 1 ? hits[0] : null);
      if (!target) {
        setJumpError(hits.length ? `${hits.length} claims match — type the full ID` : 'No claim found');
        setTimeout(() => setJumpError(''), 3000);
        return;
      }
      setJumpQuery('');
      // No siblings: this claim did not come from the list, so the arrows step nothing.
      navigate(claimPath(target.id));
    } catch {
      setJumpError('Search failed');
      setTimeout(() => setJumpError(''), 3000);
    }
  };

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
  // META popup: 'properties' = PDF document metadata (created/modified/producer/…);
  // 'extracted' = key/value fields parsed from the body text (invoice/form fields).
  const [metaView, setMetaView] = useState<{
    fileName: string;
    text: string;
    truncated?: boolean;
    properties?: Record<string, string>;
    mode: 'properties' | 'extracted';
  } | null>(null);
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
      await api.post(`/claims/${id}/validate`, {});
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
    if (claim) fetchRules();
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

        {/* Jump straight to a claim by its id, instead of Back → find it → open. Matches the
            same claim ids the list search does, and opens the only hit. */}
        <div className="relative ml-auto">
          <Search className="pointer-events-none absolute left-2 top-2.5 h-3.5 w-3.5 text-gray-400" />
          <input
            value={jumpQuery}
            onChange={(e) => setJumpQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && jumpToClaim()}
            placeholder="Go to claim ID…"
            aria-label="Go to claim ID"
            className="h-9 w-52 rounded-md border border-gray-200 pl-7 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-200"
          />
          {jumpError && (
            <p className="absolute left-0 top-9 z-10 whitespace-nowrap rounded bg-red-50 px-2 py-1 text-xs text-red-600 shadow">
              {jumpError}
            </p>
          )}
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
              return (
                <Badge
                  key={v.key}
                  variant={validationStatusVariant(colVal)}
                  title={res?.summary ?? ''}
                  className="cursor-pointer"
                  onClick={() => openCard(v.key)}
                >
                  {v.label}: {validationStatusLabel(colVal)}
                </Badge>
              );
            })}
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleValidate}
              disabled={validationRunning}
            >
              {validationRunning ? 'Validating…' : validatedOnce ? 'Re-validate' : 'Validate'}
            </Button>
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
            // META shows the extracted text itself instead of a plain file list.
            const extracted = v.key === 'META' ? res.details?.extracted ?? [] : [];
            const extractedBlock = extracted.length > 0 && (
              <div className="mt-2 space-y-3">
                {extracted.map((e) => (
                  <div key={e.documentId}>
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        className="text-sm font-medium text-blue-600 hover:underline"
                        onClick={() => openDoc(e.documentId, v.key)}
                      >
                        {e.fileName}
                      </button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs shrink-0"
                        onClick={() => setMetaView({ ...e, mode: 'properties' })}
                      >
                        View Meta Data
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs shrink-0"
                        onClick={() => setMetaView({ ...e, mode: 'extracted' })}
                      >
                        View Extracted Properties
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            );
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
                className={`group ${cardClass} border rounded-md ${v.key === 'FULL' ? 'col-span-2' : ''}`}
              >
                <summary className="flex cursor-pointer select-none items-start justify-between gap-2 p-6 list-none [&::-webkit-details-marker]:hidden">
                  <div>{header}</div>
                  <ChevronDown className="h-4 w-4 mt-1.5 shrink-0 text-gray-400 transition-transform group-open:rotate-180" />
                </summary>
                {(findings.length === 0 || v.key === 'FULL') && v.key !== 'META' && docs.length > 0 && (
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
                {(extractedBlock || (findings.length > 0 && qrButton)) && (
                  <div className="-mt-3 px-6 pb-6">
                    {extractedBlock}
                    {findings.length > 0 && qrButton}
                  </div>
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
          />
        </div>
        <div className="flex justify-end mt-4">
          <Button onClick={handleSave} disabled={!canEdit || isSaving || !remarkText.trim()}>
            {isSaving ? 'Saving...' : 'Save'}
          </Button>
        </div>
      </div>

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
              <div className="max-h-[70vh] space-y-4 overflow-y-auto text-sm">
                {qrView.map((q, i) => {
                  const fields = parseQrFields(q.value);
                  const opaque = q.value.startsWith(OPAQUE_QR_PREFIX);
                  return (
                    <div key={i}>
                      <div className="font-medium">
                        {q.fileName}
                        {q.page != null && (
                          <span className="ml-2 font-normal text-gray-400">page {q.page}</span>
                        )}
                      </div>
                      {opaque ? (
                        <>
                          <p className="mt-1 rounded border border-amber-300 bg-amber-50 p-2 text-amber-900">
                            {OPAQUE_QR_HELP}
                          </p>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-gray-400">
                              Raw QR payload
                            </summary>
                            <div className="mt-1 break-all text-xs text-gray-500">{q.value}</div>
                          </details>
                        </>
                      ) : fields.length > 0 ? (
                        <>
                          <table className="mt-1 w-full">
                            <tbody className="divide-y">
                              {fields.map(([label, value], j) => (
                                <tr key={j}>
                                  <td className="py-1.5 pr-4 align-top font-medium text-gray-700 whitespace-nowrap">
                                    {label}
                                  </td>
                                  <td className="py-1.5 break-all text-gray-600">{value}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          <details className="mt-2">
                            <summary className="cursor-pointer text-xs text-gray-400">
                              Raw QR payload
                            </summary>
                            <div className="mt-1 break-all text-xs text-gray-500">{q.value}</div>
                          </details>
                        </>
                      ) : (
                        <div className="mt-1 break-all text-gray-600">{q.value}</div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
        </DialogContent>
      </Dialog>

      <Dialog open={!!metaView} onOpenChange={(o) => !o && setMetaView(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>
              {metaView?.mode === 'extracted' ? 'Extracted Properties' : 'Document Properties'} —{' '}
              {metaView?.fileName}
            </DialogTitle>
          </DialogHeader>
          {metaView && (
            <div className="max-h-[70vh] overflow-y-auto text-sm">
              {(() => {
                const rows =
                  metaView.mode === 'extracted'
                    ? parseKeyValues(metaView.text)
                    : Object.entries(metaView.properties ?? {});
                const empty =
                  metaView.mode === 'extracted'
                    ? 'No labelled fields found in the extracted text.'
                    : 'No document properties found for this file.';
                return (
                  <>
                    {rows.length > 0 ? (
                      <table className="w-full">
                        <tbody className="divide-y">
                          {rows.map(([label, value], i) => (
                            <tr key={i}>
                              <td className="py-1.5 pr-4 align-top font-medium text-gray-700 whitespace-nowrap max-w-[16rem] overflow-hidden text-ellipsis">
                                {label}
                              </td>
                              <td className="py-1.5 text-gray-600 break-all">{value}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <div className="text-gray-500">{empty}</div>
                    )}
                  </>
                );
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
