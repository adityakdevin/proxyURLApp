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
        <div className="flex flex-wrap gap-2 mt-4">
          <Badge variant="outline">Spell: {claim.spellCheckStatus}</Badge>
          <Badge variant="outline">QR: {claim.qrStatus}</Badge>
          <Badge variant="outline">Meta: {claim.metaExtractionStatus}</Badge>
          <Badge variant="outline">Intra-Claim: {claim.intraClaimStatus}</Badge>
          <Badge variant="outline">Full Scan: {claim.fullScanStatus}</Badge>
        </div>
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
        <h2 className="text-lg font-semibold mb-4">Documents</h2>
        <p className="text-sm text-gray-500">
          Documents will appear here once the scanner is enabled (Phase 2).
        </p>
      </div>

      <div className="bg-white border rounded-md p-6">
        <h2 className="text-lg font-semibold mb-4">Remarks Timeline</h2>
        <div className="space-y-3">
          {claim.remarks.length === 0 && (
            <p className="text-sm text-gray-400">No remarks yet.</p>
          )}
          {claim.remarks.map((r) => (
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
      </div>
    </div>
  );
}
