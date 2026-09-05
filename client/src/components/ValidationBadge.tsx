import { Badge } from '@/components/ui/badge';
import {
  validationStatusLabel,
  validationStatusVariant,
  qrOutcomeLabel,
  qrOutcomeVariant,
} from '@/lib/validationStatus';

/** One validation-check status (Spell / QR / Meta / …) as a coloured badge,
 *  showing the real status (PASSED / FAILED / PENDING / DOCS N/A / …). An optional
 *  `title` (e.g. the misspelled words) shows on hover as a native tooltip. */
export function ValidationBadge({
  status,
  title,
  outcome,
}: {
  status: string;
  title?: string;
  /** QR only: the bifurcated outcome (NO_QR / UNREADABLE / MISMATCH / OK). When present it
   *  replaces the status on the badge — it says everything the status did and more. */
  outcome?: string | null;
}) {
  // A run in flight clears the previous outcome, so mid-run the status is the only
  // truthful thing to show. Same for claims validated before the column existed.
  const showOutcome = !!outcome && status !== 'PENDING' && status !== 'IN_PROGRESS';
  return (
    <Badge
      variant={showOutcome ? qrOutcomeVariant(outcome!) : validationStatusVariant(status)}
      title={title}
      className={title ? 'cursor-help' : undefined}
    >
      {showOutcome ? qrOutcomeLabel(outcome!) : validationStatusLabel(status)}
    </Badge>
  );
}
