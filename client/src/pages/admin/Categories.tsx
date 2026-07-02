import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
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
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';

interface Category {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  project: { id: string; name: string };
  _count?: { subCategories: number; urlConfigurations: number };
}

interface SelectOption {
  id: string;
  name: string;
}

export default function Categories() {
  const { toast } = useToast();
  const [projects, setProjects] = useState<SelectOption[]>([]);
  const [filterProject, setFilterProject] = useState('');
  const crud = useCrudResource<Category>({
    endpoint: '/admin/categories',
    entityName: 'Category',
    filters: { projectId: filterProject },
  });
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
  } = crud;

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    projectId: '',
  });

  const fetchSelectOptions = async () => {
    try {
      const pt = await api.get<PaginatedResponse<SelectOption>>('/admin/projects?limit=100');
      setProjects(pt.data || []);
    } catch (error) {
      console.error('Failed to fetch options:', error);
    }
  };

  useEffect(() => {
    fetchSelectOptions();
  }, []);

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ name: '', description: '', projectId: '' });
    setIsFormOpen(true);
  };

  const handleEdit = (item: Category) => {
    setSelectedItem(item);
    setFormData({
      name: item.name,
      description: item.description || '',
      projectId: item.project.id,
    });
    setIsFormOpen(true);
  };

  const handleSubmit = () => {
    if (!formData.name.trim() || !formData.projectId) {
      toast({ title: 'Validation Error', description: 'Name and Project are required', variant: 'destructive' });
      return;
    }
    submit(formData);
  };

  const columns: ColumnDef<Category>[] = [
    { accessorKey: 'name', header: 'Name', meta: { sortField: 'name' } },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description || '-' },
    { id: 'project', header: 'Project', cell: ({ row }) => row.original.project.name },
    {
      accessorKey: 'status',
      header: 'Status',
      meta: { sortField: 'status' },
      cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge>,
    },
    {
      id: 'usage',
      header: 'Usage',
      cell: ({ row }) => {
        const counts = row.original._count;
        if (!counts) return '-';
        return <span className="text-sm text-muted-foreground">{counts.subCategories} sub-cats</span>;
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
        <h1 className="text-2xl font-bold">Categories</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add Category</Button>
      </div>

      <div className="mb-4">
        <TableToolbar search={search} onSearchChange={setSearch} placeholder="Search categories…">
          <Select value={filterProject || "all"} onValueChange={(v) => setFilterProject(v === "all" ? "" : v)}>
            <SelectTrigger className="w-[180px]"><SelectValue placeholder="All Projects" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Projects</SelectItem>
              {projects.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <FilterSelect value={status} onChange={(v) => setStatus(v as '' | 'ACTIVE' | 'INACTIVE')} allLabel="All statuses" options={STATUS_OPTIONS} />
        </TableToolbar>
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} sort={sort} onSortChange={onSortChange} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selectedItem ? 'Edit Category' : 'Create Category'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="name">Name <span className="text-destructive">*</span></Label>
              <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Enter name" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Enter description" />
            </div>
            <div className="space-y-2">
              <Label>Project <span className="text-destructive">*</span></Label>
              <Select value={formData.projectId} onValueChange={(v) => setFormData({ ...formData, projectId: v })} disabled={!!selectedItem}>
                <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                <SelectContent>
                  {projects.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Category" description={`Are you sure you want to delete "${selectedItem?.name}"? This action cannot be undone.`} confirmText="Delete" onConfirm={remove} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate Category' : 'Activate Category'} description={selectedItem?.status === 'ACTIVE' ? `Are you sure you want to deactivate "${selectedItem?.name}"?` : `Are you sure you want to activate "${selectedItem?.name}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={toggleStatus} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
    </div>
  );
}
