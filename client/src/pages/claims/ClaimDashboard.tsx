import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Plus } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ClaimBulkBar } from '@/components/claims/ClaimBulkBar';
import { ClaimRowActions } from '@/components/claims/ClaimRowActions';
import { hasRunningChecks, useValidationPolling } from '@/hooks/useValidationPolling';
import { FilterSelect } from '@/components/shared/FilterSelect';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ValidationBadge } from '@/components/ValidationBadge';
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
  spellSummary: string | null;
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

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Client-side mirror of the server folderPath rule. The server is authoritative and
// OS-aware (it enforces the absolute drive-letter form on Windows/production); the
// browser can't know the server's OS, so here we only block the clearly-invalid cases —
// the C:\ drive and ".." segments — and let a valid dev path (e.g. "Claims/Daily/<VIN>")
// through for the server to accept.
const isInvalidFolderPath = (fp: string): boolean =>
  /^[Cc]:\\/.test(fp) || fp.split(/[\\/]/).includes('..');

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
    assignedToUserId?: string;
    assignedToMe: boolean;
    search: string;
  }>({ assignedToMe: false, search: '' });
  // The filters the CURRENT rows were fetched with. `filters` is the live form state and
  // changes as the reviewer types; sending those to a bulk action while the count beside it
  // still describes the old fetch is how "Select all 12 matching" becomes "delete every
  // claim in scope". Only fetchData promotes live filters to applied ones.
  const [appliedFilters, setAppliedFilters] = useState<{
    subCategoryId?: string;
    workflowStatusId?: string;
    assignedToUserId?: string;
    assignedToMe: boolean;
    search: string;
  }>({ assignedToMe: false, search: '' });
  const noAssignment = role !== 'ADMIN' && !user?.projectId;
  const [filterStatuses, setFilterStatuses] = useState<Status[]>([]);

  // Bulk selection: ids, so ticks survive paging — a reviewer gathers rows across pages and
  // then acts. Cleared when the FILTERS change, because those rows are no longer the set on
  // screen; paging leaves it alone. AdminClaims does the same.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

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
  const fetchStatusesForFilter = async () => {
    const r = await api.get<{ data: Status[] }>('/user/status-masters');
    setFilterStatuses(r.data);
  };
  const fetchAssignees = async () => {
    if (!canCreate) return;
    const r = await api.get<{ data: UserOpt[] }>('/user/users-in-scope');
    setAddUsers(r.data);
  };

  /** `quiet` refetches WITHOUT the loading state: the poll runs every few seconds, and
   *  DataTable replaces every row with a "Loading..." cell while isLoading is true, so a
   *  background refresh blanked the whole table on a timer. A user-initiated fetch still
   *  shows the spinner, because there the wait is the thing being reported. */
  const fetchData = async (page = 1, limit = 10, quiet = false) => {
    if (!quiet) setIsLoading(true);
    // Snapshot, but promote it only once the response lands (below, beside setPagination).
    // Promoting here meant a FAILED fetch left the rows and the total describing the old
    // filters while the bulk bar had already advanced to the new ones — the exact split this
    // applied/live pair exists to prevent.
    const requested = filters;
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(limit) });
      if (requested.subCategoryId) params.set('subCategoryId', requested.subCategoryId);
      if (requested.workflowStatusId) params.set('workflowStatusId', requested.workflowStatusId);
      if (requested.assignedToMe) params.set('assignedToMe', 'true');
      if (requested.assignedToUserId) params.set('assignedToUserId', requested.assignedToUserId);
      if (requested.search) params.set('search', requested.search);
      const r = await api.get<PaginatedResponse<ClaimRow>>(`/claims?${params}`);
      setData(r.data);
      setPagination(r.pagination);
      setAppliedFilters(requested);
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      if (!quiet) setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchSubCats();
    fetchAssignees();
    fetchStatusesForFilter();
    fetchData();
  }, []);

  const handleAdd = async () => {
    if (!addForm.subCategoryId)
      return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (!addForm.claimId.trim())
      return toast({ title: 'Claim ID required', variant: 'destructive' });
    const fp = addForm.folderPath.trim();
    if (fp && isInvalidFolderPath(fp)) {
      return toast({
        title: 'Invalid folder path',
        variant: 'destructive',
        description: 'The C:\\ drive and ".." path segments are not allowed.',
      });
    }
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
      setSelectedIds([]);
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

  const handleExport = () => {
    const params = new URLSearchParams();
    if (filters.subCategoryId) params.set('subCategoryId', filters.subCategoryId);
    if (filters.workflowStatusId) params.set('workflowStatusId', filters.workflowStatusId);
    if (filters.assignedToMe) params.set('assignedToMe', 'true');
    if (filters.assignedToUserId) params.set('assignedToUserId', filters.assignedToUserId);
    if (filters.search) params.set('search', filters.search);
    window.open(`/api/claims/export?${params.toString()}`, '_blank');
  };

  const canOpen = (row: ClaimRow): boolean => {
    if (role === 'ADMIN' || role === 'TEAM_LEAD') return true;
    return !!row.assignedTo && row.assignedTo.id === user?.id;
  };

  // Derived once per source change, not once per row per render: these were rebuilt inline
  // inside the actions cell, so every render handed all 100 ClaimRowActions a brand new
  // array identity.
  const statusOptions = useMemo(
    () => filterStatuses.map((s) => ({ value: s.id, label: s.name })),
    [filterStatuses]
  );
  const assigneeOptions = useMemo(
    () => addUsers.map((u) => ({ value: u.id, label: u.fullName })),
    [addUsers]
  );
  const subCatOptions = useMemo(
    () => subCats.map((s) => ({ value: s.id, label: s.name })),
    [subCats]
  );

  /** The applied filters in words, for the bulk confirm — that path lists no rows. */
  const filtersSummary = useMemo(() => {
    const parts: string[] = [];
    const sub = subCats.find((s) => s.id === appliedFilters.subCategoryId);
    if (sub) parts.push(`Sub-Category ${sub.name}`);
    const st = filterStatuses.find((s) => s.id === appliedFilters.workflowStatusId);
    if (st) parts.push(`Status ${st.name}`);
    if (appliedFilters.assignedToMe) parts.push('assigned to me');
    const who = addUsers.find((u) => u.id === appliedFilters.assignedToUserId);
    if (who) parts.push(`assigned to ${who.fullName}`);
    if (appliedFilters.search.trim()) parts.push(`search "${appliedFilters.search.trim()}"`);
    // Empty when nothing is filtered — the dialog has its own wording for that case, and a
    // fallback phrase here read as "Every claim matching no filters — every claim."
    return parts.join(' · ');
  }, [appliedFilters, subCats, filterStatuses, addUsers]);

  // The list used to refetch once, the instant work was QUEUED, and then never again — so
  // every badge still showed its old value and re-validating looked like it did nothing.
  // Poll while anything is running, and for a window after queueing, since queued work does
  // not change a column until the drainer reaches it.
  const { watch: watchValidation, polling } = useValidationPolling(hasRunningChecks(data), () =>
    fetchData(pagination.page, pagination.limit, true)
  );

  const columns: ColumnDef<ClaimRow>[] = [
    {
      accessorKey: 'claimId',
      header: 'Claim ID',
      cell: ({ row }) =>
        canOpen(row.original) ? (
          <button
            className="text-primary underline-offset-2 hover:underline"
            onClick={() => navigate(`/claims/${row.original.id}`, { state: { siblings: data.map((c) => c.id) } })}
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
      cell: ({ row }) => (
        <ValidationBadge
          status={row.original.spellCheckStatus}
          title={row.original.spellSummary ?? undefined}
        />
      ),
    },
    {
      id: 'qr',
      header: 'QR',
      cell: ({ row }) => <ValidationBadge status={row.original.qrStatus} />,
    },
    {
      id: 'meta',
      header: 'Meta',
      cell: ({ row }) => <ValidationBadge status={row.original.metaExtractionStatus} />,
    },
    {
      id: 'intra',
      header: 'Intra-Claim',
      cell: ({ row }) => <ValidationBadge status={row.original.intraClaimStatus} />,
    },
    {
      id: 'full',
      header: 'Full Scan',
      cell: ({ row }) => <ValidationBadge status={row.original.fullScanStatus} />,
    },
    {
      id: 'created',
      header: 'Created',
      cell: ({ row }) => (
        <span className="text-muted-foreground">{relativeTime(row.original.createdAt)}</span>
      ),
    },
    {
      id: 'actions',
      header: 'Actions',
      cell: ({ row }) => (
        <ClaimRowActions
          claimId={row.original.id}
          claimLabel={row.original.claimId}
          canAct={canOpen(row.original)}
          role={role}
          statusOptions={statusOptions}
          assigneeOptions={assigneeOptions}
          onDone={() => {
            // Drop it from the selection too: acting on a row from its own menu used to
            // leave the id ticked, so the bulk bar counted a claim that was no longer there.
            setSelectedIds((ids) => ids.filter((x) => x !== row.original.id));
            fetchData(pagination.page, pagination.limit);
            // Re-validate queues work that will not show for a few seconds.
            watchValidation();
          }}
        />
      ),
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

      {noAssignment && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-md text-amber-800">
          <p className="font-medium">Limited Access</p>
          <p className="text-sm">
            You don't have an active Project assignment, so there are no
            claims to show. Please contact an administrator.
          </p>
        </div>
      )}

      {!noAssignment && (
      <>
      {/* One row: the field labels live inside each control's own value ("Status: All"), which
          is what lets four filters and both buttons share a line. Still explicitly applied —
          the reviewer picks several filters, then fetches once. */}
      <div className="mb-4 flex flex-wrap items-center gap-2 rounded-md border bg-white p-3">
        <Input
          value={filters.search}
          onChange={(e) => setFilters({ ...filters, search: e.target.value })}
          onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)}
          placeholder="Search claim id…"
          className="w-48"
        />
        <FilterSelect
          value={filters.subCategoryId ?? ''}
          onChange={(v) =>
            setFilters({
              ...filters,
              subCategoryId: v || undefined,
              workflowStatusId: undefined,
            })
          }
          allLabel="All"
          prefix="Sub-Category"
          options={subCatOptions}
          className="w-[200px]"
        />
        <FilterSelect
          value={filters.workflowStatusId ?? ''}
          onChange={(v) => setFilters({ ...filters, workflowStatusId: v || undefined })}
          allLabel="All"
          prefix="Status"
          options={statusOptions}
          className="w-[170px]"
        />
        {role === 'USER' ? (
          <Label
            htmlFor="amt"
            className="flex h-10 cursor-pointer items-center gap-2 rounded-md border px-3"
          >
            <input
              id="amt"
              type="checkbox"
              checked={filters.assignedToMe}
              onChange={(e) => setFilters({ ...filters, assignedToMe: e.target.checked })}
            />
            Assigned to me
          </Label>
        ) : (
          <FilterSelect
            value={filters.assignedToUserId ?? ''}
            onChange={(v) => setFilters({ ...filters, assignedToUserId: v || undefined })}
            allLabel="All"
            prefix="Assigned"
            options={assigneeOptions}
            className="w-[180px]"
          />
        )}
        <div className="ml-auto flex gap-2">
          <Button variant="outline" onClick={handleExport}>
            Export
          </Button>
          <Button
            onClick={() => {
              setSelectedIds([]);
              fetchData(1, pagination.limit);
            }}
          >
            Apply filters
          </Button>
        </div>
      </div>

      {polling && (
        // Says the quiet part out loud: queued work changes nothing on screen until the
        // drainer reaches it, and silence there is what made this look broken.
        <div className="mb-3 flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-900">
          <span className="h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          Validation running — this list refreshes itself until it finishes.
        </div>
      )}
      <ClaimBulkBar
        selectedIds={selectedIds}
        onClear={() => setSelectedIds([])}
        matchingTotal={pagination.total}
        filters={{
          subCategoryId: appliedFilters.subCategoryId,
          workflowStatusId: appliedFilters.workflowStatusId,
          assignedToUserId: appliedFilters.assignedToUserId,
          assignedToMe: appliedFilters.assignedToMe,
          search: appliedFilters.search.trim() || undefined,
        }}
        filtersSummary={filtersSummary}
        role={role}
        statusOptions={statusOptions}
        assigneeOptions={assigneeOptions}
        onDone={() => {
          fetchData(pagination.page, pagination.limit);
          watchValidation();
        }}
      />
      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(p) => fetchData(p, pagination.limit)}
        onPageSizeChange={(l) => fetchData(1, l)}
        isLoading={isLoading}
        selection={{
          selectedIds,
          onChange: setSelectedIds,
          rowId: (row) => row.id,
          rowLabel: (row) => row.claimId,
          // A USER may only act on claims assigned to them — the same rule that decides
          // whether the row opens at all, so the box never promises an action that 403s.
          isSelectable: canOpen,
        }}
      />
      </>
      )}

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
