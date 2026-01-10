import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
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

interface SubCategory {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  category: { id: string; name: string; userType: { name: string }; projectType: { name: string } };
  _count?: { urlConfigurations: number };
}

interface Category {
  id: string;
  name: string;
  userType: { name: string };
  projectType: { name: string };
}

export default function SubCategories() {
  const { toast } = useToast();
  const [data, setData] = useState<SubCategory[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });

  const [categories, setCategories] = useState<Category[]>([]);
  const [filterCategory, setFilterCategory] = useState('');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<SubCategory | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    categoryId: '',
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      let url = `/admin/sub-categories?page=${page}&limit=${limit}`;
      if (filterCategory) url += `&categoryId=${filterCategory}`;
      const response = await api.get<PaginatedResponse<SubCategory>>(url);
      setData(response.data);
      setPagination(response.pagination);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to fetch data', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchCategories = async () => {
    try {
      const response = await api.get<PaginatedResponse<Category>>('/admin/categories?limit=100');
      setCategories(response.data || []);
    } catch (error) {
      console.error('Failed to fetch categories:', error);
    }
  };

  useEffect(() => {
    fetchCategories();
  }, []);

  useEffect(() => {
    fetchData();
  }, [filterCategory]);

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ name: '', description: '', categoryId: '' });
    setIsFormOpen(true);
  };

  const handleEdit = (item: SubCategory) => {
    setSelectedItem(item);
    setFormData({ name: item.name, description: item.description || '', categoryId: item.category.id });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.categoryId) {
      toast({ title: 'Validation Error', description: 'Name and Category are required', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      if (selectedItem) {
        await api.put(`/admin/sub-categories/${selectedItem.id}`, formData);
        toast({ title: 'Success', description: 'Sub-category updated successfully' });
      } else {
        await api.post('/admin/sub-categories', formData);
        toast({ title: 'Success', description: 'Sub-category created successfully' });
      }
      setIsFormOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Operation failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedItem) return;
    setIsSubmitting(true);
    try {
      await api.delete(`/admin/sub-categories/${selectedItem.id}`);
      toast({ title: 'Success', description: 'Sub-category deleted successfully' });
      setIsDeleteOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Delete failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleStatusChange = async () => {
    if (!selectedItem) return;
    setIsSubmitting(true);
    try {
      const newStatus = selectedItem.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
      await api.patch(`/admin/sub-categories/${selectedItem.id}/status`, { status: newStatus });
      toast({ title: 'Success', description: `Sub-category ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` });
      setIsStatusOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Status change failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: ColumnDef<SubCategory>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description || '-' },
    { id: 'category', header: 'Category', cell: ({ row }) => row.original.category.name },
    {
      id: 'scope',
      header: 'Scope',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {row.original.category.userType.name} / {row.original.category.projectType.name}
        </span>
      ),
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge>,
    },
    {
      id: 'usage',
      header: 'URLs',
      cell: ({ row }) => row.original._count?.urlConfigurations ?? 0,
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
            <DropdownMenuItem onClick={() => { setSelectedItem(row.original); setIsStatusOpen(true); }}>
              {row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setSelectedItem(row.original); setIsDeleteOpen(true); }} className="text-destructive">
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
        <h1 className="text-2xl font-bold">Sub-Categories</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add Sub-Category</Button>
      </div>

      <div className="flex gap-4 mb-4">
        <Select value={filterCategory || "all"} onValueChange={(v) => setFilterCategory(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[300px]"><SelectValue placeholder="All Categories" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Categories</SelectItem>
            {categories.map((c) => (
              <SelectItem key={c.id} value={c.id}>{c.name} ({c.userType.name}/{c.projectType.name})</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>{selectedItem ? 'Edit Sub-Category' : 'Create Sub-Category'}</DialogTitle></DialogHeader>
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
              <Label>Category <span className="text-destructive">*</span></Label>
              <Select value={formData.categoryId} onValueChange={(v) => setFormData({ ...formData, categoryId: v })} disabled={!!selectedItem}>
                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.name} ({c.userType.name}/{c.projectType.name})</SelectItem>
                  ))}
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

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Sub-Category" description={`Are you sure you want to delete "${selectedItem?.name}"?`} confirmText="Delete" onConfirm={handleDelete} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate Sub-Category' : 'Activate Sub-Category'} description={selectedItem?.status === 'ACTIVE' ? `Deactivate "${selectedItem?.name}"?` : `Activate "${selectedItem?.name}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={handleStatusChange} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
    </div>
  );
}
