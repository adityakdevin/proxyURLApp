import { useState } from 'react';
import { Eye, Loader2, MoreVertical, RotateCw, Tag, Trash2, UserCheck } from 'lucide-react';
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
  /**
   * True while THIS claim's checks are actually executing.
   *
   * Distinct from `busy`, which only covers the POST. Queueing returns in a few hundred
   * milliseconds and the run itself takes far longer, so a spinner tied to the request
   * blinks once and goes idle while the work it started has not begun — a row showing five
   * IN PROGRESS badges next to a resting ↻ is what "the icon never loads" actually looks
   * like. The row already knows this; it renders those badges from the same object.
   */
  running?: boolean;
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
  running = false,
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
    // `window.open('', name)` does NOT navigate an existing window of that name — it hands
    // back the one already open. Writing to it would wipe a viewer the reviewer is using
    // (scroll position, selected finding), and closing it on error would take away a window
    // they never asked to lose. So only touch a tab we actually just created: a fresh one is
    // on about:blank with an empty body.
    const isFresh = !!tab && tab.location.href === 'about:blank' && !tab.document.body?.hasChildNodes();
    // A fresh tab sits on about:blank until the lookup resolves — give it something to say.
    if (isFresh) {
      tab!.document.write(
        '<title>Opening documents…</title><p style="font:14px system-ui;padding:2rem">Opening documents…</p>'
      );
    }
    try {
      const r = await api.get<{ data: { id: string }[] }>(`/claims/${claimId}/documents`);
      const first = r.data[0];
      if (!first) {
        // Leave the reason THERE rather than closing and toasting on the page the browser
        // just left, where nobody reads it.
        if (isFresh) {
          tab!.document.body.innerHTML =
            '<p style="font:14px system-ui;padding:2rem">This claim has no documents yet.</p>';
        }
        return toast({ title: 'No documents on this claim' });
      }
      const href = `/claims/${claimId}/documents/${first.id}`;
      if (tab) tab.location.href = href;
      else window.open(href, `doc-claim-${claimId}`); // popup blocked: try once more on the click's tail
    } catch (e) {
      if (isFresh) tab!.close();
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
        title={busy ? 'Queueing re-validation…' : running ? 'Validation running…' : 'Re-validate'}
        aria-label={busy ? 'Queueing re-validation' : running ? 'Validation running' : 'Re-validate'}
      >
        {/* Spins for the request AND for the run it starts. Tying it to the request alone
            was the earlier mistake: queueing returns in about 200ms, so the spinner flashed
            and the icon sat still through the minutes of work that followed.

            Deliberately NOT disabled while `running`. Re-queueing a claim mid-run is
            harmless — the drainer claims each run atomically — and a wedged run is exactly
            when a reviewer needs the button most. Greying it out would take the retry away
            at the only moment it matters. */}
        {busy || running ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <RotateCw className="h-4 w-4" />
        )}
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {/* disabled while busy, like its two siblings — otherwise an in-flight re-validate
              can have a status change or a delete started on top of it. */}
          <button
            type="button"
            className={iconButton}
            disabled={busy}
            title="More actions"
            aria-label="More actions"
          >
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
