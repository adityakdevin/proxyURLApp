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

interface BulkReport {
  requested: number;
  succeeded: number;
  failed: { id: string; code: string }[];
}

interface ClaimActionDialogProps {
  action: ClaimAction;
  /** How many claims the action will touch — only used in the wording. */
  count: number;
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
      toast({
        title: requested === 1 ? verb : `${verb}: ${succeeded} of ${requested}`,
        variant: failed.length ? 'destructive' : undefined,
        // Name the reason, not just the number — "8 failed" leaves a reviewer guessing
        // whether it was permissions, a terminal status, or something broken.
        description: failed.length
          ? `${failed.length} failed (${[...new Set(failed.map((f) => f.code))].join(', ')})`
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
      return run(
        '/claims/bulk/remarks',
        // Empty means "unassign", which the API takes as an explicit null.
        { remarkText: remarkText.trim(), newAssigneeId: newAssigneeId || null },
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

  return (
    <Dialog open={action !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {action === 'delete'
              ? `Delete ${count} claim${plural}?`
              : action === 'assign'
                ? `Reassign ${count} claim${plural}`
                : `Change status on ${count} claim${plural}`}
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
