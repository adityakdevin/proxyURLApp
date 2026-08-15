import { useState } from 'react';
import { Eye, MoreVertical, RotateCw, Tag, Trash2, UserCheck } from 'lucide-react';
import { api } from '@/lib/api';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useToast } from '@/components/ui/use-toast';
import { Role } from '@/stores/authStore';
import { ClaimAction, ClaimActionDialog, Option } from './ClaimActionDialog';

interface ClaimRowActionsProps {
  claimId: string;
  /** The human claim id, so a confirm names the claim rather than counting it. */
  claimLabel: string;
  /** False for a claim this user may not work on — then nothing but the disabled row shows. */
  canAct: boolean;
  role: Role;
  statusOptions: Option[];
  assigneeOptions: Option[];
  onDone: () => void;
}

const iconButton =
  'rounded p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 disabled:cursor-not-allowed disabled:opacity-40';

/** Per-row actions. Icons for the ones a reviewer reaches for every day; the rest sit in the
 *  menu, where a label is worth more than the width an extra icon would cost. */
export function ClaimRowActions({
  claimId,
  claimLabel,
  canAct,
  role,
  statusOptions,
  assigneeOptions,
  onDone,
}: ClaimRowActionsProps) {
  const { toast } = useToast();
  const [action, setAction] = useState<ClaimAction>(null);
  const [busy, setBusy] = useState(false);

  if (!canAct) return <span className="text-xs text-muted-foreground">—</span>;

  // The list has no document ids, so the first one is looked up on click. The window is
  // opened BEFORE the await — a window.open that runs after one has lost the user-gesture
  // token and is blocked outright in Safari and Firefox.
  const openDocuments = async () => {
    setBusy(true);
    const tab = window.open('', `doc-claim-${claimId}`);
    try {
      const r = await api.get<{ data: { id: string }[] }>(`/claims/${claimId}/documents`);
      const first = r.data[0];
      if (!first) {
        tab?.close();
        return toast({ title: 'No documents on this claim' });
      }
      const href = `/claims/${claimId}/documents/${first.id}`;
      if (tab) tab.location.href = href;
      else window.open(href, `doc-claim-${claimId}`); // popup blocked: try once more on the click's tail
    } catch (e) {
      tab?.close();
      toast({
        title: 'Could not open documents',
        variant: 'destructive',
        description: e instanceof Error ? e.message : 'Failed',
      });
    } finally {
      setBusy(false);
    }
  };

  const revalidate = async () => {
    setBusy(true);
    try {
      await api.post(`/claims/${claimId}/validate`, {});
      toast({ title: 'Re-validation queued' });
      onDone();
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
    <div className="flex items-center gap-0.5">
      {/* The claim id in the first column already opens the claim, so the row keeps one
          "look at it" action: the documents. */}
      <button
        type="button"
        className={iconButton}
        onClick={openDocuments}
        disabled={busy}
        title="Open documents"
        aria-label="Open documents"
      >
        <Eye className="h-4 w-4" />
      </button>
      <button
        type="button"
        className={iconButton}
        onClick={revalidate}
        disabled={busy}
        title="Re-validate"
        aria-label="Re-validate"
      >
        <RotateCw className="h-4 w-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" className={iconButton} title="More actions" aria-label="More actions">
            <MoreVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setAction('status')}>
            <Tag className="mr-2 h-4 w-4" />
            Change status
          </DropdownMenuItem>
          {(role === 'TEAM_LEAD' || role === 'ADMIN') && (
            <DropdownMenuItem onClick={() => setAction('assign')}>
              <UserCheck className="mr-2 h-4 w-4" />
              Reassign
            </DropdownMenuItem>
          )}
          {role === 'ADMIN' && (
            <DropdownMenuItem
              className="text-red-600 focus:text-red-600"
              onClick={() => setAction('delete')}
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete claim
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <ClaimActionDialog
        action={action}
        count={1}
        subject={claimLabel}
        target={{ ids: [claimId] }}
        statusOptions={statusOptions}
        assigneeOptions={assigneeOptions}
        onClose={() => setAction(null)}
        onDone={onDone}
      />
    </div>
  );
}
