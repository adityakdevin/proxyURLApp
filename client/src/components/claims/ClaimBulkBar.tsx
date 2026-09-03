import { useEffect, useState } from 'react';
import { RotateCw, Tag, UserCheck, Trash2, Undo2 } from 'lucide-react';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { useToast } from '@/components/ui/use-toast';
import { Role } from '@/stores/authStore';
import {
  BULK_MAX,
  BulkReport,
  ClaimAction,
  ClaimActionDialog,
  describeBulkReport,
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
  /** Those same filters in words, for the confirm dialog — that path shows no rows. */
  filtersSummary?: string;
  role: Role;
  /** True when the list is showing soft-deleted claims. Those cannot be re-validated,
   *  re-statused or reassigned — canEditClaim is false for every non-ACTIVE claim, so
   *  offering those buttons only buys a batch of CLAIM_NOT_EDITABLE — so the bar swaps to
   *  the one action that applies. */
  deleted?: boolean;
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
  filtersSummary,
  role,
  deleted = false,
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

  // Disarm whenever the selection empties. The early return below renders null but does NOT
  // unmount, so this flag used to survive the bar disappearing: tick a row, opt into "all
  // 250 matching", untick it, tick a different row — and the bar came back still aimed at
  // 250, including for admin-only delete. The parent clearing the selection on a filter
  // change carried it across filter sets the same way.
  useEffect(() => {
    if (!selectedIds.length) setAllMatching(false);
  }, [selectedIds.length]);

  const count = allMatching ? matchingTotal : selectedIds.length;
  const target = allMatching ? { filters } : { ids: selectedIds };
  // Over the cap the server refuses the WHOLE call, so offering it here only buys a typed
  // remark and a 422. Ticked rows cannot exceed it — the checkboxes are per page.
  const overCap = allMatching && matchingTotal > BULK_MAX;

  const finish = () => {
    setAllMatching(false);
    onClear();
    onDone();
  };

  const revalidate = async () => {
    setBusy(true);
    try {
      const r = await api.post<DataResponse<BulkReport>>('/claims/bulk/validate', target);
      // Same report contract the dialog reads, so the same rules: a batch the server refused
      // outright is not a success. This used to toast a plain "queued" and clear the
      // selection anyway, so there was nothing left to retry.
      const { ok, toast: args } = describeBulkReport(r.data, 'Re-validation queued', 'Re-validation');
      toast(args);
      if (!ok) return;
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

  // The dialog is rendered unconditionally below, so a successful action does not destroy it
  // mid-close: finish() empties the selection, and when the bar itself held the dialog that
  // unmounted the thing Radix was about to restore focus to, dropping focus onto <body>.
  const dialog = (
    <ClaimActionDialog
      action={action}
      count={count}
      targetSummary={filtersSummary}
      target={target}
      statusOptions={statusOptions}
      assigneeOptions={assigneeOptions}
      onClose={() => setAction(null)}
      onDone={finish}
    />
  );

  if (!selectedIds.length) return dialog;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm">
      <span className="font-medium text-blue-900">{count} selected</span>
      {matchingTotal > selectedIds.length && (
        <button
          type="button"
          className="text-blue-700 underline-offset-2 hover:underline"
          onClick={() => setAllMatching((a) => !a)}
          title={
            matchingTotal > BULK_MAX
              ? `One action is limited to ${BULK_MAX} claims — narrow the filters`
              : undefined
          }
        >
          {allMatching ? 'Just the ticked rows' : `Select all ${matchingTotal} matching the filters`}
        </button>
      )}
      {overCap && (
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900">
          over the {BULK_MAX} limit — narrow the filters
        </span>
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
        {deleted ? (
          role === 'ADMIN' && (
            <Button
              variant="outline"
              size="sm"
              disabled={busy || overCap}
              onClick={() => setAction('restore')}
            >
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              Restore
            </Button>
          )
        ) : (
          <>
            <Button variant="outline" size="sm" disabled={busy || overCap} onClick={revalidate}>
              <RotateCw className="mr-1.5 h-3.5 w-3.5" />
              Re-validate
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || overCap}
              onClick={() => setAction('status')}
            >
              <Tag className="mr-1.5 h-3.5 w-3.5" />
              Change status
            </Button>
            {(role === 'TEAM_LEAD' || role === 'ADMIN') && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy || overCap}
                onClick={() => setAction('assign')}
              >
                <UserCheck className="mr-1.5 h-3.5 w-3.5" />
                Reassign
              </Button>
            )}
            {role === 'ADMIN' && (
              <Button
                variant="destructive"
                size="sm"
                disabled={busy || overCap}
                onClick={() => setAction('delete')}
              >
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Delete
              </Button>
            )}
          </>
        )}
      </div>

      {dialog}
    </div>
  );
}
