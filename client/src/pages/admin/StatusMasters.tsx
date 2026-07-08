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

interface StatusMaster {
  id: string;
  name: string;
  displayOrder: number;
  isDefault: boolean;
  isTerminal: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
}

export default function StatusMasters() {
  const { toast } = useToast();
  const [data, setData] = useState<StatusMaster[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [selected, setSelected] = useState<StatusMaster | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    displayOrder: 0,
    isDefault: false,
    isTerminal: false,
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const r = await api.get<PaginatedResponse<StatusMaster>>(
        `/admin/status-masters?page=${page}&limit=${limit}`
      );
      setData(r.data);
      setPagination(r.pagination);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Failed',
        variant: 'destructive',
      });
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const handleSubmit = async () => {
    if (!formData.name.trim())
      return toast({ title: 'Validation', description: 'Name required', variant: 'destructive' });
    setIsSubmitting(true);
    try {
      if (selected) await api.put(`/admin/status-masters/${selected.id}`, formData);
      else await api.post('/admin/status-masters', formData);
      toast({ title: 'Saved' });
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Save failed',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selected) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/status-masters/${selected.id}`);
      toast({ title: 'Deleted' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({
        title: 'Error',
        description: e instanceof Error ? e.message : 'Delete failed',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleToggle = async (s: StatusMaster) => {
    try {
      await api.patch(`/admin/status-masters/${s.id}/status`, {
        status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE',
      });
      fetchData(pagination.page, pagination.limit);
    } catch (e) {
      toast({
        title: 'Error',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    }
  };

  const columns: ColumnDef<StatusMaster>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'displayOrder', header: 'Order' },
    {
      id: 'isDefault',
      header: 'Default',
      cell: ({ row }) => (row.original.isDefault ? <Badge>Default</Badge> : '-'),
    },
    {
      id: 'isTerminal',
      header: 'Terminal',
      cell: ({ row }) =>
        row.original.isTerminal ? <Badge variant="secondary">End</Badge> : '-',
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
                  displayOrder: row.original.displayOrder,
                  isDefault: row.original.isDefault,
                  isTerminal: row.original.isTerminal,
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
        <h1 className="text-2xl font-bold">Status Masters</h1>
        <Button
          onClick={() => {
            setSelected(null);
            setFormData({ name: '', displayOrder: 0, isDefault: false, isTerminal: false });
            setIsFormOpen(true);
          }}
        >
          <Plus className="mr-2 h-4 w-4" />
          Add Status
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
            <DialogTitle>{selected ? 'Edit Status' : 'Add Status'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
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
                type="checkbox"
                id="def"
                checked={formData.isDefault}
                onChange={(e) => setFormData({ ...formData, isDefault: e.target.checked })}
              />
              <Label htmlFor="def">Default status for new claims</Label>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="term"
                checked={formData.isTerminal}
                onChange={(e) => setFormData({ ...formData, isTerminal: e.target.checked })}
              />
              <Label htmlFor="term">Terminal (closed) status</Label>
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
        title="Delete Status"
        description={`Delete "${selected?.name}"?`}
        confirmText="Delete"
        variant="destructive"
        onConfirm={handleDelete}
        isLoading={isSubmitting}
      />
    </div>
  );
}
