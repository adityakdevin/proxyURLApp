import { Badge } from '@/components/ui/badge';
import { validationStatusLabel, validationStatusVariant } from '@/lib/validationStatus';

/** One validation-check status (Spell / QR / Meta / …) as a coloured badge with a friendly label. */
export function ValidationBadge({ status }: { status: string }) {
  return <Badge variant={validationStatusVariant(status)}>{validationStatusLabel(status)}</Badge>;
}
