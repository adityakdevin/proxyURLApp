import { Badge } from '@/components/ui/badge';
import {
  binaryValidationStatus,
  validationStatusLabel,
  validationStatusVariant,
} from '@/lib/validationStatus';

/** One validation-check status (Spell / QR / Meta / …) as a coloured badge.
 *  Shown as binary PASSED/FAILED — only an explicit FAILED reads as failed. */
export function ValidationBadge({ status }: { status: string }) {
  const s = binaryValidationStatus(status);
  return <Badge variant={validationStatusVariant(s)}>{validationStatusLabel(s)}</Badge>;
}
