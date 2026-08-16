import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';

export interface Option {
  value: string;
  label: string;
}

/** What an action applies to: ticked ids, or everything the list filters match. */
export type ClaimTarget =
  | { ids: string[] }
  | { filters: Record<string, string | boolean | undefined> };

export type ClaimAction = 'status' | 'assign' | 'delete' | null;

/** Sentinel for "clear the assignee" — a Radix Select cannot carry an empty-string value. */
const UNASSIGN = '__unassign__';

/** Server refusal codes, in the words a reviewer can act on. */
export const FAILURE_REASON: Record<string, string> = {
  CLAIM_NOT_EDITABLE: 'you cannot edit this claim',
  INVALID_ASSIGNEE: 'that user cannot be assigned this claim',
  TERMINAL_STATUS: 'the claim is in a terminal status',
  REASSIGN_FORBIDDEN: 'only a Team Lead or Admin can reassign',
  INVALID_STATUS: 'that status no longer exists',
  STATUS_INACTIVE: 'that status is inactive',
  NOT_FOUND: 'the claim no longer exists',
  FAILED: 'the server could not complete it',
};

export interface BulkReport {
  requested: number;
  succeeded: number;
  failed: { id: string; code: string }[];
}

/** Mirrors BULK_MAX in server/src/lib/bulkClaims.ts. Over the cap the server refuses the
 *  WHOLE call with 422 rather than trimming it, so the bar has to stop offering the action
 *  instead of letting a reviewer type a remark for a batch that can never run. */
export const BULK_MAX = 500;

/**
 * Turn a bulk report into the toast it deserves, and say whether the caller may treat the
 * action as done. One function because both consumers of this contract — the dialog and the
 * bulk bar's re-validate — got the `succeeded === 0` case wrong independently: a batch the
 * server refused outright still read as success and threw away the selection or the remark.
 */
export function describeBulkReport(report: BulkReport, verb: string, failVerb = verb) {
  const { succeeded, requested, failed } = report;
  const reasons = [...new Set(failed.map((f) => FAILURE_REASON[f.code] ?? f.code))].join(', ');
  // Nothing succeeded — including the case where the filters matched nothing at all
  // (requested 0), which has an empty failed[] and so no reason to quote.
  if (succeeded === 0) {
    return {
      ok: false,
      toast: {
        title: `${failVerb} failed`,
        variant: 'destructive' as const,
        description: reasons || 'nothing matched — the rows may have changed since you selected them',
      },
    };
  }
  return {
    ok: true,
    toast: {
      title: requested === 1 ? verb : `${verb}: ${succeeded} of ${requested}`,
      variant: failed.length ? ('destructive' as const) : undefined,
      // Name the reason, not just the number — "8 failed" leaves a reviewer guessing whether
      // it was permissions, a terminal status, or something broken.
      description: failed.length ? `${failed.length} failed (${reasons})` : undefined,
    },
  };
}

interface ClaimActionDialogProps {
  action: ClaimAction;
  /** How many claims the action will touch — only used in the wording. */
  count: number;
  /** The one claim's id, when the action came from a single row. Named in the wording so a
   *  destructive confirm says WHICH claim, not just how many. */
  subject?: string;
  /** The filters in human terms, when the target is "everything matching" rather than ticked
   *  rows. That path shows no rows at all, so without this a 500-claim delete confirms
   *  against a bare number and the reviewer has nothing to check it against. */
  targetSummary?: string;
  target: ClaimTarget;
  statusOptions: Option[];
  assigneeOptions: Option[];
  onClose: () => void;
  /** Refetch — every action changes what the rows say. */
  onDone: () => void;
}

/** Above this many claims a delete must be typed out, not just clicked. The filters path
 *  re-resolves server-side, so the set deleted is not guaranteed to be the set counted —
 *  which is exactly when a reflex click is worth slowing down. */
const TYPE_TO_CONFIRM_OVER = 25;

/**
 * The confirm-and-collect step for status change, reassignment and delete. One component
 * for both the bulk bar and a single row's menu: a row is just a target of one, and the
 * bulk endpoints already apply the per-claim rules either way.
 */
export function ClaimActionDialog({
  action,
  count,
  subject,
  targetSummary,
  target,
  statusOptions,
  assigneeOptions,
  onClose,
  onDone,
}: ClaimActionDialogProps) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const [remarkText, setRemarkText] = useState('');
  const [newStatusId, setNewStatusId] = useState('');
  const [newAssigneeId, setNewAssigneeId] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const close = () => {
    setRemarkText('');
    setNewStatusId('');
    setNewAssigneeId('');
    setConfirmText('');
    onClose();
  };

  const run = async (endpoint: string, body: Record<string, unknown>, verb: string) => {
    setBusy(true);
    try {
      const r = await api.post<DataResponse<BulkReport>>(endpoint, { ...target, ...body });
      // The bulk endpoints answer 200 with succeeded:0 where the single-claim route used to
      // throw a 403, so a refusal has to be read off the REPORT. Titling on `requested`
      // said "Deleted" for a claim the server refused, then closed the dialog and threw the
      // typed remark away.
      const { ok, toast: args } = describeBulkReport(r.data, verb);
      toast(args);
      if (!ok) return; // dialog stays open, remark intact, nothing refetched
      close();
      onDone();
    } catch (e) {
      toast({
        title: `${verb} failed`,
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const submit = () => {
    if (action === 'delete') return run('/claims/bulk/delete', {}, 'Deleted');
    if (!remarkText.trim()) {
      return toast({ title: 'A remark is required', variant: 'destructive' });
    }
    if (action === 'assign') {
      if (!newAssigneeId) {
        return toast({ title: 'Pick who to assign to', variant: 'destructive' });
      }
      return run(
        '/claims/bulk/remarks',
        // The key's PRESENCE is what the API reads as "reassign", so it is only sent once a
        // choice exists. UNASSIGN is the explicit way to clear it — the Select used to start
        // empty and send null, so a plain Apply unassigned every target.
        {
          remarkText: remarkText.trim(),
          newAssigneeId: newAssigneeId === UNASSIGN ? null : newAssigneeId,
        },
        'Reassigned'
      );
    }
    if (!newStatusId) return toast({ title: 'Pick a status', variant: 'destructive' });
    return run(
      '/claims/bulk/remarks',
      { remarkText: remarkText.trim(), newStatusId },
      'Status changed'
    );
  };

  const plural = count === 1 ? '' : 's';
  const subjectLabel = subject && count === 1 ? subject : `${count} claim${plural}`;
  const byFilters = 'filters' in target;
  const mustType = action === 'delete' && count > TYPE_TO_CONFIRM_OVER;
  const confirmed = !mustType || confirmText.trim().toUpperCase() === 'DELETE';

  return (
    <Dialog
      open={action !== null}
      // Dismissing mid-request threw away the typed remark for an action that was still
      // running — the same loss the succeeded===0 early-return exists to prevent. The footer
      // buttons were already guarded; Escape, the overlay and the close X were not.
      onOpenChange={(open) => !open && !busy && close()}
    >
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(e) => busy && e.preventDefault()}
        onPointerDownOutside={(e) => busy && e.preventDefault()}
        onInteractOutside={(e) => busy && e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {action === 'delete'
              ? `Delete ${subjectLabel}?`
              : action === 'assign'
                ? `Reassign ${subjectLabel}`
                : `Change status on ${subjectLabel}`}
          </DialogTitle>
          <DialogDescription>
            {action === 'delete'
              ? 'Soft-deleted: hidden from everyone but an admin, and restorable.'
              : 'The remark is written to every claim, so the timeline says why they changed.'}
          </DialogDescription>
          {/* The filters path shows no rows, and the server re-resolves them when the call
              lands — so the set acted on is not guaranteed to be the set counted here. Say
              which filters produced the number, and say that it can move. */}
          {byFilters && (
            <p className="rounded border border-amber-200 bg-amber-50 px-2 py-1.5 text-xs text-amber-900">
              {targetSummary
                ? `Every claim matching ${targetSummary}.`
                : 'Every claim in this list — no filters are applied.'}{' '}
              Counted now; re-resolved when you confirm, so the exact set may differ if the
              list changed.
            </p>
          )}
        </DialogHeader>

        {action !== 'delete' && (
          <div className="space-y-4 py-2">
            {action === 'status' && (
              <div className="space-y-2">
                <Label htmlFor="bulk-new-status">New status</Label>
                <Select value={newStatusId} onValueChange={setNewStatusId}>
                  <SelectTrigger id="bulk-new-status">
                    <SelectValue placeholder="Pick a status" />
                  </SelectTrigger>
                  <SelectContent>
                    {statusOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {action === 'assign' && (
              <div className="space-y-2">
                <Label htmlFor="bulk-assignee">Assign to</Label>
                <Select value={newAssigneeId} onValueChange={setNewAssigneeId}>
                  <SelectTrigger id="bulk-assignee">
                    <SelectValue placeholder="Pick a user" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGN}>— Remove assignee —</SelectItem>
                    {assigneeOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="bulk-remark">Remark</Label>
              <Textarea
                id="bulk-remark"
                value={remarkText}
                onChange={(e) => setRemarkText(e.target.value)}
                placeholder="Why is this changing?"
                rows={3}
                // Matches the server validator on /claims/bulk/remarks. Without it a long
                // remark is only refused after the round-trip, as a bare express-validator
                // 400 that names no field.
                maxLength={2000}
              />
            </div>
          </div>
        )}

        {mustType && (
          <div className="space-y-2 py-2">
            <Label htmlFor="bulk-confirm">
              Type DELETE to confirm {count} claims
            </Label>
            <Input
              id="bulk-confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              placeholder="DELETE"
              autoComplete="off"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            disabled={busy || !confirmed}
            onClick={submit}
          >
            {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {action === 'delete' ? 'Delete' : 'Apply'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
