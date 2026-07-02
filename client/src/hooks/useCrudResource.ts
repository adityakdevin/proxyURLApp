import { useCallback, useEffect, useState } from 'react';
import { api, PaginatedResponse } from '@/lib/api';
import { ServerSort, nextSort } from '@/components/shared/DataTable';
import { useToast } from '@/components/ui/use-toast';

interface Pagination {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface UseCrudResourceOptions {
  /** Base admin endpoint, e.g. '/admin/categories'. */
  endpoint: string;
  /** Singular label used in toast messages, e.g. 'Category'. */
  entityName: string;
  defaultSort?: ServerSort;
  pageSize?: number;
  /** Extra query params, appended when truthy; a change refetches from page 1. */
  filters?: Record<string, string>;
}

type Statusful = { id: string; status?: 'ACTIVE' | 'INACTIVE' };

/**
 * The list + CRUD scaffolding every admin table repeats: paginated/sorted/filtered
 * fetch, refetch-on-change, dialog state, and the create/update/delete/status mutations
 * (with their toasts + refetch). Pages keep their own columns, form fields, and form state;
 * this owns the mechanics. Call the mutation runners after any page-level validation.
 */
export function useCrudResource<T extends Statusful>(opts: UseCrudResourceOptions) {
  const {
    endpoint,
    entityName,
    defaultSort = { field: 'name', order: 'asc' },
    pageSize = 10,
    filters,
  } = opts;
  const { toast } = useToast();

  const [data, setData] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [pagination, setPagination] = useState<Pagination>({
    page: 1,
    limit: pageSize,
    total: 0,
    totalPages: 0,
  });
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'INACTIVE'>('');
  const [sort, setSort] = useState<ServerSort>(defaultSort);

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [isDeleteOpen, setIsDeleteOpen] = useState(false);
  const [isStatusOpen, setIsStatusOpen] = useState(false);
  const [selectedItem, setSelectedItem] = useState<T | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Serialize filters for a stable effect dependency.
  const filterKey = filters ? JSON.stringify(filters) : '';

  const fetchData = useCallback(
    async (page = pagination.page, limit = pagination.limit) => {
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
        if (filters) for (const [k, v] of Object.entries(filters)) if (v) params.set(k, v);
        const res = await api.get<PaginatedResponse<T>>(`${endpoint}?${params}`);
        setData(res.data);
        setPagination(res.pagination);
      } catch (error) {
        toast({
          title: 'Error',
          description: error instanceof Error ? error.message : 'Failed to fetch data',
          variant: 'destructive',
        });
      } finally {
        setIsLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [endpoint, sort, search, status, filterKey]
  );

  // Refetch from page 1 whenever search/filters/sort change (including on mount).
  useEffect(() => {
    fetchData(1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, status, sort, filterKey]);

  const runMutation = async (
    fn: () => Promise<unknown>,
    successMsg: string,
    failMsg: string
  ): Promise<boolean> => {
    setIsSubmitting(true);
    try {
      await fn();
      toast({ title: 'Success', description: successMsg });
      fetchData(pagination.page, pagination.limit);
      return true;
    } catch (error) {
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : failMsg,
        variant: 'destructive',
      });
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  /** POST (create) or PUT (edit, when an item is selected) the given payload. */
  const submit = async (payload: unknown): Promise<boolean> => {
    const ok = await runMutation(
      () =>
        selectedItem
          ? api.put(`${endpoint}/${selectedItem.id}`, payload)
          : api.post(endpoint, payload),
      `${entityName} ${selectedItem ? 'updated' : 'created'} successfully`,
      'Operation failed'
    );
    if (ok) setIsFormOpen(false);
    return ok;
  };

  const remove = async (): Promise<void> => {
    if (!selectedItem) return;
    const ok = await runMutation(
      () => api.delete(`${endpoint}/${selectedItem.id}`),
      `${entityName} deleted successfully`,
      'Delete failed'
    );
    if (ok) setIsDeleteOpen(false);
  };

  const toggleStatus = async (): Promise<void> => {
    if (!selectedItem) return;
    const newStatus = selectedItem.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE';
    const ok = await runMutation(
      () => api.patch(`${endpoint}/${selectedItem.id}/status`, { status: newStatus }),
      `${entityName} ${newStatus === 'ACTIVE' ? 'activated' : 'deactivated'} successfully`,
      'Status change failed'
    );
    if (ok) setIsStatusOpen(false);
  };

  return {
    data,
    isLoading,
    pagination,
    fetchData,
    search,
    setSearch,
    status,
    setStatus,
    sort,
    setSort,
    onSortChange: (field: string) => setSort((p) => nextSort(p, field)),
    selectedItem,
    setSelectedItem,
    isFormOpen,
    setIsFormOpen,
    isDeleteOpen,
    setIsDeleteOpen,
    isStatusOpen,
    setIsStatusOpen,
    isSubmitting,
    askDelete: (item: T) => {
      setSelectedItem(item);
      setIsDeleteOpen(true);
    },
    askStatus: (item: T) => {
      setSelectedItem(item);
      setIsStatusOpen(true);
    },
    submit,
    remove,
    toggleStatus,
  };
}
