import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff, UserCheck, X } from 'lucide-react';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable, ServerSort, nextSort } from '@/components/shared/DataTable';
import { TableToolbar } from '@/components/shared/TableToolbar';
import { FilterSelect, STATUS_OPTIONS } from '@/components/shared/FilterSelect';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/ui/password-input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
} from '@/components/ui/sheet';
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

type Role = 'USER' | 'TEAM_LEAD' | 'ADMIN';

interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  forcePasswordChange: boolean;
  createdAt: string;
  assignments?: {
    project: { id: string; name: string };
  }[];
}

interface SelectOption {
  id: string;
  name: string;
}

// Full user detail returned by GET /admin/users/:id (unwrapped user object).
interface UserDetail {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  status: 'ACTIVE' | 'INACTIVE';
  assignments?: { project: { id: string; name: string } }[];
  subCategoryAccess?: {
    subCategory: {
      id: string;
      name: string;
      categoryId: string;
      category: { id: string; name: string };
    };
  }[];
}

// One category block in the assignment builder: a chosen category plus the
// sub-categories checked within it.
interface CategoryBlock {
  categoryId: string;
  subCategoryIds: string[];
}

export default function Users() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const { setUser } = useAuthStore();
  const [data, setData] = useState<User[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'INACTIVE'>('');
  const [roleFilter, setRoleFilter] = useState<'' | 'USER' | 'TEAM_LEAD'>('');
  const [sort, setSort] = useState<ServerSort>({ field: 'username', order: 'asc' });

  const [projects, setProjects] = useState<SelectOption[]>([]);
  // Categories available in the currently-selected project.
  const [categories, setCategories] = useState<SelectOption[]>([]);
  // Sub-categories cached per category id (loaded lazily when a category is chosen).
  const [subCategoriesMap, setSubCategoriesMap] = useState<Record<string, SelectOption[]>>({});
  // The assignment builder: one block per chosen category.
  const [categoryBlocks, setCategoryBlocks] = useState<CategoryBlock[]>([]);
  const [assignmentError, setAssignmentError] = useState('');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [isImpersonateOpen, setIsImpersonateOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<User | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState<{
    username: string;
    fullName: string;
    password: string;
    role: Role;
    projectId: string;
  }>({
    username: '',
    fullName: '',
    password: '',
    role: 'USER',
    projectId: '',
  });

  const fetchData = async (page = pagination.page, limit = pagination.limit) => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
        sortBy: sort.field,
        sortOrder: sort.order,
      });
      if (search.trim()) params.set('search', search.trim());
      if (status) params.set('status', status);
      if (roleFilter) params.set('role', roleFilter);
      const response = await api.get<PaginatedResponse<User>>(`/admin/users?${params}`);
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
      const pt = await api.get<PaginatedResponse<SelectOption>>('/admin/projects?status=ACTIVE&limit=100');
      setProjects(pt.data || []);
    } catch (error) {
      console.error('Failed to fetch options:', error);
    }
  };

  // Load the categories that belong to a project (returns them so callers can await).
  const fetchCategories = async (projectId: string): Promise<SelectOption[]> => {
    if (!projectId) {
      setCategories([]);
      return [];
    }
    try {
      const res = await api.get<PaginatedResponse<SelectOption>>(
        `/admin/categories?projectId=${projectId}&status=ACTIVE&limit=100`
      );
      const list = res.data || [];
      setCategories(list);
      return list;
    } catch (error) {
      console.error('Failed to fetch categories:', error);
      setCategories([]);
      return [];
    }
  };

  // Load (and cache) the sub-categories for a category.
  const fetchSubCategories = async (categoryId: string): Promise<void> => {
    if (!categoryId) return;
    try {
      const res = await api.get<PaginatedResponse<SelectOption>>(
        `/admin/sub-categories?categoryId=${categoryId}&status=ACTIVE&limit=100`
      );
      setSubCategoriesMap((prev) => ({ ...prev, [categoryId]: res.data || [] }));
    } catch (error) {
      console.error('Failed to fetch sub-categories:', error);
    }
  };

  // ---- Assignment builder handlers ----

  const handleProjectChange = (projectId: string) => {
    // Switching project invalidates every category block (they belong to the old project).
    setFormData((prev) => ({ ...prev, projectId }));
    setCategoryBlocks([]);
    setAssignmentError('');
    fetchCategories(projectId);
  };

  const addCategoryBlock = () => {
    setCategoryBlocks((prev) => [...prev, { categoryId: '', subCategoryIds: [] }]);
  };

  const removeCategoryBlock = (index: number) => {
    setCategoryBlocks((prev) => prev.filter((_, i) => i !== index));
    setAssignmentError('');
  };

  const handleBlockCategoryChange = (index: number, categoryId: string) => {
    setCategoryBlocks((prev) =>
      prev.map((b, i) => (i === index ? { categoryId, subCategoryIds: [] } : b))
    );
    setAssignmentError('');
    fetchSubCategories(categoryId);
  };

  const toggleSubCategory = (index: number, subCategoryId: string) => {
    setCategoryBlocks((prev) =>
      prev.map((b, i) => {
        if (i !== index) return b;
        const has = b.subCategoryIds.includes(subCategoryId);
        return {
          ...b,
          subCategoryIds: has
            ? b.subCategoryIds.filter((id) => id !== subCategoryId)
            : [...b.subCategoryIds, subCategoryId],
        };
      })
    );
    setAssignmentError('');
  };

  // Check/uncheck every sub-category in a block at once ("Select all").
  const setAllSubCategories = (index: number, subIds: string[], checked: boolean) => {
    setCategoryBlocks((prev) =>
      prev.map((b, i) => (i === index ? { ...b, subCategoryIds: checked ? [...subIds] : [] } : b))
    );
    setAssignmentError('');
  };

  // Flat, de-duplicated union of every checked sub-category across all blocks.
  const collectSubCategoryIds = (): string[] =>
    Array.from(new Set(categoryBlocks.flatMap((b) => b.subCategoryIds)));

  useEffect(() => {
    fetchSelectOptions();
  }, []);
  // Refetch (from page 1) whenever search, filters, or sort change — including on mount.
  useEffect(() => {
    fetchData(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, roleFilter, sort]);

  const resetBuilder = () => {
    setCategories([]);
    setSubCategoriesMap({});
    setCategoryBlocks([]);
    setAssignmentError('');
  };

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ username: '', fullName: '', password: '', role: 'USER', projectId: '' });
    resetBuilder();
    setIsFormOpen(true);
  };

  const handleEdit = async (item: User) => {
    setSelectedItem(item);
    resetBuilder();
    setFormData({
      username: item.username,
      fullName: item.fullName,
      password: '',
      role: item.role,
      projectId: '',
    });
    setIsFormOpen(true);

    // Admins have no assignment — nothing to prefill.
    if (item.role === 'ADMIN') return;

    try {
      const detail = await api.get<UserDetail>(`/admin/users/${item.id}`);
      const projectId = detail.assignments?.[0]?.project.id || '';
      setFormData((prev) => ({ ...prev, projectId }));
      if (projectId) await fetchCategories(projectId);

      // Group granted sub-categories by their category → one block per category.
      const grouped = new Map<string, string[]>();
      (detail.subCategoryAccess || []).forEach((access) => {
        const catId = access.subCategory.category.id;
        const list = grouped.get(catId) || [];
        list.push(access.subCategory.id);
        grouped.set(catId, list);
      });
      const blocks: CategoryBlock[] = Array.from(grouped.entries()).map(
        ([categoryId, subCategoryIds]) => ({ categoryId, subCategoryIds })
      );
      setCategoryBlocks(blocks);
      await Promise.all(blocks.map((b) => fetchSubCategories(b.categoryId)));
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to load user assignment',
        variant: 'destructive',
      });
    }
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

    // Non-admin users must be assigned to a project and at least one sub-category.
    const subCategoryIds = collectSubCategoryIds();
    if (formData.role !== 'ADMIN') {
      if (!formData.projectId) {
        setAssignmentError('Select a project for this user.');
        return;
      }
      if (subCategoryIds.length === 0) {
        setAssignmentError('Add a category and check at least one sub-category to grant access.');
        return;
      }
    }
    setAssignmentError('');

    setIsSubmitting(true);
    try {
      const payload: Record<string, unknown> = {
        username: formData.username,
        fullName: formData.fullName,
        role: formData.role,
      };
      if (formData.password) payload.password = formData.password;
      if (formData.role !== 'ADMIN') {
        payload.projectId = formData.projectId;
        payload.subCategoryIds = subCategoryIds;
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
          role: Role;
          forcePasswordChange: boolean;
          projectId?: string;
          impersonatedBy: string;
        };
      }
      const response = await api.post<ImpersonateResponse>(`/admin/users/${selectedItem.id}/impersonate`, {});
      setUser({
        id: response.user.userId,
        username: response.user.username,
        fullName: response.user.fullName,
        role: response.user.role,
        forcePasswordChange: response.user.forcePasswordChange,
        projectId: response.user.projectId,
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
    { accessorKey: 'username', header: 'Username', meta: { sortField: 'username' } },
    { accessorKey: 'fullName', header: 'Full Name', meta: { sortField: 'fullName' } },
    {
      id: 'role',
      header: 'Role',
      cell: ({ row }) => {
        const r = row.original.role;
        const variant = r === 'ADMIN' ? 'default' : r === 'TEAM_LEAD' ? 'secondary' : 'outline';
        const label = r === 'ADMIN' ? 'Admin' : r === 'TEAM_LEAD' ? 'Team Lead' : 'User';
        return <Badge variant={variant}>{label}</Badge>;
      },
    },
    {
      id: 'assignment',
      header: 'Assignment',
      cell: ({ row }) => {
        if (row.original.role === 'ADMIN') return '-';
        const a = row.original.assignments?.[0];
        if (!a) return <span className="text-muted-foreground">Not assigned</span>;
        return <span className="text-sm">{a.project.name}</span>;
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      meta: { sortField: 'status' },
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
            {row.original.role !== 'ADMIN' && row.original.status === 'ACTIVE' && (
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
      <div className="mb-4">
        <TableToolbar search={search} onSearchChange={setSearch} placeholder="Search username or name…">
          <FilterSelect
            value={roleFilter}
            onChange={(v) => setRoleFilter(v as '' | 'USER' | 'TEAM_LEAD')}
            allLabel="All roles"
            options={[{ value: 'TEAM_LEAD', label: 'Team Lead' }, { value: 'USER', label: 'User' }]}
          />
          <FilterSelect value={status} onChange={(v) => setStatus(v as '' | 'ACTIVE' | 'INACTIVE')} allLabel="All statuses" options={STATUS_OPTIONS} />
        </TableToolbar>
      </div>
      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} sort={sort} onSortChange={(f) => setSort((p) => nextSort(p, f))} />

      <Sheet open={isFormOpen} onOpenChange={setIsFormOpen}>
        <SheetContent>
          <SheetHeader><SheetTitle>{selectedItem ? 'Edit User' : 'Create User'}</SheetTitle></SheetHeader>
          <div className="flex-1 overflow-y-auto space-y-4 py-2 pr-1">
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
              <PasswordInput id="password" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} placeholder="Enter password" />
            </div>
            <div className="space-y-2">
              <Label>Role</Label>
              <Select value={formData.role} onValueChange={(v) => setFormData({ ...formData, role: v as Role })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="USER">User</SelectItem>
                  <SelectItem value="TEAM_LEAD">Team Lead</SelectItem>
                  <SelectItem value="ADMIN">Admin</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {formData.role !== 'ADMIN' && (
              <div className="space-y-4 rounded-md border p-4">
                <div className="space-y-2">
                  <Label>Project <span className="text-destructive">*</span></Label>
                  <Select value={formData.projectId} onValueChange={handleProjectChange}>
                    <SelectTrigger><SelectValue placeholder="Select project" /></SelectTrigger>
                    <SelectContent>
                      {projects.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </div>

                {formData.projectId && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <Label>Category access <span className="text-destructive">*</span></Label>
                      <Button type="button" variant="outline" size="sm" onClick={addCategoryBlock}>
                        <Plus className="mr-1 h-3.5 w-3.5" />Add Category
                      </Button>
                    </div>

                    {categoryBlocks.length === 0 && (
                      <p className="text-sm text-muted-foreground">
                        No categories added yet. Click &ldquo;Add Category&rdquo; to grant access.
                      </p>
                    )}

                    {categoryBlocks.map((block, index) => {
                      const chosenElsewhere = categoryBlocks
                        .filter((_, i) => i !== index)
                        .map((b) => b.categoryId);
                      const subs = subCategoriesMap[block.categoryId] || [];
                      return (
                        <div key={index} className="space-y-3 rounded-md border p-3">
                          <div className="flex items-center gap-2">
                            <div className="flex-1">
                              <Select
                                value={block.categoryId}
                                onValueChange={(v) => handleBlockCategoryChange(index, v)}
                              >
                                <SelectTrigger><SelectValue placeholder="Select category" /></SelectTrigger>
                                <SelectContent>
                                  {categories.map((c) => (
                                    <SelectItem
                                      key={c.id}
                                      value={c.id}
                                      disabled={chosenElsewhere.includes(c.id)}
                                    >
                                      {c.name}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                            </div>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-9 w-9 p-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeCategoryBlock(index)}
                              aria-label="Remove category"
                            >
                              <X className="h-4 w-4" />
                            </Button>
                          </div>

                          {block.categoryId && (
                            subs.length === 0 ? (
                              <p className="text-sm text-muted-foreground">
                                No active sub-categories in this category.
                              </p>
                            ) : (
                              <div className="space-y-2">
                                <label className="flex items-center gap-2 text-sm font-medium cursor-pointer border-b pb-2">
                                  <input
                                    type="checkbox"
                                    className="h-4 w-4 rounded border-input"
                                    checked={subs.every((s) => block.subCategoryIds.includes(s.id))}
                                    onChange={(e) =>
                                      setAllSubCategories(index, subs.map((s) => s.id), e.target.checked)
                                    }
                                  />
                                  <span>Select all</span>
                                </label>
                                <div className="grid grid-cols-2 gap-2">
                                  {subs.map((sub) => (
                                    <label
                                      key={sub.id}
                                      className="flex items-center gap-2 text-sm cursor-pointer"
                                    >
                                      <input
                                        type="checkbox"
                                        className="h-4 w-4 rounded border-input"
                                        checked={block.subCategoryIds.includes(sub.id)}
                                        onChange={() => toggleSubCategory(index, sub.id)}
                                      />
                                      <span>{sub.name}</span>
                                    </label>
                                  ))}
                                </div>
                              </div>
                            )
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {assignmentError && (
                  <p className="text-sm text-destructive">{assignmentError}</p>
                )}
              </div>
            )}
          </div>
          <SheetFooter className="border-t pt-4">
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete User" description={`Are you sure you want to delete "${selectedItem?.fullName}"? This action cannot be undone.`} confirmText="Delete" onConfirm={handleDelete} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate User' : 'Activate User'} description={selectedItem?.status === 'ACTIVE' ? `Are you sure you want to deactivate "${selectedItem?.fullName}"?` : `Are you sure you want to activate "${selectedItem?.fullName}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={handleStatusChange} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
      <ConfirmDialog open={isImpersonateOpen} onOpenChange={setIsImpersonateOpen} title="Impersonate User" description={`You will be logged in as "${selectedItem?.fullName}". All actions will be logged as impersonation.`} confirmText="Start Impersonation" onConfirm={handleImpersonate} isLoading={isSubmitting} />
    </div>
  );
}
