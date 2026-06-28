// Display + colour helpers for the five per-claim validation checks
// (Spell / QR / Meta / Intra-Claim / Full Scan). Kept in one place so every
// table and the claim detail view render the same labels and badge colours.

export type ValidationStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'PASSED'
  | 'FAILED'
  | 'DOCS_NOT_AVAILABLE';

type BadgeVariant =
  | 'default'
  | 'secondary'
  | 'destructive'
  | 'outline'
  | 'success'
  | 'warning';

/** Status options offered when building a claim rule on a validation-status field. */
export const VALIDATION_STATUS_VALUES: ValidationStatus[] = [
  'PENDING',
  'IN_PROGRESS',
  'PASSED',
  'FAILED',
  'DOCS_NOT_AVAILABLE',
];

/** Short, readable label for a validation status badge. */
export function validationStatusLabel(s: string): string {
  switch (s) {
    case 'DOCS_NOT_AVAILABLE':
      return 'DOCS N/A';
    case 'IN_PROGRESS':
      return 'IN PROGRESS';
    default:
      return s;
  }
}

/** Badge colour for a validation status. */
export function validationStatusVariant(s: string): BadgeVariant {
  switch (s) {
    case 'PASSED':
      return 'success';
    case 'FAILED':
      return 'destructive';
    case 'IN_PROGRESS':
      return 'secondary';
    case 'DOCS_NOT_AVAILABLE':
      return 'warning';
    default:
      return 'outline';
  }
}
