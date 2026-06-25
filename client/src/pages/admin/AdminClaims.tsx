import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Upload, Download } from 'lucide-react';
import { api, DataResponse, PaginatedResponse } from '@/lib/api';
import { DataTable } from '@/components/shared/DataTable';
import { Badge } from '@/components/ui/badge';
import { ValidationBadge } from '@/components/ValidationBadge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  SubCategoryPicker,
  SubCategoryPickerValue,
} from '@/components/shared/SubCategoryPicker';
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

interface ImportReport {
  subCategoryId: string;
  parsed: number;
  created: number;
  updated: number;
  failed: number;
  errors: { rowNumber: number; message: string }[];
}

export default function AdminClaims() {
  const { toast } = useToast();
  const navigate = useNavigate();
  const [data, setData] = useState<ClaimRow[]>([]);
  const [pagination, setPagination] = useState({ page: 1, limit: 10, total: 0, totalPages: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');

  // Forged-document observation import/export dialog.
  const [obsOpen, setObsOpen] = useState(false);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isUploading, setIsUploading] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

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

  // Clear the picker / file / report when the dialog closes so a stale selection
  // can't carry into the next open (and a wrong-sub-category upload).
  const handleObsOpenChange = (open: boolean) => {
    if (!open) {
      setPicker({});
      setReport(null);
      if (fileRef.current) fileRef.current.value = '';
    }
    setObsOpen(open);
  };

  const handleImport = async () => {
    const file = fileRef.current?.files?.[0];
    if (!picker.subCategoryId) {
      return toast({ title: 'Pick a Sub-Category', variant: 'destructive' });
    }
    if (!file) {
      return toast({ title: 'Choose an .xlsx file', variant: 'destructive' });
    }
    setIsUploading(true);
    setReport(null);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('subCategoryId', picker.subCategoryId);
      const r = await api.postForm<DataResponse<ImportReport>>(
        '/admin/claims/import-observations',
        form
      );
      setReport(r.data);
      toast({
        title: 'Import complete',
        description: `${r.data.created} created, ${r.data.updated} updated, ${r.data.failed} failed`,
      });
      if (fileRef.current) fileRef.current.value = '';
      fetchData(1, pagination.limit);
    } catch (e) {
      toast({
        title: 'Import failed',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setIsUploading(false);
    }
  };

  const handleObsExport = () => {
    if (!picker.subCategoryId) {
      return toast({ title: 'Pick a Sub-Category', variant: 'destructive' });
    }
    const params = new URLSearchParams({ subCategoryId: picker.subCategoryId });
    window.open(`/api/admin/claims/export-observations?${params.toString()}`, '_blank');
  };

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
      cell: ({ row }) => <ValidationBadge status={row.original.spellCheckStatus} />,
    },
    {
      id: 'qr',
      header: 'QR',
      cell: ({ row }) => <ValidationBadge status={row.original.qrStatus} />,
    },
    {
      id: 'meta',
      header: 'Meta',
      cell: ({ row }) => <ValidationBadge status={row.original.metaExtractionStatus} />,
    },
    {
      id: 'intra',
      header: 'Intra-Claim',
      cell: ({ row }) => <ValidationBadge status={row.original.intraClaimStatus} />,
    },
    {
      id: 'full',
      header: 'Full Scan',
      cell: ({ row }) => <ValidationBadge status={row.original.fullScanStatus} />,
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
          <Button variant="outline" onClick={() => setObsOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Observations
          </Button>
          <Button variant="outline" onClick={() => setObsOpen(true)}>
            <Download className="mr-2 h-4 w-4" />
            Export Observations
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              const params = new URLSearchParams();
              if (search) params.set('search', search);
              window.open(`/api/claims/export?${params.toString()}`, '_blank');
            }}
          >
            Export
          </Button>
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

      <Dialog open={obsOpen} onOpenChange={handleObsOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Forged-Document Observations</DialogTitle>
            <DialogDescription>
              Upload the observations sheet into a Sub-Category, or export it with the Status
              column filled from validation results.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <SubCategoryPicker value={picker} onChange={setPicker} disabled={isUploading} />

            <div className="space-y-2 rounded-md border p-3">
              <Label>Upload sheet (.xlsx)</Label>
              <Input ref={fileRef} type="file" accept=".xlsx" disabled={isUploading} />
              <div className="flex justify-end">
                <Button
                  onClick={handleImport}
                  disabled={isUploading || !picker.subCategoryId}
                >
                  <Upload className="mr-2 h-4 w-4" />
                  {isUploading ? 'Importing...' : 'Import'}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between rounded-md border p-3">
              <span className="text-sm text-muted-foreground">
                Export the same 10 columns with Status filled in.
              </span>
              <Button variant="outline" onClick={handleObsExport} disabled={!picker.subCategoryId}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>

            {report && (
              <div className="rounded-md border bg-muted/30 p-3 text-sm">
                <div className="font-medium">
                  Parsed {report.parsed} · {report.created} created · {report.updated} updated ·{' '}
                  {report.failed} failed
                </div>
                {report.created === 0 && report.updated === 0 && report.failed > 0 && (
                  <div className="mt-2 rounded bg-destructive/10 p-2 text-destructive">
                    {report.errors.some((e) => /default status/i.test(e.message))
                      ? 'Nothing was imported — this Sub-Category has no active default workflow status. Add one in Admin → Status Masters (tick “Default status for new claims”), then re-import.'
                      : 'Nothing was imported — see the row details below.'}
                  </div>
                )}
                {report.errors.length > 0 && (
                  <ul className="mt-2 max-h-40 list-disc space-y-0.5 overflow-auto pl-5 text-destructive">
                    {report.errors.slice(0, 50).map((e, i) => (
                      <li key={`${e.rowNumber}-${i}`}>
                        {e.rowNumber > 0 ? `Row ${e.rowNumber}: ` : ''}
                        {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
