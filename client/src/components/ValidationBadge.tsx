import { Badge } from '@/components/ui/badge';
import {
  validationStatusLabel,
  validationStatusVariant,
} from '@/lib/validationStatus';

/** One validation-check status (Spell / QR / Meta / …) as a coloured badge,
 *  showing the real status (PASSED / FAILED / PENDING / DOCS N/A / …). An optional
 *  `title` (e.g. the misspelled words) shows on hover as a native tooltip. */
export function ValidationBadge({ status, title }: { status: string; title?: string }) {
  return (
    <Badge
      variant={validationStatusVariant(status)}
      title={title}
      className={title ? 'cursor-help' : undefined}
    >
      {validationStatusLabel(status)}
    </Badge>
  );
}
