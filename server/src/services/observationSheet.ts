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
}

/** The five per-claim validation columns this derivation reads. */
export interface ValidationStatuses {
  spellCheckStatus: string;
  qrStatus: string;
  metaExtractionStatus: string;
  intraClaimStatus: string;
  fullScanStatus: string;
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
