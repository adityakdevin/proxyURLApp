import { useState } from 'react';
import { RotateCw, Tag, UserCheck, Trash2 } from 'lucide-react';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Role } from '@/stores/authStore';
import {
  BulkReport,
  ClaimAction,
  ClaimActionDialog,
  FAILURE_REASON,
  Option,
} from './ClaimActionDialog';

interface ClaimBulkBarProps {
  /** Ids ticked on the pages the reviewer has visited. */
  selectedIds: string[];
  onClear: () => void;
  /** Claims matching the current filters, i.e. what "all matching" would act on. */
  matchingTotal: number;
  /** The list's current filters, sent instead of ids when acting on all matching. */
  filters: Record<string, string | boolean | undefined>;
  role: Role;
  statusOptions: Option[];
  assigneeOptions: Option[];
  /** Refetch the list — every action changes what the rows say. */
  onDone: () => void;
}

export function ClaimBulkBar({
  selectedIds,
  onClear,
  matchingTotal,
  filters,
  role,
  statusOptions,
  assigneeOptions,
  onDone,
}: ClaimBulkBarProps) {
  const { toast } = useToast();
  // Ticked ids vs "every claim the filters match" — the second is what makes a bulk action
  // useful past one page, and is never assumed: it has to be turned on deliberately.
  const [allMatching, setAllMatching] = useState(false);
  const [action, setAction] = useState<ClaimAction>(null);
  const [busy, setBusy] = useState(false);

  if (!selectedIds.length) return null;

  const count = allMatching ? matchingTotal : selectedIds.length;
  const target = allMatching ? { filters } : { ids: selectedIds };

  const finish = () => {
    setAllMatching(false);
    onClear();
    onDone();
  };

  const revalidate = async () => {
    setBusy(true);
    try {
      const r = await api.post<DataResponse<BulkReport>>('/claims/bulk/validate', target);
      const { succeeded, requested, failed } = r.data;
      // The failed[] array was being dropped here, so 45 refusals out of 50 still showed a
      // plain "queued" toast.
      toast({
        title: `Re-validation queued: ${succeeded} of ${requested}`,
        variant: failed.length ? 'destructive' : undefined,
        description: failed.length
          ? `${failed.length} refused: ${[...new Set(failed.map((f) => FAILURE_REASON[f.code] ?? f.code))].join(', ')}`
          : undefined,
      });
      finish();
    } catch (e) {
      toast({
        title: 'Re-validation failed',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
      <span className="font-medium text-blue-900">{count} selected</span>
      {matchingTotal > selectedIds.length && (
        <button
          type="button"
          className="text-blue-700 underline-offset-2 hover:underline"
          onClick={() => setAllMatching((a) => !a)}
        >
          {allMatching ? 'Just the ticked rows' : `Select all ${matchingTotal} matching the filters`}
        </button>
      )}
      <button
        type="button"
        className="text-blue-700 underline-offset-2 hover:underline"
        onClick={() => {
          setAllMatching(false);
          onClear();
        }}
      >
        Clear
      </button>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" disabled={busy} onClick={revalidate}>
          <RotateCw className="mr-1.5 h-3.5 w-3.5" />
          Re-validate
        </Button>
        <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction('status')}>
          <Tag className="mr-1.5 h-3.5 w-3.5" />
          Change status
        </Button>
        {(role === 'TEAM_LEAD' || role === 'ADMIN') && (
          <Button variant="outline" size="sm" disabled={busy} onClick={() => setAction('assign')}>
            <UserCheck className="mr-1.5 h-3.5 w-3.5" />
            Reassign
          </Button>
        )}
        {role === 'ADMIN' && (
          <Button variant="destructive" size="sm" disabled={busy} onClick={() => setAction('delete')}>
            <Trash2 className="mr-1.5 h-3.5 w-3.5" />
            Delete
          </Button>
        )}
      </div>

      <ClaimActionDialog
        action={action}
        count={count}
        target={target}
        statusOptions={statusOptions}
        assigneeOptions={assigneeOptions}
        onClose={() => setAction(null)}
        onDone={finish}
      />
    </div>
  );
}
