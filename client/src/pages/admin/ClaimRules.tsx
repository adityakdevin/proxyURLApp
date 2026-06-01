import { useEffect, useMemo, useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { SubCategoryPicker, SubCategoryPickerValue } from '@/components/shared/SubCategoryPicker';

type RuleField =
  | 'DOCUMENT_COUNT'
  | 'REMARK_COUNT'
  | 'ASSIGNED'
  | 'HAS_DOCUMENT_TYPE'
  | 'WORKFLOW_STATUS'
  | 'SPELL_STATUS'
  | 'QR_STATUS'
  | 'META_STATUS'
  | 'INTRA_STATUS'
  | 'FULL_STATUS';
type RuleOperator = 'EQ' | 'NEQ' | 'GTE' | 'LTE' | 'GT' | 'LT';
interface Rule {
  id: string;
  name: string;
  field: RuleField;
  operator: RuleOperator;
  value: string;
  status: 'ACTIVE' | 'INACTIVE';
}
const FIELD_LABELS: Record<RuleField, string> = {
  DOCUMENT_COUNT: 'Document Count',
  REMARK_COUNT: 'Remark Count',
  ASSIGNED: 'Assigned',
  HAS_DOCUMENT_TYPE: 'Has Document Type',
  WORKFLOW_STATUS: 'Workflow Status',
  SPELL_STATUS: 'Spell Check',
  QR_STATUS: 'QR Check',
  META_STATUS: 'Meta Extraction',
  INTRA_STATUS: 'Intra-Claim',
  FULL_STATUS: 'Full Scan',
};
const OP_LABELS: Record<RuleOperator, string> = { EQ: '=', NEQ: '≠', GTE: '≥', LTE: '≤', GT: '>', LT: '<' };
const NUMERIC_FIELDS: RuleField[] = ['DOCUMENT_COUNT', 'REMARK_COUNT'];
const STATUS_FIELDS: RuleField[] = ['SPELL_STATUS', 'QR_STATUS', 'META_STATUS', 'INTRA_STATUS', 'FULL_STATUS'];
const VALIDATION_VALUES = ['PENDING', 'IN_PROGRESS', 'PASSED', 'FAILED'];
const opsFor = (f: RuleField): RuleOperator[] =>
  NUMERIC_FIELDS.includes(f) ? ['EQ', 'NEQ', 'GTE', 'LTE', 'GT', 'LT'] : ['EQ', 'NEQ'];

export default function ClaimRules() {
  const { toast } = useToast();
  const [data, setData] = useState<Rule[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<Rule | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [docTypeNames, setDocTypeNames] = useState<string[]>([]);
  const [statusNames, setStatusNames] = useState<string[]>([]);
  const [form, setForm] = useState<{ name: string; field: RuleField; operator: RuleOperator; value: string }>({
    name: '',
    field: 'DOCUMENT_COUNT',
    operator: 'GTE',
    value: '',
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/claim-rules?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/claim-rules?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<Rule>>(url);
      setData(r.data);
      setPagination(r.pagination);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    if (picker.subCategoryId) {
      api
        .get<{ data: { name: string }[] }>(`/admin/document-type-masters?subCategoryId=${picker.subCategoryId}&limit=100`)
        .then((r) => setDocTypeNames(r.data.map((d) => d.name)))
        .catch(() => setDocTypeNames([]));
      api
        .get<{ data: { name: string }[] }>(`/admin/status-masters?subCategoryId=${picker.subCategoryId}&limit=100`)
        .then((r) => setStatusNames(r.data.map((s) => s.name)))
        .catch(() => setStatusNames([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picker.subCategoryId]);

  const valueOptions = useMemo((): string[] | null => {
    if (form.field === 'ASSIGNED') return ['true', 'false'];
    if (form.field === 'HAS_DOCUMENT_TYPE') return docTypeNames;
    if (form.field === 'WORKFLOW_STATUS') return statusNames;
    if (STATUS_FIELDS.includes(form.field)) return VALIDATION_VALUES;
    return null;
  }, [form.field, docTypeNames, statusNames]);

  const openAdd = () => {
    setSelected(null);
    setForm({ name: '', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '' });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!picker.subCategoryId) return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    if (!form.name.trim()) return toast({ title: 'Name required', variant: 'destructive' });
    if (!form.value.trim()) return toast({ title: 'Value required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      if (selected) {
        await api.put(`/admin/claim-rules/${selected.id}`, {
          name: form.name,
          field: form.field,
          operator: form.operator,
          value: form.value,
        });
      } else {
        await api.post('/admin/claim-rules', {
          subCategoryId: picker.subCategoryId,
          name: form.name,
          field: form.field,
          operator: form.operator,
          value: form.value,
        });
      }
      toast({ title: 'Saved' });
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Save failed' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/claim-rules/${selected.id}`);
      toast({ title: 'Deleted' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Delete failed' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (r: Rule) => {
    try {
      await api.patch(`/admin/claim-rules/${r.id}/status`, { status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' });
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({ title: 'Error', variant: 'destructive', description: e instanceof Error ? e.message : 'Failed' });
    }
  };

  const columns: ColumnDef<Rule>[] = [
    { accessorKey: 'name', header: 'Name' },
    {
      id: 'rule',
      header: 'Rule',
      cell: ({ row }) => `${FIELD_LABELS[row.original.field]} ${OP_LABELS[row.original.operator]} ${row.original.value}`,
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              onClick={() => {
                setSelected(row.original);
                setForm({
                  name: row.original.name,
                  field: row.original.field,
                  operator: row.original.operator,
                  value: row.original.value,
                });
                setIsFormOpen(true);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" /> Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>
              {row.original.status === 'ACTIVE' ? (
                <>
                  <PowerOff className="mr-2 h-4 w-4" /> Deactivate
                </>
              ) : (
                <>
                  <Power className="mr-2 h-4 w-4" /> Activate
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="text-destructive"
              onClick={() => {
                setSelected(row.original);
                setIsDeleteOpen(true);
              }}
            >
              <Trash2 className="mr-2 h-4 w-4" /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claim Rules</h1>
        <Button onClick={openAdd} disabled={!picker.subCategoryId}>
          <Plus className="mr-2 h-4 w-4" /> Add Rule
        </Button>
      </div>

      <div className="mb-4 p-4 bg-white border rounded-md">
        <SubCategoryPicker value={picker} onChange={setPicker} />
      </div>

      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(p) => fetchData(p, pagination.limit)}
        onPageSizeChange={(l) => fetchData(1, l)}
        isLoading={isLoading}
      />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selected ? 'Edit Rule' : 'Add Rule'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Name</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div className="space-y-2">
              <Label>Field</Label>
              <Select
                value={form.field}
                onValueChange={(v) => {
                  const field = v as RuleField;
                  const ops = opsFor(field);
                  setForm({ ...form, field, operator: ops.includes(form.operator) ? form.operator : ops[0], value: '' });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(FIELD_LABELS) as RuleField[]).map((f) => (
                    <SelectItem key={f} value={f}>
                      {FIELD_LABELS[f]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Operator</Label>
              <Select value={form.operator} onValueChange={(v) => setForm({ ...form, operator: v as RuleOperator })}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {opsFor(form.field).map((o) => (
                    <SelectItem key={o} value={o}>
                      {OP_LABELS[o]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Value</Label>
              {valueOptions ? (
                <Select value={form.value} onValueChange={(v) => setForm({ ...form, value: v })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select a value" />
                  </SelectTrigger>
                  <SelectContent>
                    {valueOptions.map((v) => (
                      <SelectItem key={v} value={v}>
                        {v}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input type="number" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>
              {isSubmitting ? 'Saving...' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Delete rule?"
        description="This cannot be undone."
        onConfirm={handleDelete}
      />
    </div>
  );
}
