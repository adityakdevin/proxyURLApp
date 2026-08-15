import { useEffect, useRef, useState } from 'react';
import {
  ColumnDef,
  RowData,
  flexRender,
  getCoreRowModel,
  useReactTable,
  SortingState,
  getSortedRowModel,
  getPaginationRowModel,
} from '@tanstack/react-table';

// Columns opt into server-side sorting by declaring the API sort key in `meta.sortField`.
declare module '@tanstack/react-table' {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    sortField?: string;
  }
}

export interface ServerSort {
  field: string;
  order: 'asc' | 'desc';
}

/** Toggle sort order when re-clicking the same field, else sort the new field ascending. */
export function nextSort(prev: ServerSort, field: string): ServerSort {
  return prev.field === field
    ? { field, order: prev.order === 'asc' ? 'desc' : 'asc' }
    : { field, order: 'asc' };
}
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
} from 'lucide-react';

/** Row selection for bulk actions. Ids rather than row indexes, so a selection survives
 *  paging and sorting; the owning page decides what "selected" then means. */
export interface RowSelection<TData> {
  selectedIds: string[];
  /** Takes an updater, not a value: two toggles inside one React batch both read the same
   *  prop, so passing a computed array dropped the first one. */
  onChange: (update: (ids: string[]) => string[]) => void;
  rowId: (row: TData) => string;
  /** What a screen reader should call the row — the id is a UUID, which says nothing. */
  rowLabel?: (row: TData) => string;
  /** Rows that cannot be acted on get no checkbox (e.g. a claim the user may not edit). */
  isSelectable?: (row: TData) => boolean;
}

interface DataTableProps<TData, TValue> {
  columns: ColumnDef<TData, TValue>[];
  data: TData[];
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (pageSize: number) => void;
  isLoading?: boolean;
  /** Current server-side sort; when provided with onSortChange, headers with meta.sortField become clickable. */
  sort?: ServerSort;
  onSortChange?: (field: string) => void;
  selection?: RowSelection<TData>;
}

/** Native checkbox — the only thing a component buys here is the indeterminate flag, which
 *  has no HTML attribute and must be set on the element. */
function SelectBox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = !!indeterminate && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      className="h-4 w-4 cursor-pointer align-middle accent-primary"
      checked={checked}
      onChange={onChange}
      aria-label={label}
    />
  );
}

export function DataTable<TData, TValue>({
  columns,
  data,
  pagination,
  onPageChange,
  onPageSizeChange,
  isLoading,
  sort,
  onSortChange,
  selection,
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const selected = new Set(selection?.selectedIds ?? []);
  const pageIds = selection
    ? data.filter((r) => selection.isSelectable?.(r) ?? true).map(selection.rowId)
    : [];
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id));

  const toggleOne = (id: string) => {
    if (!selection) return;
    selection.onChange((ids) =>
      ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]
    );
  };
  // The header box acts on THIS page only; acting on everything the filters match is a
  // separate, explicit choice the page offers once rows are ticked.
  const togglePage = () => {
    if (!selection) return;
    selection.onChange((ids) => {
      const next = new Set(ids);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return [...next];
    });
  };

  const selectColumn: ColumnDef<TData, TValue> = {
    id: '__select',
    header: () => (
      <SelectBox
        checked={allPageSelected}
        indeterminate={pageIds.some((id) => selected.has(id))}
        onChange={togglePage}
        label="Select all rows on this page"
      />
    ),
    cell: ({ row }) => {
      if (selection?.isSelectable && !selection.isSelectable(row.original)) return null;
      const id = selection!.rowId(row.original);
      return (
        <SelectBox
          checked={selected.has(id)}
          onChange={() => toggleOne(id)}
          label={`Select ${selection!.rowLabel?.(row.original) ?? `row ${id}`}`}
        />
      );
    },
  };
  const allColumns = selection ? [selectColumn, ...columns] : columns;

  const table = useReactTable({
    data,
    columns: allColumns,
    getCoreRowModel: getCoreRowModel(),
    onSortingChange: setSorting,
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: pagination ? undefined : getPaginationRowModel(),
    state: {
      sorting,
    },
    manualPagination: !!pagination,
    pageCount: pagination?.totalPages ?? -1,
  });

  const pageSizeOptions = [10, 25, 50, 100];

  // Every table here names its row-action column 'actions' and puts it last. Pin it to the
  // right edge: a wide table scrolls its middle columns, and the actions a reviewer came for
  // must not be the part that scrolls out of reach.
  const stickyActions = (columnId: string) =>
    columnId === 'actions'
      // bg-inherit, not bg-background: an opaque cell paints over the row's hover and
      // selected tint, leaving a white block exactly where the eye tracks across the row.
      ? 'sticky right-0 z-20 bg-inherit shadow-[inset_1px_0_0_hsl(var(--border))]'
      : '';

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table containerClassName="max-h-[70vh]">
          <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-background [&_th]:shadow-[inset_0_-1px_0_hsl(var(--border))]">
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortField = header.column.columnDef.meta?.sortField;
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  const sortable = sortField && onSortChange;
                  const sortedBy = sort?.field === sortField;
                  return (
                    <TableHead
                      key={header.id}
                      // Both arguments matter: the first carries the sticky/right-0 classes,
                      // the second the header-only overrides, and cn() (twMerge) resolves the
                      // conflicts between them. `[&]:z-30` rather than `z-30` because
                      // TableHeader's `[&_th]:z-10` is a class+type selector and outranks a
                      // bare utility on the th itself.
                      className={cn(
                        stickyActions(header.column.id),
                        stickyActions(header.column.id) &&
                          '[&]:z-30 bg-background shadow-[inset_1px_0_0_hsl(var(--border)),inset_0_-1px_0_hsl(var(--border))]'
                      )}
                      // Sort direction was conveyed by an arrow icon alone, so a screen
                      // reader could not tell the table was sorted, or by what.
                      aria-sort={
                        sortable
                          ? sortedBy
                            ? sort!.order === 'asc'
                              ? 'ascending'
                              : 'descending'
                            : 'none'
                          : undefined
                      }
                    >
                      {sortable ? (
                        <button
                          type="button"
                          className="-ml-1 inline-flex items-center gap-1 hover:text-foreground"
                          onClick={() => onSortChange(sortField)}
                        >
                          {label}
                          {sort?.field === sortField ? (
                            sort.order === 'asc' ? (
                              <ArrowUp className="h-3.5 w-3.5" />
                            ) : (
                              <ArrowDown className="h-3.5 w-3.5" />
                            )
                          ) : (
                            <ArrowUpDown className="h-3.5 w-3.5 opacity-40" />
                          )}
                        </button>
                      ) : (
                        label
                      )}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={allColumns.length} className="h-24 text-center">
                  <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                    <span className="ml-2">Loading...</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                // Selection lives in the page's state, not TanStack's, so the row tint has to
                // read the same source the checkbox does — getIsSelected() is always false
                // here, which meant a ticked row got no row-level feedback at all.
                <TableRow
                  key={row.id}
                  className="bg-background"
                  data-state={
                    selection && selected.has(selection.rowId(row.original)) ? 'selected' : undefined
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id} className={stickyActions(cell.column.id)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={allColumns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination: one row — page size left, the range in the middle, the pager right. */}
      <div className="flex items-center justify-between gap-4 px-2">
        <div className="flex flex-1 items-center space-x-2">
          <p className="text-sm text-muted-foreground">Rows per page</p>
          <Select
            value={String(pagination?.limit ?? 10)}
            onValueChange={(value) => onPageSizeChange?.(Number(value))}
          >
            <SelectTrigger className="h-8 w-[70px]">
              <SelectValue placeholder={pagination?.limit ?? 10} />
            </SelectTrigger>
            <SelectContent side="top">
              {pageSizeOptions.map((pageSize) => (
                <SelectItem key={pageSize} value={String(pageSize)}>
                  {pageSize}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {pagination && (
          <div className="whitespace-nowrap text-center text-sm text-muted-foreground">
            Showing {(pagination.page - 1) * pagination.limit + 1} to{' '}
            {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}{' '}
            entries
          </div>
        )}

        <div className="flex flex-1 items-center justify-end space-x-6 lg:space-x-8">
          <div className="flex w-[100px] items-center justify-center text-sm text-muted-foreground">
            {pagination ? (
              <>
                Page {pagination.page} of {pagination.totalPages}
              </>
            ) : (
              <>
                Page {table.getState().pagination.pageIndex + 1} of {table.getPageCount()}
              </>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() => (pagination ? onPageChange?.(1) : table.setPageIndex(0))}
              disabled={pagination ? pagination.page <= 1 : !table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to first page</span>
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() =>
                pagination
                  ? onPageChange?.(pagination.page - 1)
                  : table.previousPage()
              }
              disabled={pagination ? pagination.page <= 1 : !table.getCanPreviousPage()}
            >
              <span className="sr-only">Go to previous page</span>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="h-8 w-8 p-0"
              onClick={() =>
                pagination
                  ? onPageChange?.(pagination.page + 1)
                  : table.nextPage()
              }
              disabled={
                pagination
                  ? pagination.page >= pagination.totalPages
                  : !table.getCanNextPage()
              }
            >
              <span className="sr-only">Go to next page</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              className="hidden h-8 w-8 p-0 lg:flex"
              onClick={() =>
                pagination
                  ? onPageChange?.(pagination.totalPages)
                  : table.setPageIndex(table.getPageCount() - 1)
              }
              disabled={
                pagination
                  ? pagination.page >= pagination.totalPages
                  : !table.getCanNextPage()
              }
            >
              <span className="sr-only">Go to last page</span>
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
