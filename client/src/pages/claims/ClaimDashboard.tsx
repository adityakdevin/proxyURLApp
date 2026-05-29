import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/use-toast';
import { useAuthStore } from '@/stores/authStore';

interface ClaimRow {
  id: string;
  claimId: string;
  workflowStatus: { id: string; name: string; isTerminal: boolean };
  subCategory: { id: string; name: string };
  assignedTo: { id: string; fullName: string } | null;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
  createdAt: string;
}

interface SubCat {
  id: string;
  name: string;
  category: { id: string; name: string };
}
interface Status {
  id: string;
  name: string;
  isTerminal: boolean;
  isDefault: boolean;
}
interface UserOpt {
  id: string;
  fullName: string;
}

export default function ClaimDashboard() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { user } = useAuthStore();
  const role = user?.role ?? 'USER';
  const canCreate = role === 'TEAM_LEAD' || role === 'ADMIN';

  const [data, setData] = useState<ClaimRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [subCats, setSubCats] = useState<SubCat[]>([]);
  const [filters, setFilters] = useState<{
    subCategoryId?: string;
    workflowStatusId?: string;
    assignedToMe: boolean;
    search: string;
  }>({ assignedToMe: false, search: '' });
  const [filterStatuses, setFilterStatuses] = useState<Status[]>([]);

  const [isAddOpen, setIsAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<{
    subCategoryId?: string;
    claimId: string;
    folderPath: string;
    assignedToUserId?: string;
    remarkText: string;
  }>({ claimId: '', folderPath: '', remarkText: '' });
  const [addUsers, setAddUsers] = useState<UserOpt[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchSubCats = async () => {
    const r = await api.get<{ data: SubCat[] }>('/user/sub-categories');
    setSubCats(r.data);
  };
  const fetchStatusesForFilter = async (subCategoryId: string) => {
    const r = await api.get<{ data: Status[] }>(
      `/user/status-masters?subCategoryId=${subCategoryId}`
    );
    setFilterStatuses(r.data);
  };
  const fetchAssignees = async () => {
    if (!canCreate) return;
    const r = await api.get<{ data: UserOpt[] }>('/user/users-in-scope');
    setAddUsers(r.data);
  };

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (filters.subCategoryId) params.set('subCategoryId', filters.subCategoryId);
      if (filters.workflowStatusId) params.set('workflowStatusId', filters.workflowStatusId);
      if (filters.assignedToMe) params.set('assignedToMe', 'true');
      if (filters.search) params.set('search', filters.search);
      const r = await api.get<PaginatedResponse<ClaimRow>>(`/claims?${params}`);
      setData(r.data);
      setPagination(r.pagination);
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
    fetchSubCats();
    fetchAssignees();
    fetchData();
  }, []);
  useEffect(() => {
    if (filters.subCategoryId) fetchStatusesForFilter(filters.subCategoryId);
    else setFilterStatuses([]);
  }, [filters.subCategoryId]);

  const handleAdd = async () => {
    if (!addForm.subCategoryId)
      return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (!addForm.claimId.trim())
      return toast({ title: 'Claim ID required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        subCategoryId: addForm.subCategoryId,
        claimId: addForm.claimId.trim(),
      };
      if (addForm.folderPath.trim()) payload.folderPath = addForm.folderPath.trim();
      if (addForm.assignedToUserId) payload.assignedToUserId = addForm.assignedToUserId;
      if (addForm.remarkText.trim()) payload.remarkText = addForm.remarkText.trim();
      await api.post('/claims', payload);
      toast({ title: 'Claim created' });
      setIsAddOpen(false);
      setAddForm({ claimId: '', folderPath: '', remarkText: '' });
      fetchData(1, pagination.limit);
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Create failed',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const canOpen = (row: ClaimRow): boolean => {
    if (role === 'ADMIN' || role === 'TEAM_LEAD') return true;
    return !!row.assignedTo && row.assignedTo.id === user?.id;
  };

  const columns: ColumnDef<ClaimRow>[] = [
    {
      accessorKey: 'claimId',
      header: 'Claim ID',
      cell: ({ row }) =>
        canOpen(row.original) ? (
          <button
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => navigate(`/claims/${row.original.id}`)}
          >
            {row.original.claimId}
          </button>
        ) : (
          <span className="text-muted-foreground">{row.original.claimId}</span>
        ),
    },
    {
      id: 'sub',
      header: 'Sub-Category',
      cell: ({ row }) => row.original.subCategory.name,
    },
    {
      id: 'status',
      header: 'Workflow',
      cell: ({ row }) => (
        <Badge variant={row.original.workflowStatus.isTerminal ? 'secondary' : 'default'}>
          {row.original.workflowStatus.name}
        </Badge>
      ),
    },
    {
      id: 'assignee',
      header: 'Assigned To',
      cell: ({ row }) =>
        row.original.assignedTo?.fullName ?? (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      id: 'spell',
      header: 'Spell',
      cell: ({ row }) => <Badge variant="outline">{row.original.spellCheckStatus}</Badge>,
    },
    {
      id: 'qr',
      header: 'QR',
      cell: ({ row }) => <Badge variant="outline">{row.original.qrStatus}</Badge>,
    },
    {
      id: 'meta',
      header: 'Meta',
      cell: ({ row }) => <Badge variant="outline">{row.original.metaExtractionStatus}</Badge>,
    },
    {
      id: 'intra',
      header: 'Intra-Claim',
      cell: ({ row }) => <Badge variant="outline">{row.original.intraClaimStatus}</Badge>,
    },
    {
      id: 'full',
      header: 'Full Scan',
      cell: ({ row }) => <Badge variant="outline">{row.original.fullScanStatus}</Badge>,
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claim Dashboard</h1>
        {canCreate && (
          <Button onClick={() => setIsAddOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Claim
          </Button>
        )}
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md grid grid-cols-4 gap-3">
        <div className="space-y-1">
          <Label>Sub-Category</Label>
          <Select
            value={filters.subCategoryId ?? ''}
            onValueChange={(v) =>
              setFilters({
                ...filters,
                subCategoryId: v || undefined,
                workflowStatusId: undefined,
              })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              {subCats.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Workflow Status</Label>
          <Select
            value={filters.workflowStatusId ?? ''}
            onValueChange={(v) =>
              setFilters({ ...filters, workflowStatusId: v || undefined })
            }
            disabled={!filters.subCategoryId}
          >
            <SelectTrigger>
              <SelectValue placeholder="All" />
            </SelectTrigger>
            <SelectContent>
              {filterStatuses.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {role === 'USER' && (
          <div className="space-y-1">
            <Label>&nbsp;</Label>
            <div className="flex items-center gap-2 pt-2">
              <input
                id="amt"
                type="checkbox"
                checked={filters.assignedToMe}
                onChange={(e) => setFilters({ ...filters, assignedToMe: e.target.checked })}
              />
              <Label htmlFor="amt">Assigned to me only</Label>
            </div>
          </div>
        )}
        <div className="space-y-1">
          <Label>Search</Label>
          <Input
            value={filters.search}
            onChange={(e) => setFilters({ ...filters, search: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)}
            placeholder="Claim ID contains..."
          />
        </div>
        <div className="col-span-4 flex justify-end">
          <Button onClick={() => fetchData(1, pagination.limit)}>Apply filters</Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(p) => fetchData(p, pagination.limit)}
        onPageSizeChange={(l) => fetchData(1, l)}
        isLoading={isLoading}
      />

      <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add Claim</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Sub-Category</Label>
              <Select
                value={addForm.subCategoryId ?? ''}
                onValueChange={(v) => setAddForm({ ...addForm, subCategoryId: v })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Pick a sub-category" />
                </SelectTrigger>
                <SelectContent>
                  {subCats.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Claim ID</Label>
              <Input
                value={addForm.claimId}
                onChange={(e) => setAddForm({ ...addForm, claimId: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Folder Path (optional)</Label>
              <Input
                value={addForm.folderPath}
                onChange={(e) => setAddForm({ ...addForm, folderPath: e.target.value })}
                placeholder="D:\\Claims\\Daily\\..."
              />
            </div>
            <div className="space-y-2">
              <Label>Assign to (optional)</Label>
              <Select
                value={addForm.assignedToUserId ?? ''}
                onValueChange={(v) =>
                  setAddForm({ ...addForm, assignedToUserId: v || undefined })
                }
              >
                <SelectTrigger>
                  <SelectValue placeholder="Unassigned" />
                </SelectTrigger>
                <SelectContent>
                  {addUsers.map((u) => (
                    <SelectItem key={u.id} value={u.id}>
                      {u.fullName}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Initial Remark (optional)</Label>
              <Textarea
                value={addForm.remarkText}
                onChange={(e) => setAddForm({ ...addForm, remarkText: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsAddOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleAdd} disabled={isSubmitting}>
              {isSubmitting ? 'Creating...' : 'Create'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
