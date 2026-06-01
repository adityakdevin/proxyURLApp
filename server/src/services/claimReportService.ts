import ExcelJS from 'exceljs';
import { ExportRow } from './claimService.js';

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

export function buildClaimsWorkbook(rows: ExportRow[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Claims');
  ws.addRow(HEADERS);
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    ws.addRow([
      r.claimId,
      r.subCategory,
      r.category,
      r.workflowStatus,
      r.assignedTo,
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
