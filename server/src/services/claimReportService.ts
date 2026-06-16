import ExcelJS from 'exceljs';
import { ExportRow } from './claimService.js';
import { OBSERVATION_HEADERS, ObservationExportRow } from './observationSheet.js';

const HEADERS = [
  'Claim ID',
  'Sub-Category',
  'Category',
  'Workflow Status',
  'Assigned To',
  'Spell',
  'QR',
  'Meta',
  'Intra-Claim',
  'Full Scan',
  'Documents',
  'Created',
];

/**
 * Neutralise spreadsheet formula injection: a cell whose text begins with one of
 * = + - @ (or a leading control char) is prefixed with an apostrophe so Excel /
 * LibreOffice render it as literal text instead of evaluating it. Values here can
 * originate from dealer-supplied document data, so they are not trusted.
 */
function sanitizeCell(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

export function buildClaimsWorkbook(rows: ExportRow[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claims');
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      sanitizeCell(r.claimId),
      sanitizeCell(r.subCategory),
      sanitizeCell(r.category),
      sanitizeCell(r.workflowStatus),
      sanitizeCell(r.assignedTo),
      r.spell,
      r.qr,
      r.meta,
      r.intra,
      r.full,
      r.documents,
      r.created,
    ]);
  }
  ws.columns.forEach((col) => {
    col.width = 16;
  });
  return wb;
}

/**
 * Build the "Forged Documents Observations" export: the same 10-column layout
 * as the upload sheet, with the Status column filled in (decisions #2/#3).
 */
export function buildObservationWorkbook(rows: ObservationExportRow[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Observations');
  ws.addRow([...OBSERVATION_HEADERS]);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      r.sNo,
      sanitizeCell(r.claimId),
      sanitizeCell(r.dealerName),
      sanitizeCell(r.dealerCode),
      sanitizeCell(r.invoiceDate),
      sanitizeCell(r.vinNo),
      sanitizeCell(r.customerName),
      sanitizeCell(r.schemeType),
      r.status,
      sanitizeCell(r.remarks),
    ]);
  }
  // Remarks can be multi-line forgery notes — keep them readable.
  ws.getColumn(10).alignment = { wrapText: true, vertical: 'top' };
  ws.columns.forEach((col, i) => {
    col.width = i === 9 ? 48 : i === 1 ? 20 : 16;
  });
  return wb;
}
