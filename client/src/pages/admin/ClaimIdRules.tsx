import { useEffect, useState } from 'react';
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
import {
  SubCategoryPicker,
  SubCategoryPickerValue,
} from '@/components/shared/SubCategoryPicker';

interface Rule {
  id: string;
  subCategoryId: string;
  startPosition: number;
  length: number;
  scanTarget: 'FOLDER' | 'FILE';
  scanLocation: string;
  status: 'ACTIVE' | 'INACTIVE';
}

function validateLocation(v: string): string | null {
  if (!/^[A-Za-z]:\\.+/.test(v)) return 'Must be a drive-letter path like D:\\Claims\\Daily';
  if (/^[Cc]:\\/.test(v)) return 'C drive is not allowed';
  return null;
}

export default function ClaimIdRules() {
  const { toast } = useToast();
  const [data, setData] = useState<Rule[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<Rule | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState<{
    startPosition: number;
    length: number;
    scanTarget: 'FOLDER' | 'FILE';
    scanLocation: string;
  }>({ startPosition: 1, length: 8, scanTarget: 'FOLDER', scanLocation: '' });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = picker.subCategoryId
        ? `/admin/claim-id-rules?page=${page}&limit=${limit}&subCategoryId=${picker.subCategoryId}`
        : `/admin/claim-id-rules?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<Rule>>(url);
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
  }, [picker.subCategoryId]);

  const handleSubmit = async () => {
    if (!picker.subCategoryId)
      return toast({ title: 'Pick a SubCategory', variant: 'destructive' });
    const locErr = validateLocation(formData.scanLocation);
    if (locErr)
      return toast({ title: 'Invalid location', description: locErr, variant: 'destructive' });
    setIsSubmitting(true);
    try {
      if (selected) {
        await api.put(`/admin/claim-id-rules/${selected.id}`, formData);
      } else {
        await api.post('/admin/claim-id-rules', {
          subCategoryId: picker.subCategoryId,
          ...formData,
        });
      }
      toast({ title: 'Saved' });
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
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
      await api.delete(`/admin/claim-id-rules/${selected.id}`);
      toast({ title: 'Deleted' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (r: Rule) => {
    await api.patch(`/admin/claim-id-rules/${r.id}/status`, {
      status: r.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
    });
    fetchData(pagination.page, pagination.limit);
  };

  const columns: ColumnDef<Rule>[] = [
    { accessorKey: 'startPosition', header: 'Start' },
    { accessorKey: 'length', header: 'Length' },
    { accessorKey: 'scanTarget', header: 'Target' },
    { accessorKey: 'scanLocation', header: 'Location' },
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
                  startPosition: row.original.startPosition,
                  length: row.original.length,
                  scanTarget: row.original.scanTarget,
                  scanLocation: row.original.scanLocation,
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
        <h1 className="text-2xl font-bold">Claim ID Rules</h1>
        <Button
          onClick={() => {
            setSelected(null);
            setFormData({
              startPosition: 1,
              length: 8,
              scanTarget: 'FOLDER',
              scanLocation: '',
            });
            setIsFormOpen(true);
          }}
          disabled={!picker.subCategoryId || data.length > 0}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Rule
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Start Position</Label>
                <Input
                  type="number"
                  min={1}
                  value={formData.startPosition}
                  onChange={(e) =>
                    setFormData({ ...formData, startPosition: Number(e.target.value) })
                  }
                />
              </div>
              <div className="space-y-2">
                <Label>Length</Label>
                <Input
                  type="number"
                  min={1}
                  value={formData.length}
                  onChange={(e) => setFormData({ ...formData, length: Number(e.target.value) })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scan Target</Label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="tgt"
                    checked={formData.scanTarget === 'FOLDER'}
                    onChange={() => setFormData({ ...formData, scanTarget: 'FOLDER' })}
                  />
                  Folder names
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="tgt"
                    checked={formData.scanTarget === 'FILE'}
                    onChange={() => setFormData({ ...formData, scanTarget: 'FILE' })}
                  />
                  File names
                </label>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Scan Location</Label>
              <Input
                value={formData.scanLocation}
                onChange={(e) => setFormData({ ...formData, scanLocation: e.target.value })}
                placeholder="D:\\Claims\\Daily"
              />
              <p className="text-xs text-gray-500">
                Must be a drive letter path. C:\\ is not allowed.
              </p>
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
        title="Delete Rule"
        description="Delete this rule?"
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={isSubmitting}
      />
    </div>
  );
}
