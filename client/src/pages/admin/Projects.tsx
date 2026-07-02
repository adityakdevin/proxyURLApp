import { useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { useCrudResource } from '@/hooks/useCrudResource';
import { DataTable } from '@/components/shared/DataTable';
import { TableToolbar } from '@/components/shared/TableToolbar';
import { FilterSelect, STATUS_OPTIONS } from '@/components/shared/FilterSelect';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';

interface Project {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  createdAt: string;
  _count?: {
    categories: number;
    urlConfigurations: number;
    userAssignments: number;
  };
}

export default function Projects() {
  const { toast } = useToast();
  const {
    data,
    isLoading,
    pagination,
    fetchData,
    search,
    setSearch,
    status,
    setStatus,
    sort,
    onSortChange,
    selectedItem,
    setSelectedItem,
    isFormOpen,
    setIsFormOpen,
    isDeleteOpen,
    setIsDeleteOpen,
    isStatusOpen,
    setIsStatusOpen,
    isSubmitting,
    askDelete,
    askStatus,
    submit,
    remove,
    toggleStatus,
  } = useCrudResource<Project>({
    endpoint: '/admin/projects',
    entityName: 'Project',
  });

  const [formData, setFormData] = useState({ name: '', description: '' });

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ name: '', description: '' });
    setIsFormOpen(true);
  };

  const handleEdit = (item: Project) => {
    setSelectedItem(item);
    setFormData({ name: item.name, description: item.description || '' });
    setIsFormOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.name.trim()) {
      toast({ title: 'Validation Error', description: 'Name is required', variant: 'destructive' });
      return;
    }
    submit(formData);
  };

  const columns: ColumnDef<Project>[] = [
    { accessorKey: 'name', header: 'Name', meta: { sortField: 'name' } },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description || '-' },
    {
      accessorKey: 'status',
      header: 'Status',
      meta: { sortField: 'status' },
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge>
      ),
    },
    {
      id: 'usage',
      header: 'Usage',
      cell: ({ row }) => {
        const counts = row.original._count;
        if (!counts) return '-';
        return <span className="text-sm text-muted-foreground">{counts.categories} categories, {counts.userAssignments} users</span>;
      },
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleEdit(row.original)}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => askStatus(row.original)}>
              {row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => askDelete(row.original)} className="text-destructive">
              <Trash2 className="mr-2 h-4 w-4" />Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Projects</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add Project</Button>
      </div>
      <div className="mb-4">
        <TableToolbar search={search} onSearchChange={setSearch} placeholder="Search projects…">
          <FilterSelect value={status} onChange={(v) => setStatus(v as '' | 'ACTIVE' | 'INACTIVE')} allLabel="All statuses" options={STATUS_OPTIONS} />
        </TableToolbar>
      </div>
      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} sort={sort} onSortChange={onSortChange} />
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selectedItem ? 'Edit Project' : 'Create Project'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
              <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Enter name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Enter description" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Project" description={`Are you sure you want to delete "${selectedItem?.name}"? This action cannot be undone.`} confirmText="Delete" onConfirm={remove} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate Project' : 'Activate Project'} description={selectedItem?.status === 'ACTIVE' ? `Are you sure you want to deactivate "${selectedItem?.name}"? Users assigned will lose access.` : `Are you sure you want to activate "${selectedItem?.name}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={toggleStatus} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
    </div>
  );
}
