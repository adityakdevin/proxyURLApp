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

export function validationStatusCardClass(s: string): string {
  switch (s) {
    case 'PASSED':
      return 'border-green-500 bg-white';
    case 'FAILED':
      return 'border-red-600 bg-white';
    case 'IN_PROGRESS':
      return 'border-gray-400 bg-white';
    case 'DOCS_NOT_AVAILABLE':
      return 'border-yellow-500 bg-white';
    default:
      return 'bg-white';
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
