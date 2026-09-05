/**
 * The per-check filters, shared by the admin claim list and the Claim Dashboard.
 *
 * One definition rather than two: these lived only in AdminClaims, which is why reviewers
 * without admin rights had no way to filter by checkpoint at all — the request that this
 * addresses. A check added here appears in both screens.
 */
export const CHECK_FILTERS = [
  { key: 'spellCheckStatus', label: 'Spell' },
  { key: 'qrStatus', label: 'QR' },
  { key: 'metaExtractionStatus', label: 'Meta' },
  { key: 'intraClaimStatus', label: 'Intra' },
  { key: 'fullScanStatus', label: 'Full' },
  { key: 'redFlagStatus', label: 'Red Flag' },
  { key: 'duplicateStatus', label: 'Duplicate' },
] as const;

export type CheckFilterKey = (typeof CHECK_FILTERS)[number]['key'];

export const CHECK_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'IN_PROGRESS', label: 'In Progress' },
  { value: 'PASSED', label: 'Passed' },
  { value: 'DOUBTFUL', label: 'Doubtful' },
  { value: 'FAILED', label: 'Failed' },
  { value: 'DOCS_NOT_AVAILABLE', label: 'Docs N/A' },
];
