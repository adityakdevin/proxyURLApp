import { useState } from 'react';
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
}: DataTableProps<TData, TValue>) {
  const [sorting, setSorting] = useState<SortingState>([]);

  const table = useReactTable({
    data,
    columns,
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

  return (
    <div className="space-y-4">
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => {
                  const sortField = header.column.columnDef.meta?.sortField;
                  const label = header.isPlaceholder
                    ? null
                    : flexRender(header.column.columnDef.header, header.getContext());
                  const sortable = sortField && onSortChange;
                  return (
                    <TableHead key={header.id}>
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
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  <div className="flex items-center justify-center">
                    <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary"></div>
                    <span className="ml-2">Loading...</span>
                  </div>
                </TableCell>
              </TableRow>
            ) : table.getRowModel().rows?.length ? (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} data-state={row.getIsSelected() && 'selected'}>
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={columns.length} className="h-24 text-center">
                  No results.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between px-2">
        <div className="flex items-center space-x-2">
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

        <div className="flex items-center space-x-6 lg:space-x-8">
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

      {pagination && (
        <div className="text-sm text-muted-foreground text-center">
          Showing {(pagination.page - 1) * pagination.limit + 1} to{' '}
          {Math.min(pagination.page * pagination.limit, pagination.total)} of {pagination.total}{' '}
          entries
        </div>
      )}
    </div>
  );
}
