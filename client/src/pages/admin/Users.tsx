import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff, UserCheck } from 'lucide-react';
import { api, PaginatedResponse, DataResponse } from '@/lib/api';
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
import { useAuthStore } from '@/stores/authStore';
import { useNavigate } from 'react-router-dom';

interface User {
  id: string;
  username: string;
  fullName: string;
  isAdmin: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  forcePasswordChange: boolean;
  createdAt: string;
  assignment?: {
    userType: { id: string; name: string };
    projectType: { id: string; name: string };
  };
}

interface SelectOption {
  id: string;
  name: string;
}

export default function Users() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { setUser } = useAuthStore();
  const [data, setData] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });

  const [userTypes, setUserTypes] = useState<SelectOption[]>([]);
  const [projectTypes, setProjectTypes] = useState<SelectOption[]>([]);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isImpersonateOpen, setIsImpersonateOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<User | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    username: '',
    fullName: '',
    password: '',
    isAdmin: false,
    userTypeId: '',
    projectTypeId: '',
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const response = await api.get<PaginatedResponse<User>>(`/admin/users?page=${page}&limit=${limit}`);
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
        api.get<DataResponse<SelectOption[]>>('/admin/user-types?limit=100'),
        api.get<DataResponse<SelectOption[]>>('/admin/project-types?limit=100'),
      ]);
      setUserTypes((ut as PaginatedResponse<SelectOption>).data || []);
      setProjectTypes((pt as PaginatedResponse<SelectOption>).data || []);
    } catch (error) {
      console.error('Failed to fetch options:', error);
    }
  };

  useEffect(() => {
    fetchData();
    fetchSelectOptions();
  }, []);

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ username: '', fullName: '', password: '', isAdmin: false, userTypeId: '', projectTypeId: '' });
    setIsFormOpen(true);
  };

  const handleEdit = (item: User) => {
    setSelectedItem(item);
    setFormData({
      username: item.username,
      fullName: item.fullName,
      password: '',
      isAdmin: item.isAdmin,
      userTypeId: item.assignment?.userType.id || '',
      projectTypeId: item.assignment?.projectType.id || '',
    });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.username.trim() || !formData.fullName.trim()) {
      toast({ title: 'Validation Error', description: 'Username and Full Name are required', variant: 'destructive' });
      return;
    }
    if (!selectedItem && !formData.password) {
      toast({ title: 'Validation Error', description: 'Password is required for new users', variant: 'destructive' });
      return;
    }

    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        username: formData.username,
        fullName: formData.fullName,
        isAdmin: formData.isAdmin,
      };
      if (formData.password) payload.password = formData.password;
      if (!formData.isAdmin && formData.userTypeId && formData.projectTypeId) {
        payload.userTypeId = formData.userTypeId;
        payload.projectTypeId = formData.projectTypeId;
      }

      if (selectedItem) {
        await api.put(`/admin/users/${selectedItem.id}`, payload);
        toast({ title: 'Success', description: 'User updated successfully' });
      } else {
        await api.post('/admin/users', payload);
        toast({ title: 'Success', description: 'User created successfully' });
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
      await api.delete(`/admin/users/${selectedItem.id}`);
      toast({ title: 'Success', description: 'User deleted successfully' });
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
      await api.patch(`/admin/users/${selectedItem.id}/status`, { status: newStatus });
      toast({ title: 'Success', description: `User ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` });
      setIsStatusOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Status change failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleImpersonate = async () => {
    if (!selectedItem) return;
    setIsSubmitting(true);
    try {
      interface ImpersonateResponse {
        message: string;
        user: {
          userId: string;
          username: string;
          fullName: string;
          isAdmin: boolean;
          forcePasswordChange: boolean;
          userTypeId?: string;
          projectTypeId?: string;
          impersonatedBy: string;
        };
      }
      const response = await api.post<ImpersonateResponse>(`/admin/users/${selectedItem.id}/impersonate`, {});
      setUser({
        id: response.user.userId,
        username: response.user.username,
        fullName: response.user.fullName,
        isAdmin: response.user.isAdmin,
        forcePasswordChange: response.user.forcePasswordChange,
        userTypeId: response.user.userTypeId,
        projectTypeId: response.user.projectTypeId,
        impersonatedBy: response.user.impersonatedBy,
      });
      toast({ title: 'Impersonation Started', description: `You are now impersonating ${selectedItem.fullName}` });
      navigate('/dashboard');
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Impersonation failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
      setIsImpersonateOpen(false);
    }
  };

  const columns: ColumnDef<User>[] = [
    { accessorKey: 'username', header: 'Username' },
    { accessorKey: 'fullName', header: 'Full Name' },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => (
        <Badge variant={row.original.isAdmin ? 'default' : 'secondary'}>
          {row.original.isAdmin ? 'Admin' : 'User'}
        </Badge>
      ),
    },
    {
      id: 'assignment',
      header: 'Assignment',
      cell: ({ row }) => {
        if (row.original.isAdmin) return '-';
        const a = row.original.assignment;
        if (!a) return <span className="text-muted-foreground">Not assigned</span>;
        return <span className="text-sm">{a.userType.name} / {a.projectType.name}</span>;
      },
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
            <Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleEdit(row.original)}><Pencil className="mr-2 h-4 w-4" />Edit</DropdownMenuItem>
            <DropdownMenuItem onClick={() => { setSelectedItem(row.original); setIsStatusOpen(true); }}>
              {row.original.status === 'ACTIVE' ? <><PowerOff className="mr-2 h-4 w-4" />Deactivate</> : <><Power className="mr-2 h-4 w-4" />Activate</>}
            </DropdownMenuItem>
            {!row.original.isAdmin && row.original.status === 'ACTIVE' && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { setSelectedItem(row.original); setIsImpersonateOpen(true); }}>
                  <UserCheck className="mr-2 h-4 w-4" />Impersonate
                </DropdownMenuItem>
              </>
            )}
            <DropdownMenuSeparator />
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
        <h1 className="text-2xl font-bold">Users</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add User</Button>
      </div>
      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{selectedItem ? 'Edit User' : 'Create User'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="username">Username <span className="text-destructive">*</span></Label>
                <Input id="username" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })} placeholder="Enter username" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fullName">Full Name <span className="text-destructive">*</span></Label>
                <Input id="fullName" value={formData.fullName} onChange={(e) => setFormData({ ...formData, fullName: e.target.value })} placeholder="Enter full name" />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">{selectedItem ? 'New Password (leave blank to keep)' : 'Password'} {!selectedItem && <span className="text-destructive">*</span>}</Label>
              <Input id="password" type="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} placeholder="Enter password" />
            </div>
            <div className="flex items-center space-x-2">
              <input type="checkbox" id="isAdmin" checked={formData.isAdmin} onChange={(e) => setFormData({ ...formData, isAdmin: e.target.checked })} className="rounded border-gray-300" />
              <Label htmlFor="isAdmin">Admin User</Label>
            </div>
            {!formData.isAdmin && (
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>User Type</Label>
                  <Select value={formData.userTypeId} onValueChange={(v) => setFormData({ ...formData, userTypeId: v })}>
                    <SelectTrigger><SelectValue placeholder="Select user type" /></SelectTrigger>
                    <SelectContent>
                      {userTypes.map((ut) => <SelectItem key={ut.id} value={ut.id}>{ut.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Project Type</Label>
                  <Select value={formData.projectTypeId} onValueChange={(v) => setFormData({ ...formData, projectTypeId: v })}>
                    <SelectTrigger><SelectValue placeholder="Select project type" /></SelectTrigger>
                    <SelectContent>
                      {projectTypes.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete User" description={`Are you sure you want to delete "${selectedItem?.fullName}"? This action cannot be undone.`} confirmText="Delete" onConfirm={handleDelete} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate User' : 'Activate User'} description={selectedItem?.status === 'ACTIVE' ? `Are you sure you want to deactivate "${selectedItem?.fullName}"?` : `Are you sure you want to activate "${selectedItem?.fullName}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={handleStatusChange} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
      <ConfirmDialog open={isImpersonateOpen} onOpenChange={setIsImpersonateOpen} title="Impersonate User" description={`You will be logged in as "${selectedItem?.fullName}". All actions will be logged as impersonation.`} confirmText="Start Impersonation" onConfirm={handleImpersonate} isLoading={isSubmitting} />
    </div>
  );
}
