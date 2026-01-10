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

interface Category {
  id: string;
  name: string;
  description: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  userType: { id: string; name: string };
  projectType: { id: string; name: string };
  _count?: { subCategories: number; urlConfigurations: number };
}

interface SelectOption {
  id: string;
  name: string;
}

export default function Categories() {
  const { toast } = useToast();
  const [data, setData] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });

  const [userTypes, setUserTypes] = useState<SelectOption[]>([]);
  const [projectTypes, setProjectTypes] = useState<SelectOption[]>([]);
  const [filterUserType, setFilterUserType] = useState('');
  const [filterProjectType, setFilterProjectType] = useState('');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<Category | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    name: '',
    description: '',
    userTypeId: '',
    projectTypeId: '',
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      let url = `/admin/categories?page=${page}&limit=${limit}`;
      if (filterUserType) url += `&userTypeId=${filterUserType}`;
      if (filterProjectType) url += `&projectTypeId=${filterProjectType}`;
      const response = await api.get<PaginatedResponse<Category>>(url);
      setData(response.data);
      setPagination(response.pagination);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Failed to fetch data', variant: 'destructive' });
    } finally {
      setIsLoading(false);
    }
  };

  const fetchSelectOptions = async () => {
    try {
      const [ut, pt] = await Promise.all([
        api.get<PaginatedResponse<SelectOption>>('/admin/user-types?limit=100'),
        api.get<PaginatedResponse<SelectOption>>('/admin/project-types?limit=100'),
      ]);
      setUserTypes(ut.data || []);
      setProjectTypes(pt.data || []);
    } catch (error) {
      console.error('Failed to fetch options:', error);
    }
  };

  useEffect(() => {
    fetchSelectOptions();
  }, []);

  useEffect(() => {
    fetchData();
  }, [filterUserType, filterProjectType]);

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ name: '', description: '', userTypeId: '', projectTypeId: '' });
    setIsFormOpen(true);
  };

  const handleEdit = (item: Category) => {
    setSelectedItem(item);
    setFormData({
      name: item.name,
      description: item.description || '',
      userTypeId: item.userType.id,
      projectTypeId: item.projectType.id,
    });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.name.trim() || !formData.userTypeId || !formData.projectTypeId) {
      toast({ title: 'Validation Error', description: 'Name, User Type, and Project Type are required', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      if (selectedItem) {
        await api.put(`/admin/categories/${selectedItem.id}`, formData);
        toast({ title: 'Success', description: 'Category updated successfully' });
      } else {
        await api.post('/admin/categories', formData);
        toast({ title: 'Success', description: 'Category created successfully' });
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
      await api.delete(`/admin/categories/${selectedItem.id}`);
      toast({ title: 'Success', description: 'Category deleted successfully' });
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
      await api.patch(`/admin/categories/${selectedItem.id}/status`, { status: newStatus });
      toast({ title: 'Success', description: `Category ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` });
      setIsStatusOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Status change failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const columns: ColumnDef<Category>[] = [
    { accessorKey: 'name', header: 'Name' },
    { accessorKey: 'description', header: 'Description', cell: ({ row }) => row.original.description || '-' },
    { id: 'userType', header: 'User Type', cell: ({ row }) => row.original.userType.name },
    { id: 'projectType', header: 'Project Type', cell: ({ row }) => row.original.projectType.name },
    {
      accessorKey: 'status',
      header: 'Status',
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
        <h1 className="text-2xl font-bold">Categories</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add Category</Button>
      </div>

      <div className="flex gap-4 mb-4">
        <Select value={filterUserType || "all"} onValueChange={(v) => setFilterUserType(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="All User Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All User Types</SelectItem>
            {userTypes.map((ut) => <SelectItem key={ut.id} value={ut.id}>{ut.name}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={filterProjectType || "all"} onValueChange={(v) => setFilterProjectType(v === "all" ? "" : v)}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="All Project Types" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Project Types</SelectItem>
            {projectTypes.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} />

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
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>User Type <span className="text-destructive">*</span></Label>
                <Select value={formData.userTypeId} onValueChange={(v) => setFormData({ ...formData, userTypeId: v })} disabled={!!selectedItem}>
                  <SelectTrigger><SelectValue placeholder="Select user type" /></SelectTrigger>
                  <SelectContent>
                    {userTypes.map((ut) => <SelectItem key={ut.id} value={ut.id}>{ut.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Project Type <span className="text-destructive">*</span></Label>
                <Select value={formData.projectTypeId} onValueChange={(v) => setFormData({ ...formData, projectTypeId: v })} disabled={!!selectedItem}>
                  <SelectTrigger><SelectValue placeholder="Select project type" /></SelectTrigger>
                  <SelectContent>
                    {projectTypes.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete Category" description={`Are you sure you want to delete "${selectedItem?.name}"? This action cannot be undone.`} confirmText="Delete" onConfirm={handleDelete} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate Category' : 'Activate Category'} description={selectedItem?.status === 'ACTIVE' ? `Are you sure you want to deactivate "${selectedItem?.name}"?` : `Are you sure you want to activate "${selectedItem?.name}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={handleStatusChange} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
    </div>
  );
}
