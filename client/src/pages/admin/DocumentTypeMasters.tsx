import { useEffect, useState, useMemo } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';

type Category = 'GOVT' | 'CUSTOM';
type GovtCode = 'AADHAR' | 'PAN' | 'DL' | 'PASSPORT' | 'VOTER_ID' | 'RATION_CARD';
const GOVT_LABELS: Record<GovtCode, string> = {
  AADHAR: 'Aadhar Card',
  PAN: 'PAN Card',
  DL: 'Driving License',
  PASSPORT: 'Passport',
  VOTER_ID: 'Voter ID',
  RATION_CARD: 'Ration Card',
};

interface DocType {
  id: string;
  name: string;
  category: Category;
  govtCode: GovtCode | null;
  displayOrder: number;
  isRequired: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export default function DocumentTypeMasters() {
  const { toast } = useToast();
  const [data, setData] = useState<DocType[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<DocType | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<{
    name: string;
    category: Category;
    govtCode: GovtCode | '';
    displayOrder: number;
    isRequired: boolean;
  }>({ name: '', category: 'CUSTOM', govtCode: '', displayOrder: 0, isRequired: true });
  // All ACTIVE GOVT docs for the selected SubCategory (not just the current page),
  // so the "code already used" filter is accurate regardless of pagination.
  const [allGovtDocs, setAllGovtDocs] = useState<DocType[]>([]);

  const fetchAllGovtDocs = async () => {
    try {
      const r = await api.get<PaginatedResponse<DocType>>(
        `/admin/document-type-masters?category=GOVT&status=ACTIVE&limit=100`
      );
      setAllGovtDocs(r.data);
    } catch {
      setAllGovtDocs([]);
    }
  };

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const r = await api.get<PaginatedResponse<DocType>>(
        `/admin/document-type-masters?page=${page}&limit=${limit}`
      );
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
    fetchData();
    fetchAllGovtDocs();
  }, []);

  const usedCodes = useMemo(
    () =>
      new Set(
        allGovtDocs
          .filter((d) => d.govtCode && d.id !== selected?.id)
          .map((d) => d.govtCode as GovtCode)
      ),
    [allGovtDocs, selected]
  );

  const availableCodes = (Object.keys(GOVT_LABELS) as GovtCode[]).filter(
    (c) => !usedCodes.has(c)
  );

  const handleSubmit = async () => {
    if (formData.category === 'GOVT' && !formData.govtCode)
      return toast({ title: 'Pick a Govt code', variant: 'destructive' });
    if (!formData.name.trim()) return toast({ title: 'Name required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      if (selected) {
        await api.put(`/admin/document-type-masters/${selected.id}`, {
          name: formData.name,
          displayOrder: formData.displayOrder,
          isRequired: formData.isRequired,
        });
      } else {
        const payload: Record<string, unknown> = {
          name: formData.name,
          category: formData.category,
          displayOrder: formData.displayOrder,
          isRequired: formData.isRequired,
        };
        if (formData.category === 'GOVT') payload.govtCode = formData.govtCode;
        await api.post('/admin/document-type-masters', payload);
      }
      toast({ title: 'Saved' });
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
      fetchAllGovtDocs();
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Save failed',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/document-type-masters/${selected.id}`);
      toast({ title: 'Deleted' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (d: DocType) => {
    try {
      await api.patch(`/admin/document-type-masters/${d.id}/status`, {
        status: d.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      });
      fetchData(pagination.page, pagination.limit);
      fetchAllGovtDocs();
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed to update status',
      });
    }
  };

  const columns: ColumnDef<DocType>[] = [
    { accessorKey: 'name', header: 'Name' },
    {
      id: 'category',
      header: 'Category',
      cell: ({ row }) => (
        <Badge variant={row.original.category === 'GOVT' ? 'default' : 'secondary'}>
          {row.original.category}
        </Badge>
      ),
    },
    {
      id: 'govtCode',
      header: 'Govt Code',
      cell: ({ row }) => row.original.govtCode ?? '-',
    },
    { accessorKey: 'displayOrder', header: 'Order' },
    {
      id: 'required',
      header: 'Required',
      cell: ({ row }) => (
        <Badge variant={row.original.isRequired ? 'default' : 'outline'}>
          {row.original.isRequired ? 'Required' : 'Optional'}
        </Badge>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>
          {row.original.status}
        </Badge>
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
                setFormData({
                  name: row.original.name,
                  category: row.original.category,
                  govtCode: (row.original.govtCode ?? '') as GovtCode | '',
                  displayOrder: row.original.displayOrder,
                  isRequired: row.original.isRequired,
                });
                setIsFormOpen(true);
              }}
            >
              <Pencil className="mr-2 h-4 w-4" />
              Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => handleToggle(row.original)}>
              {row.original.status === 'ACTIVE' ? (
                <>
                  <PowerOff className="mr-2 h-4 w-4" />
                  Deactivate
                </>
              ) : (
                <>
                  <Power className="mr-2 h-4 w-4" />
                  Activate
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
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Document Type Masters</h1>
        <Button
          onClick={() => {
            setSelected(null);
            setFormData({ name: '', category: 'CUSTOM', govtCode: '', displayOrder: 0, isRequired: true });
            setIsFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Document Type
        </Button>
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
            <DialogTitle>{selected ? 'Edit Document Type' : 'Add Document Type'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div className="space-y-2">
              <Label>Category</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="cat"
                    value="GOVT"
                    checked={formData.category === 'GOVT'}
                    onChange={() =>
                      setFormData({ ...formData, category: 'GOVT', govtCode: '', name: '' })
                    }
                    disabled={!!selected}
                  />
                  GOVT
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="cat"
                    value="CUSTOM"
                    checked={formData.category === 'CUSTOM'}
                    onChange={() =>
                      setFormData({ ...formData, category: 'CUSTOM', govtCode: '', name: '' })
                    }
                    disabled={!!selected}
                  />
                  CUSTOM
                </label>
              </div>
            </div>
            {formData.category === 'GOVT' && !selected && (
              <div className="space-y-2">
                <Label>Govt Code</Label>
                <Select
                  value={formData.govtCode}
                  onValueChange={(v) =>
                    setFormData({
                      ...formData,
                      govtCode: v as GovtCode,
                      name: GOVT_LABELS[v as GovtCode],
                    })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a Govt document" />
                  </SelectTrigger>
                  <SelectContent>
                    {availableCodes.map((c) => (
                      <SelectItem key={c} value={c}>
                        {GOVT_LABELS[c]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Name</Label>
              <Input
                value={formData.name}
                onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label>Display Order</Label>
              <Input
                type="number"
                value={formData.displayOrder}
                onChange={(e) =>
                  setFormData({ ...formData, displayOrder: Number(e.target.value) })
                }
              />
            </div>
            <div className="flex items-center gap-2">
              <input
                id="isRequired"
                type="checkbox"
                checked={formData.isRequired}
                onChange={(e) => setFormData({ ...formData, isRequired: e.target.checked })}
              />
              <Label htmlFor="isRequired">Required for Full-scan validation</Label>
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
        title="Delete Document Type"
        description={`Delete "${selected?.name}"?`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={isSubmitting}
      />
    </div>
  );
}
