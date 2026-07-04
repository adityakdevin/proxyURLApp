import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ColumnDef } from '@tanstack/react-table';
import { Upload, Download } from 'lucide-react';
import { api, DataResponse, PaginatedResponse } from '@/lib/api';
import { DataTable, ServerSort, nextSort } from '@/components/shared/DataTable';
import { TableToolbar } from '@/components/shared/TableToolbar';
import { FilterSelect } from '@/components/shared/FilterSelect';
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

const CHECK_FILTERS = [
  { key: 'spellCheckStatus', label: 'Spell' },
  { key: 'qrStatus', label: 'QR' },
  { key: 'metaExtractionStatus', label: 'Meta' },
  { key: 'intraClaimStatus', label: 'Intra' },
  { key: 'fullScanStatus', label: 'Full' },
] as const;
const CHECK_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'PASSED', label: 'Passed' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'DOCS_NOT_AVAILABLE', label: 'Docs N/A' },
];

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
  const [sort, setSort] = useState<ServerSort>({ field: 'createdAt', order: 'desc' });
  const [checks, setChecks] = useState<Record<string, string>>({});

  const [obsOpen, setObsOpen] = useState(false);
  const [picker, setPicker] = useState<Partial<SubCategoryPickerValue>>({});
  const [isUploading, setIsUploading] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportPicker, setExportPicker] = useState<Partial<SubCategoryPickerValue>>({});

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
      for (const cf of CHECK_FILTERS) {
        if (checks[cf.key]) params.set(cf.key, checks[cf.key]);
      }
      const r = await api.get<PaginatedResponse<ClaimRow>>(`/admin/claims?${params}`);
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

  // Refetch (from page 1) whenever search, check filters, or sort change — including on mount.
  useEffect(() => {
    fetchData(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, sort, checks]);

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
    if (!exportPicker.subCategoryId) {
      return toast({ title: 'Pick a Sub-Category', variant: 'destructive' });
    }
    const params = new URLSearchParams({ subCategoryId: exportPicker.subCategoryId });
    window.open(`/api/admin/claims/export-observations?${params.toString()}`, '_blank');
  };

  const columns: ColumnDef<ClaimRow>[] = [
    {
      accessorKey: 'claimId',
      header: 'Claim ID',
      meta: { sortField: 'claimId' },
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
      header: 'Status',
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
      meta: { sortField: 'spellCheckStatus' },
      cell: ({ row }) => <ValidationBadge status={row.original.spellCheckStatus} />,
    },
    {
      id: 'qr',
      header: 'QR',
      meta: { sortField: 'qrStatus' },
      cell: ({ row }) => <ValidationBadge status={row.original.qrStatus} />,
    },
    {
      id: 'meta',
      header: 'Meta',
      meta: { sortField: 'metaExtractionStatus' },
      cell: ({ row }) => <ValidationBadge status={row.original.metaExtractionStatus} />,
    },
    {
      id: 'intra',
      header: 'Intra-Claim',
      meta: { sortField: 'intraClaimStatus' },
      cell: ({ row }) => <ValidationBadge status={row.original.intraClaimStatus} />,
    },
    {
      id: 'full',
      header: 'Full Scan',
      meta: { sortField: 'fullScanStatus' },
      cell: ({ row }) => <ValidationBadge status={row.original.fullScanStatus} />,
    },
  ];

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold">Claims (All)</h1>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => window.open('/api/admin/claims/observation-template', '_blank')}
          >
            <Download className="mr-2 h-4 w-4" />
            Download Sample Sheet
          </Button>
          <Button variant="outline" onClick={() => setObsOpen(true)}>
            <Upload className="mr-2 h-4 w-4" />
            Upload Claims Sheet
          </Button>
          <Button variant="outline" onClick={() => setExportOpen(true)}>
            <Download className="mr-2 h-4 w-4" />
            Export Observations
          </Button>
        </div>
      </div>
      <div className="mb-4">
        <TableToolbar search={search} onSearchChange={setSearch} placeholder="Search claim id…">
          {CHECK_FILTERS.map((cf) => (
            <FilterSelect
              key={cf.key}
              value={checks[cf.key] ?? ''}
              onChange={(v) => setChecks((prev) => ({ ...prev, [cf.key]: v }))}
              allLabel="All"
              prefix={cf.label}
              options={CHECK_STATUS_OPTIONS}
              className="w-[130px]"
            />
          ))}
        </TableToolbar>
      </div>
      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(p) => fetchData(p, pagination.limit)}
        onPageSizeChange={(l) => fetchData(1, l)}
        isLoading={isLoading}
        sort={sort}
        onSortChange={(f) => setSort((p) => nextSort(p, f))}
      />

      <Dialog open={obsOpen} onOpenChange={handleObsOpenChange}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Upload Claims Sheet</DialogTitle>
            <DialogDescription>
              Upload the observations sheet into a Sub-Category.
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

      <Dialog
        open={exportOpen}
        onOpenChange={(open) => {
          if (!open) setExportPicker({});
          setExportOpen(open);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Export Claims Sheet</DialogTitle>
            <DialogDescription>
              Export the 10-column sheet for a Sub-Category with the Status column filled from
              validation results.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 py-2">
            <SubCategoryPicker value={exportPicker} onChange={setExportPicker} />
            <div className="flex justify-end">
              <Button onClick={handleObsExport} disabled={!exportPicker.subCategoryId}>
                <Download className="mr-2 h-4 w-4" />
                Export
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
