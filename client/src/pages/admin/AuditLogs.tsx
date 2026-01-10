import { useState, useEffect } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
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
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';

interface AuditLog {
  id: string;
  user: { id: string; username: string; fullName: string };
  userType: { id: string; name: string };
  projectType: { id: string; name: string };
  urlConfig: { id: string; label: string };
  targetUrl: string;
  requestMethod: string;
  responseStatus: number;
  durationMs: number;
  ipAddress: string | null;
  userAgent: string | null;
  accessedAt: string;
}

interface SelectOption { id: string; name: string; }

export default function AuditLogs() {
  const { toast } = useToast();
  const [data, setData] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState({ page: 1, limit: 25, total: 0, totalPages: 0 });

  const [userTypes, setUserTypes] = useState<SelectOption[]>([]);
  const [projectTypes, setProjectTypes] = useState<SelectOption[]>([]);

  const [filters, setFilters] = useState({
    userTypeId: '',
    projectTypeId: '',
    startDate: '',
    endDate: '',
    responseStatus: '',
  });

  const fetchData = async (page = 1, limit = 25) => {
    setIsLoading(true);
    try {
      let url = `/admin/audit-logs?page=${page}&limit=${limit}`;
      if (filters.userTypeId) url += `&userTypeId=${filters.userTypeId}`;
      if (filters.projectTypeId) url += `&projectTypeId=${filters.projectTypeId}`;
      if (filters.startDate) url += `&startDate=${filters.startDate}`;
      if (filters.endDate) url += `&endDate=${filters.endDate}`;
      if (filters.responseStatus) url += `&responseStatus=${filters.responseStatus}`;

      const response = await api.get<PaginatedResponse<AuditLog>>(url);
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
    fetchData();
  }, []);

  const handleFilter = () => {
    fetchData(1, pagination.limit);
  };

  const handleClearFilters = () => {
    setFilters({ userTypeId: '', projectTypeId: '', startDate: '', endDate: '', responseStatus: '' });
    fetchData(1, pagination.limit);
  };

  const getStatusVariant = (status: number) => {
    if (status >= 200 && status < 300) return 'success';
    if (status >= 400 && status < 500) return 'warning';
    if (status >= 500) return 'destructive';
    return 'secondary';
  };

  const formatDate = (dateStr: string) => new Date(dateStr).toLocaleString();

  const columns: ColumnDef<AuditLog>[] = [
    {
      accessorKey: 'accessedAt',
      header: 'Timestamp',
      cell: ({ row }) => formatDate(row.original.accessedAt),
    },
    {
      id: 'user',
      header: 'User',
      cell: ({ row }) => (
        <div>
          <div className="font-medium">{row.original.user.fullName}</div>
          <div className="text-sm text-muted-foreground">{row.original.user.username}</div>
        </div>
      ),
    },
    {
      id: 'scope',
      header: 'Scope',
      cell: ({ row }) => (
        <span className="text-sm">{row.original.userType.name} / {row.original.projectType.name}</span>
      ),
    },
    {
      id: 'url',
      header: 'URL',
      cell: ({ row }) => row.original.urlConfig.label,
    },
    {
      accessorKey: 'requestMethod',
      header: 'Method',
      cell: ({ row }) => <Badge variant="outline">{row.original.requestMethod}</Badge>,
    },
    {
      accessorKey: 'responseStatus',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={getStatusVariant(row.original.responseStatus)}>
          {row.original.responseStatus}
        </Badge>
      ),
    },
    {
      accessorKey: 'durationMs',
      header: 'Duration',
      cell: ({ row }) => `${row.original.durationMs}ms`,
    },
    {
      accessorKey: 'ipAddress',
      header: 'IP',
      cell: ({ row }) => row.original.ipAddress || '-',
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Audit Logs</h1>
      </div>

      <div className="bg-white p-4 rounded-lg border mb-4">
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="space-y-2">
            <Label>User Type</Label>
            <Select value={filters.userTypeId || "all"} onValueChange={(v) => setFilters({ ...filters, userTypeId: v === "all" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {userTypes.map((ut) => <SelectItem key={ut.id} value={ut.id}>{ut.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Project Type</Label>
            <Select value={filters.projectTypeId || "all"} onValueChange={(v) => setFilters({ ...filters, projectTypeId: v === "all" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                {projectTypes.map((pt) => <SelectItem key={pt.id} value={pt.id}>{pt.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Start Date</Label>
            <Input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>End Date</Label>
            <Input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
          </div>
          <div className="space-y-2">
            <Label>Status</Label>
            <Select value={filters.responseStatus || "all"} onValueChange={(v) => setFilters({ ...filters, responseStatus: v === "all" ? "" : v })}>
              <SelectTrigger><SelectValue placeholder="All" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="200">200 OK</SelectItem>
                <SelectItem value="403">403 Forbidden</SelectItem>
                <SelectItem value="503">503 Error</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="flex gap-2 mt-4">
          <Button onClick={handleFilter}>Apply Filters</Button>
          <Button variant="outline" onClick={handleClearFilters}>Clear</Button>
        </div>
      </div>

      <DataTable columns={columns} data={data} pagination={pagination} onPageChange={(page) => fetchData(page, pagination.limit)} onPageSizeChange={(limit) => fetchData(1, limit)} isLoading={isLoading} />
    </div>
  );
}
