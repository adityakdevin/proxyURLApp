import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { api, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/components/ui/use-toast';

interface ClaimRow {
  id: string;
  claimId: string;
  workflowStatus: { id: string; name: string; isTerminal: boolean };
  subCategory: { id: string; name: string };
  assignedTo: { id: string; fullName: string } | null;
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
  createdAt: string;
}

export default function AdminClaims() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<ClaimRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');

  const fetchData = async (page = 1, limit = 10) => {
    setIsLoading(true);
    try {
      const url = search
        ? `/admin/claims?page=${page}&limit=${limit}&search=${encodeURIComponent(search)}`
        : `/admin/claims?page=${page}&limit=${limit}`;
      const r = await api.get<PaginatedResponse<ClaimRow>>(url);
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
  }, []);

  const columns: ColumnDef<ClaimRow>[] = [
    {
      accessorKey: 'claimId',
      header: 'Claim ID',
      cell: ({ row }) => (
        <button
          className="text-primary underline-offset-2 hover:underline"
          onClick={() => navigate(`/admin/claims/${row.original.id}`)}
        >
          {row.original.claimId}
        </button>
      ),
    },
    {
      id: 'sub',
      header: 'Sub-Category',
      cell: ({ row }) => row.original.subCategory.name,
    },
    {
      id: 'status',
      header: 'Workflow',
      cell: ({ row }) => (
        <Badge variant={row.original.workflowStatus.isTerminal ? 'secondary' : 'default'}>
          {row.original.workflowStatus.name}
        </Badge>
      ),
    },
    {
      id: 'assignee',
      header: 'Assigned To',
      cell: ({ row }) =>
        row.original.assignedTo?.fullName ?? (
          <span className="text-muted-foreground">Unassigned</span>
        ),
    },
    {
      id: 'spell',
      header: 'Spell',
      cell: ({ row }) => <Badge variant="outline">{row.original.spellCheckStatus}</Badge>,
    },
    {
      id: 'qr',
      header: 'QR',
      cell: ({ row }) => <Badge variant="outline">{row.original.qrStatus}</Badge>,
    },
    {
      id: 'meta',
      header: 'Meta',
      cell: ({ row }) => <Badge variant="outline">{row.original.metaExtractionStatus}</Badge>,
    },
    {
      id: 'intra',
      header: 'Intra-Claim',
      cell: ({ row }) => <Badge variant="outline">{row.original.intraClaimStatus}</Badge>,
    },
    {
      id: 'full',
      header: 'Full Scan',
      cell: ({ row }) => <Badge variant="outline">{row.original.fullScanStatus}</Badge>,
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claims (All)</h1>
        <div className="flex gap-2">
          <Input
            placeholder="Search claim id..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && fetchData(1, pagination.limit)}
            className="w-64"
          />
          <Button onClick={() => fetchData(1, pagination.limit)}>Search</Button>
        </div>
      </div>
      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(p) => fetchData(p, pagination.limit)}
        onPageSizeChange={(l) => fetchData(1, l)}
        isLoading={isLoading}
      />
    </div>
  );
}
