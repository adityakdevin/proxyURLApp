import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { api, DataResponse } from '@/lib/api';
import { Button } from '@/components/ui/button';
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
const FAILURE_REASON: Record<string, string> = {
  CLAIM_NOT_EDITABLE: 'you cannot edit this claim',
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

interface ClaimActionDialogProps {
  action: ClaimAction;
  /** How many claims the action will touch — only used in the wording. */
  count: number;
  /** The one claim's id, when the action came from a single row. Named in the wording so a
   *  destructive confirm says WHICH claim, not just how many. */
  subject?: string;
  target: ClaimTarget;
  statusOptions: Option[];
  assigneeOptions: Option[];
  onClose: () => void;
  /** Refetch — every action changes what the rows say. */
  onDone: () => void;
}

/**
 * The confirm-and-collect step for status change, reassignment and delete. One component
 * for both the bulk bar and a single row's menu: a row is just a target of one, and the
 * bulk endpoints already apply the per-claim rules either way.
 */
export function ClaimActionDialog({
  action,
  count,
  subject,
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

  const close = () => {
    setRemarkText('');
    setNewStatusId('');
    setNewAssigneeId('');
    onClose();
  };

  const run = async (endpoint: string, body: Record<string, unknown>, verb: string) => {
    setBusy(true);
    try {
      const r = await api.post<DataResponse<BulkReport>>(endpoint, { ...target, ...body });
      const { succeeded, requested, failed } = r.data;
      const codes = [...new Set(failed.map((f) => f.code))];
      // The bulk endpoints answer 200 with succeeded:0 where the single-claim route used to
      // throw a 403, so a refusal has to be read off the REPORT. Titling on `requested`
      // said "Deleted" for a claim the server refused, then closed the dialog and threw the
      // typed remark away.
      if (succeeded === 0 && requested > 0) {
        toast({
          title: `${verb} failed`,
          variant: 'destructive',
          description: codes.map((c) => FAILURE_REASON[c] ?? c).join(', '),
        });
        return; // dialog stays open, remark intact, nothing refetched
      }
      toast({
        title: requested === 1 ? verb : `${verb}: ${succeeded} of ${requested}`,
        variant: failed.length ? 'destructive' : undefined,
        // Name the reason, not just the number — "8 failed" leaves a reviewer guessing
        // whether it was permissions, a terminal status, or something broken.
        description: failed.length
          ? `${failed.length} failed (${codes.map((c) => FAILURE_REASON[c] ?? c).join(', ')})`
          : undefined,
      });
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

  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
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
        </DialogHeader>

        {action !== 'delete' && (
          <div className="space-y-4 py-2">
            {action === 'status' && (
              <div className="space-y-2">
                <Label>New status</Label>
                <Select value={newStatusId} onValueChange={setNewStatusId}>
                  <SelectTrigger>
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
                <Label>Assign to</Label>
                <Select value={newAssigneeId} onValueChange={setNewAssigneeId}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a user" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={UNASSIGN}>Unassigned</SelectItem>
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
              <Label>Remark</Label>
              <Textarea
                value={remarkText}
                onChange={(e) => setRemarkText(e.target.value)}
                placeholder="Why is this changing?"
                rows={3}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={action === 'delete' ? 'destructive' : 'default'}
            disabled={busy}
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
