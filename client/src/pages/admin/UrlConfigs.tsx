import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff, Copy } from 'lucide-react';
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

type ProxyMode = 'DIRECT' | 'HEADLESS' | 'NEW_WINDOW';

interface UrlConfig {
  id: string;
  label: string;
  description: string | null;
  targetUrl: string;
  opaqueId: string;
  status: 'ACTIVE' | 'INACTIVE';
  proxyMode: ProxyMode;
  headlessTimeout: number;
  sessionTtl: number;
  userType: { id: string; name: string };
  projectType: { id: string; name: string };
  category: { id: string; name: string };
  subCategory: { id: string; name: string };
}

const PROXY_MODE_LABELS: Record<ProxyMode, { label: string; description: string; color: string }> = {
  DIRECT: { label: 'Direct', description: 'Standard HTTP proxy (default)', color: 'bg-gray-500' },
  HEADLESS: { label: 'Headless', description: 'For WAF-protected sites (Akamai, Cloudflare)', color: 'bg-blue-500' },
  NEW_WINDOW: { label: 'New Window', description: 'Opens in new tab (fallback)', color: 'bg-amber-500' },
};

interface SelectOption { id: string; name: string; }
interface Category { id: string; name: string; userTypeId: string; projectTypeId: string; }
interface SubCategory { id: string; name: string; categoryId: string; }

export default function UrlConfigs() {
  const { toast } = useToast();
  const [data, setData] = useState<UrlConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });

  const [userTypes, setUserTypes] = useState<SelectOption[]>([]);
  const [projectTypes, setProjectTypes] = useState<SelectOption[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [subCategories, setSubCategories] = useState<SubCategory[]>([]);

  const [filterUserType, setFilterUserType] = useState('');
  const [filterProjectType, setFilterProjectType] = useState('');

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<UrlConfig | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [formData, setFormData] = useState({
    label: '',
    description: '',
    targetUrl: '',
    userTypeId: '',
    projectTypeId: '',
    categoryId: '',
    subCategoryId: '',
    proxyMode: 'DIRECT' as ProxyMode,
    headlessTimeout: 60000,
    sessionTtl: 30000,
  });

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      let url = `/admin/url-configs?page=${page}&limit=${limit}`;
      if (filterUserType) url += `&userTypeId=${filterUserType}`;
      if (filterProjectType) url += `&projectTypeId=${filterProjectType}`;
      const response = await api.get<PaginatedResponse<UrlConfig>>(url);
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
      const [ut, pt, cat, subCat] = await Promise.all([
        api.get<PaginatedResponse<SelectOption>>('/admin/user-types?limit=100'),
        api.get<PaginatedResponse<SelectOption>>('/admin/project-types?limit=100'),
        api.get<PaginatedResponse<Category>>('/admin/categories?limit=100'),
        api.get<PaginatedResponse<SubCategory>>('/admin/sub-categories?limit=100'),
      ]);
      setUserTypes(ut.data || []);
      setProjectTypes(pt.data || []);
      setCategories(cat.data || []);
      setSubCategories(subCat.data || []);
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

  const filteredCategories = categories.filter(
    (c) => c.userTypeId === formData.userTypeId && c.projectTypeId === formData.projectTypeId
  );

  const filteredSubCategories = subCategories.filter((sc) => sc.categoryId === formData.categoryId);

  const handleCreate = () => {
    setSelectedItem(null);
    setFormData({ label: '', description: '', targetUrl: '', userTypeId: '', projectTypeId: '', categoryId: '', subCategoryId: '', proxyMode: 'DIRECT', headlessTimeout: 60000, sessionTtl: 30000 });
    setIsFormOpen(true);
  };

  const handleEdit = (item: UrlConfig) => {
    setSelectedItem(item);
    setFormData({
      label: item.label,
      description: item.description || '',
      targetUrl: item.targetUrl,
      userTypeId: item.userType.id,
      projectTypeId: item.projectType.id,
      categoryId: item.category.id,
      subCategoryId: item.subCategory.id,
      proxyMode: item.proxyMode || 'DIRECT',
      headlessTimeout: item.headlessTimeout || 60000,
      sessionTtl: item.sessionTtl || 30000,
    });
    setIsFormOpen(true);
  };

  const handleSubmit = async () => {
    if (!formData.label.trim() || !formData.targetUrl.trim() || !formData.userTypeId || !formData.projectTypeId || !formData.categoryId || !formData.subCategoryId) {
      toast({ title: 'Validation Error', description: 'All fields are required', variant: 'destructive' });
      return;
    }
    setIsSubmitting(true);
    try {
      if (selectedItem) {
        await api.put(`/admin/url-configs/${selectedItem.id}`, formData);
        toast({ title: 'Success', description: 'URL configuration updated successfully' });
      } else {
        await api.post('/admin/url-configs', formData);
        toast({ title: 'Success', description: 'URL configuration created successfully' });
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
      await api.delete(`/admin/url-configs/${selectedItem.id}`);
      toast({ title: 'Success', description: 'URL configuration deleted successfully' });
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
      await api.patch(`/admin/url-configs/${selectedItem.id}/status`, { status: newStatus });
      toast({ title: 'Success', description: `URL ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'} successfully` });
      setIsStatusOpen(false);
      fetchData(pagination.page, pagination.limit);
    } catch (error) {
      toast({ title: 'Error', description: error instanceof Error ? error.message : 'Status change failed', variant: 'destructive' });
    } finally {
      setIsSubmitting(false);
    }
  };

  const copyProxyUrl = (opaqueId: string) => {
    navigator.clipboard.writeText(`${window.location.origin}/proxy/${opaqueId}`);
    toast({ title: 'Copied', description: 'Proxy URL copied to clipboard' });
  };

  const columns: ColumnDef<UrlConfig>[] = [
    { accessorKey: 'label', header: 'Label' },
    {
      id: 'scope',
      header: 'Scope',
      cell: ({ row }) => (
        <span className="text-sm">{row.original.userType.name} / {row.original.projectType.name}</span>
      ),
    },
    {
      id: 'path',
      header: 'Path',
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">{row.original.category.name} &gt; {row.original.subCategory.name}</span>
      ),
    },
    {
      accessorKey: 'proxyMode',
      header: 'Mode',
      cell: ({ row }) => {
        const mode = row.original.proxyMode || 'DIRECT';
        const config = PROXY_MODE_LABELS[mode];
        return (
          <Badge className={`${config.color} text-white`}>{config.label}</Badge>
        );
      },
    },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>{row.original.status}</Badge>,
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0"><MoreHorizontal className="h-4 w-4" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => copyProxyUrl(row.original.opaqueId)}>
              <Copy className="mr-2 h-4 w-4" />Copy Proxy URL
            </DropdownMenuItem>
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
        <h1 className="text-2xl font-bold">URL Configurations</h1>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add URL Config</Button>
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
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>{selectedItem ? 'Edit URL Configuration' : 'Create URL Configuration'}</DialogTitle></DialogHeader>
          <div className="space-y-4 py-4 max-h-[60vh] overflow-y-auto">
            <div className="space-y-2">
              <Label htmlFor="label">Label <span className="text-destructive">*</span></Label>
              <Input id="label" value={formData.label} onChange={(e) => setFormData({ ...formData, label: e.target.value })} placeholder="Enter label" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Enter description" />
            </div>
            <div className="space-y-2">
              <Label htmlFor="targetUrl">Target URL <span className="text-destructive">*</span></Label>
              <Input id="targetUrl" value={formData.targetUrl} onChange={(e) => setFormData({ ...formData, targetUrl: e.target.value })} placeholder="https://example.com" />
            </div>
            <div className="space-y-2">
              <Label>Proxy Mode</Label>
              <Select value={formData.proxyMode} onValueChange={(v) => setFormData({ ...formData, proxyMode: v as ProxyMode })}>
                <SelectTrigger><SelectValue placeholder="Select proxy mode" /></SelectTrigger>
                <SelectContent>
                  {(Object.keys(PROXY_MODE_LABELS) as ProxyMode[]).map((mode) => (
                    <SelectItem key={mode} value={mode}>
                      <div className="flex items-center gap-2">
                        <div className={`w-2 h-2 rounded-full ${PROXY_MODE_LABELS[mode].color}`} />
                        <span>{PROXY_MODE_LABELS[mode].label}</span>
                        <span className="text-xs text-muted-foreground ml-1">- {PROXY_MODE_LABELS[mode].description}</span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Use <strong>Headless</strong> for sites with Akamai/Cloudflare bot protection. Use <strong>New Window</strong> as fallback.
              </p>
            </div>
            {formData.proxyMode === 'HEADLESS' && (
              <div className="grid grid-cols-2 gap-4 p-3 bg-muted rounded-md">
                <div className="space-y-2">
                  <Label htmlFor="headlessTimeout">Timeout (ms)</Label>
                  <Input
                    id="headlessTimeout"
                    type="number"
                    value={formData.headlessTimeout}
                    onChange={(e) => setFormData({ ...formData, headlessTimeout: parseInt(e.target.value) || 60000 })}
                    min={5000}
                    max={300000}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="sessionTtl">Idle Timeout (ms)</Label>
                  <Input
                    id="sessionTtl"
                    type="number"
                    value={formData.sessionTtl}
                    onChange={(e) => setFormData({ ...formData, sessionTtl: parseInt(e.target.value) || 30000 })}
                    min={5000}
                    max={300000}
                  />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>User Type <span className="text-destructive">*</span></Label>
                <Select value={formData.userTypeId} onValueChange={(v) => setFormData({ ...formData, userTypeId: v, categoryId: '', subCategoryId: '' })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{userTypes.map((ut) => <SelectItem key={ut.id} value={ut.id}>{ut.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Project Type <span className="text-destructive">*</span></Label>
                <Select value={formData.projectTypeId} onValueChange={(v) => setFormData({ ...formData, projectTypeId: v, categoryId: '', subCategoryId: '' })}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{projectTypes.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Category <span className="text-destructive">*</span></Label>
                <Select value={formData.categoryId} onValueChange={(v) => setFormData({ ...formData, categoryId: v, subCategoryId: '' })} disabled={!formData.userTypeId || !formData.projectTypeId}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{filteredCategories.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Sub-Category <span className="text-destructive">*</span></Label>
                <Select value={formData.subCategoryId} onValueChange={(v) => setFormData({ ...formData, subCategoryId: v })} disabled={!formData.categoryId}>
                  <SelectTrigger><SelectValue placeholder="Select" /></SelectTrigger>
                  <SelectContent>{filteredSubCategories.map((sc) => <SelectItem key={sc.id} value={sc.id}>{sc.name}</SelectItem>)}</SelectContent>
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

      <ConfirmDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen} title="Delete URL Configuration" description={`Delete "${selectedItem?.label}"?`} confirmText="Delete" onConfirm={handleDelete} variant="destructive" isLoading={isSubmitting} />
      <ConfirmDialog open={isStatusOpen} onOpenChange={setIsStatusOpen} title={selectedItem?.status === 'ACTIVE' ? 'Deactivate URL' : 'Activate URL'} description={`${selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} "${selectedItem?.label}"?`} confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'} onConfirm={handleStatusChange} variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'} isLoading={isSubmitting} />
    </div>
  );
}
