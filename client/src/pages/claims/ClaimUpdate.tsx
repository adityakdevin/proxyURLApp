import { useEffect, useMemo, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
    category: { id: string; name: string; userTypeId: string; projectTypeId: string };
  };
  assignedTo: Assignee | null;
  folderPath: string | null;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
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
  validatorKey: 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL';
  status: 'PENDING' | 'IN_PROGRESS' | 'PASSED' | 'FAILED';
  summary: string | null;
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
function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'PASSED') return 'default';
  if (s === 'FAILED') return 'destructive';
  if (s === 'IN_PROGRESS') return 'secondary';
  return 'outline';
}
const VALIDATORS: { key: ValResult['validatorKey']; label: string; column: keyof ClaimDetail }[] = [
  { key: 'SPELL', label: 'Spell', column: 'spellCheckStatus' },
  { key: 'QR', label: 'QR', column: 'qrStatus' },
  { key: 'META', label: 'Meta', column: 'metaExtractionStatus' },
  { key: 'INTRA', label: 'Intra-Claim', column: 'intraClaimStatus' },
  { key: 'FULL', label: 'Full Scan', column: 'fullScanStatus' },
];

export default function ClaimUpdate() {
  const { id } = useParams<{ id: string }>();
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const role = user?.role ?? 'USER';

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
      const s = await api.get<{ data: Status[] }>(
        `/user/status-masters?subCategoryId=${r.data.subCategory.id}`
      );
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
  const [isValidating, setIsValidating] = useState(false);

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
    if (!valRun || valRun.status === 'COMPLETED' || valRun.status === 'FAILED') return;
    const t = setInterval(() => {
      fetchValidation();
      refreshClaim();
    }, 1500);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valRun?.status]);

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
      <Button
        variant="ghost"
        className="mb-4"
        onClick={() => navigate(role === 'ADMIN' ? '/admin/claims' : '/claims')}
      >
        <ArrowLeft className="h-4 w-4 mr-1" />
        Back
      </Button>

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
                <Badge key={v.key} variant={statusVariant(colVal)} title={res?.summary ?? ''}>
                  {v.label}: {colVal}
                </Badge>
              );
            })}
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleValidate}
              disabled={isValidating || valRun?.status === 'RUNNING' || valRun?.status === 'QUEUED'}
            >
              {valRun?.status === 'RUNNING' || valRun?.status === 'QUEUED' ? 'Validating…' : 'Validate'}
            </Button>
          )}
        </div>
        {valResults.length > 0 && (
          <div className="mt-3 space-y-1 text-sm text-gray-600">
            {VALIDATORS.map((v) => {
              const res = resultFor(v.key);
              if (!res) return null;
              return (
                <div key={v.key}>
                  <span className="font-medium">{v.label}:</span> {res.summary}
                </div>
              );
            })}
          </div>
        )}
      </div>

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
    </div>
  );
}
