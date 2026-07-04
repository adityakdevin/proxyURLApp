import { Badge } from '@/components/ui/badge';
import {
  validationStatusLabel,
  validationStatusVariant,
} from '@/lib/validationStatus';

/** One validation-check status (Spell / QR / Meta / …) as a coloured badge,
 *  showing the real status (PASSED / FAILED / PENDING / DOCS N/A / …). */
export function ValidationBadge({ status }: { status: string }) {
  return <Badge variant={validationStatusVariant(status)}>{validationStatusLabel(status)}</Badge>;
}
