import ExcelJS from 'exceljs';
import { OBSERVATION_HEADERS } from '../../../services/observationSheet.js';

/**
 * Build a "Forged Documents Observations" .xlsx buffer with the canonical
 * 10-column header and the given data rows. Mirrors the proven fixture pattern
 * in observationImport.test.ts so the import parser accepts it.
 *
 * Each data row is an array aligned to OBSERVATION_HEADERS:
 *   [S.No, Claim ID, Dealer Name, Dealer Code, Invoice Date, VIN No.,
 *    Customer Name, Scheme Type, Status, Remarks]
 */
export async function buildObservationBuffer(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow([...OBSERVATION_HEADERS]);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Parse an .xlsx buffer (e.g. an export response body) into a 2-D cell array. */
export async function readWorkbook(buf: Buffer): Promise<string[][]> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS types predate @types/node's generic Buffer<ArrayBufferLike>; cast.
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  const grid: string[][] = [];
  ws.eachRow((row) => {
    const cells: string[] = [];
    // ExcelJS values are 1-indexed with a leading undefined at [0].
    (row.values as unknown[]).slice(1).forEach((v) => cells.push(v == null ? '' : String(v)));
    grid.push(cells);
  });
  return grid;
}
