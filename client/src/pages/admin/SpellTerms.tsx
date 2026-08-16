import { useState } from 'react';
import { ColumnDef } from '@tanstack/react-table';
import { MoreHorizontal, Plus, Pencil, Trash2, Power, PowerOff } from 'lucide-react';
import { useCrudResource } from '@/hooks/useCrudResource';
import { DataTable } from '@/components/shared/DataTable';
import { TableToolbar } from '@/components/shared/TableToolbar';
import { FilterSelect, STATUS_OPTIONS } from '@/components/shared/FilterSelect';
import { ConfirmDialog } from '@/components/shared/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

interface SpellTerm {
  id: string;
  term: string;
  status: 'ACTIVE' | 'INACTIVE';
}

/** Keep in step with MIN_TERM_LEN in server/src/validators/logic.ts — the server is the
 *  one that enforces it; this only saves the admin a round-trip. */
const MIN_TERM_LEN = 4;

export default function SpellTerms() {
  const { toast } = useToast();
  const crud = useCrudResource<SpellTerm>({
    endpoint: '/admin/spell-terms',
    entityName: 'Spell term',
    defaultSort: { field: 'term', order: 'asc' },
    // The server saves the term either way and returns an advisory when it looks like a
    // place or brand name. Shown as its own toast, after the success one, so the admin sees
    // that it saved AND why it may need watching. Deletes and status toggles carry no
    // warning, so this is a no-op for them.
    onMutationResponse: (body) => {
      const warning = (body as { warning?: string | null } | null)?.warning;
      if (warning) {
        toast({ title: 'Saved — worth a look', description: warning, duration: 12000 });
      }
    },
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

  const [term, setTerm] = useState('');

  const handleCreate = () => {
    setSelectedItem(null);
    setTerm('');
    setIsFormOpen(true);
  };

  const handleEdit = (item: SpellTerm) => {
    setSelectedItem(item);
    setTerm(item.term);
    setIsFormOpen(true);
  };

  const handleSubmit = () => {
    const cleaned = term.trim();
    if (!cleaned) {
      toast({ title: 'Validation Error', description: 'Term is required', variant: 'destructive' });
      return;
    }
    // Mirrors SpellTermService.assertMatchable. Both shapes used to save happily and then
    // never flag anything — the server rejects them now, this just says so without a trip.
    if (/\s/.test(cleaned)) {
      toast({
        title: 'Validation Error',
        description:
          'A term must be a single word — the spell check compares one word at a time. Add each word separately.',
        variant: 'destructive',
      });
      return;
    }
    if (cleaned.length < MIN_TERM_LEN) {
      toast({
        title: 'Validation Error',
        description: `A term must be at least ${MIN_TERM_LEN} characters — shorter terms match too many unrelated words.`,
        variant: 'destructive',
      });
      return;
    }
    submit({ term: cleaned });
  };

  const columns: ColumnDef<SpellTerm>[] = [
    { accessorKey: 'term', header: 'Term' },
    {
      accessorKey: 'status',
      header: 'Status',
      cell: ({ row }) => (
        <Badge variant={row.original.status === 'ACTIVE' ? 'success' : 'secondary'}>
          {row.original.status}
        </Badge>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" className="h-8 w-8 p-0">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => handleEdit(row.original)}>
              <Pencil className="mr-2 h-4 w-4" />Edit
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => askStatus(row.original)}>
              {row.original.status === 'ACTIVE' ? (
                <><PowerOff className="mr-2 h-4 w-4" />Deactivate</>
              ) : (
                <><Power className="mr-2 h-4 w-4" />Activate</>
              )}
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
        <div>
          <h1 className="text-2xl font-bold">Spell Dictionary</h1>
          <p className="text-sm text-muted-foreground">
            Expected vocabulary the spell-check flags misspellings of. Keep to form and domain
            words. Avoid place and brand names — scanners read them worst, so they produce
            false alarms on correctly printed documents.
          </p>
        </div>
        <Button onClick={handleCreate}><Plus className="mr-2 h-4 w-4" />Add Term</Button>
      </div>

      <div className="mb-4">
        <TableToolbar search={search} onSearchChange={setSearch} placeholder="Search terms…">
          <FilterSelect
            value={status}
            onChange={(v) => setStatus(v as '' | 'ACTIVE' | 'INACTIVE')}
            allLabel="All statuses"
            options={STATUS_OPTIONS}
          />
        </TableToolbar>
      </div>

      <DataTable
        columns={columns}
        data={data}
        pagination={pagination}
        onPageChange={(page) => fetchData(page, pagination.limit)}
        onPageSizeChange={(limit) => fetchData(1, limit)}
        isLoading={isLoading}
      />

      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{selectedItem ? 'Edit Term' : 'Add Term'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="term">Term <span className="text-destructive">*</span></Label>
              <Input
                id="term"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
                // Form words only. This used to read "…, bajaj" — a brand name, offered as
                // an example directly under a heading that says to avoid them. Production
                // had eight such terms, and 'lucknow' among them was the confirmed cause of
                // a reported false positive.
                placeholder="e.g. profession, signatory, allowance"
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              <p className="text-xs text-muted-foreground">
                Stored lowercase. A document word that is a close misspelling of an active term is
                flagged. One word per term, {MIN_TERM_LEN} characters or more — a phrase such as
                &ldquo;security guard&rdquo; must be added as &ldquo;security&rdquo; and
                &ldquo;guard&rdquo; separately.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)} disabled={isSubmitting}>Cancel</Button>
            <Button onClick={handleSubmit} disabled={isSubmitting}>{isSubmitting ? 'Saving...' : 'Save'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={isDeleteOpen}
        onOpenChange={setIsDeleteOpen}
        title="Delete Term"
        description={`Are you sure you want to delete "${selectedItem?.term}"? This action cannot be undone.`}
        confirmText="Delete"
        onConfirm={remove}
        variant="destructive"
        isLoading={isSubmitting}
      />
      <ConfirmDialog
        open={isStatusOpen}
        onOpenChange={setIsStatusOpen}
        title={selectedItem?.status === 'ACTIVE' ? 'Deactivate Term' : 'Activate Term'}
        description={
          selectedItem?.status === 'ACTIVE'
            ? `Deactivate "${selectedItem?.term}"? It will no longer be used by the spell-check.`
            : `Activate "${selectedItem?.term}"?`
        }
        confirmText={selectedItem?.status === 'ACTIVE' ? 'Deactivate' : 'Activate'}
        onConfirm={toggleStatus}
        variant={selectedItem?.status === 'ACTIVE' ? 'destructive' : 'default'}
        isLoading={isSubmitting}
      />
    </div>
  );
}
