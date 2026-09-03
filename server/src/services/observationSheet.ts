/**
 * Shared contract for the "Forged Documents Observations" spreadsheet I/O.
 *
 * The same 10-column layout is used in both directions:
 *  - import  (observationImportService): operator uploads the filled sheet
 *  - export  (claimReportService):       we re-emit it with Status derived
 *
 * Kept dependency-free (pure types + helpers + the canonical header list) so it
 * can be imported by the parser, the report builder, and ClaimService without
 * risking an import cycle.
 */

/** Canonical header row, in column order, exactly as the source sheet uses. */
export const OBSERVATION_HEADERS = [
  'S. No',
  'Claim ID',
  'Dealer Name',
  'Dealer Code',
  'Invoice Date',
  'VIN No.',
  'Customer Name',
  'Scheme Type',
  'Status',
  'Remarks',
] as const;

/** The single Status value written to the export, collapsed from the 5 checks.
 *  Binary model: only an explicit FAILED flags forgery; everything else is clean. */
export type ForgeryStatus = 'Forged' | 'OK';

/** A row read off the uploaded sheet. `S. No`/`Status` are intentionally dropped
 *  (S.No is regenerated on export; Status is derived from validation). */
export interface ParsedObservationRow {
  /** 1-based worksheet row number — used to address bad rows in the report. */
  rowNumber: number;
  claimId: string;
  dealerName: string | null;
  dealerCode: string | null;
  invoiceDate: Date | null;
  vinNo: string | null;
  customerName: string | null;
  schemeType: string | null;
  remarks: string | null;
}

/** The five per-claim validation columns this derivation reads. */
export interface ValidationStatuses {
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
}

/** The five per-claim checks, in export-column order: the sheet header and the
 *  field it reads. Status alone only says *that* a claim is forged; these say
 *  which check caught it, so failures can be grouped by category. */
export const OBSERVATION_CHECK_COLUMNS: { header: string; field: keyof ValidationStatuses }[] = [
  { header: 'Spell Check', field: 'spellCheckStatus' },
  { header: 'QR Code', field: 'qrStatus' },
  { header: 'Meta', field: 'metaExtractionStatus' },
  { header: 'Intra Claim', field: 'intraClaimStatus' },
  { header: 'Full Scan', field: 'fullScanStatus' },
];

/** Header for the summary column: the failing checks, comma-joined. */
export const FAILED_CHECKS_HEADER = 'Failed Checks';

/** Export header row: the 10 upload columns, the failure summary, then the 5 check outcomes.
 *  Appended rather than inserted so S. No -> Remarks keep the column positions the
 *  uploaded sheet uses, and an exported file can be re-uploaded unchanged. */
export const OBSERVATION_EXPORT_HEADERS: readonly string[] = [
  ...OBSERVATION_HEADERS,
  FAILED_CHECKS_HEADER,
  ...OBSERVATION_CHECK_COLUMNS.map((c) => c.header),
];

/** Which checks actually failed, comma-joined, for the summary column. Empty when none
 *  did — a reviewer scanning the column wants the failures to be the only thing in it. */
export function failedCheckNames(checks: ValidationStatuses): string {
  return OBSERVATION_CHECK_COLUMNS.filter((c) => checks[c.field] === 'FAILED')
    .map((c) => c.header)
    .join(', ');
}

/** A per-row problem surfaced during import (parse-stage or persist-stage).
 *  rowNumber 0 denotes a file/sheet-level note rather than a specific row. */
export interface ObservationRowError {
  rowNumber: number;
  message: string;
}

/** A fully-resolved export row (all strings, ready for ExcelJS). */
export interface ObservationExportRow {
  sNo: number;
  claimId: string;
  dealerName: string;
  dealerCode: string;
  invoiceDate: string;
  vinNo: string;
  customerName: string;
  schemeType: string;
  status: ForgeryStatus;
  remarks: string;
  /** The five check outcomes behind `status`, so the export can say WHICH one failed. */
  checks: ValidationStatuses;
}

/**
 * Collapse the 5 validation checks into one binary Status:
 *  - any FAILED -> 'Forged'
 *  - otherwise (PASSED / PENDING / IN_PROGRESS / DOCS_NOT_AVAILABLE) -> 'OK'
 */
export function deriveForgeryStatus(v: ValidationStatuses): ForgeryStatus {
  const checks = [
    v.spellCheckStatus,
    v.qrStatus,
    v.metaExtractionStatus,
    v.intraClaimStatus,
    v.fullScanStatus,
  ];
  return checks.some((s) => s === 'FAILED') ? 'Forged' : 'OK';
}
