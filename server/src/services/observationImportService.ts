import ExcelJS from 'exceljs';
import { ParsedObservationRow } from './observationSheet.js';

/** Hard cap on rows a single upload may carry (abuse / runaway guard). */
export const MAX_IMPORT_ROWS = 5000;

export interface ParseError {
  /** 1-based worksheet row, or 0 for file/header-level problems. */
  rowNumber: number;
  message: string;
}

export interface ParseResult {
  rows: ParsedObservationRow[];
  errors: ParseError[];
}

export class ObservationParseError extends Error {
  constructor(
    public code: string,
    message: string
  ) {
    super(message);
  }
}

/** Normalise a header for tolerant matching: "VIN No." -> "vinno". */
const normalize = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Maps a normalised header to the ParsedObservationRow field it fills. The
 *  S.No and Status columns are deliberately absent (regenerated / derived). */
const FIELD_BY_HEADER: Record<string, keyof Omit<ParsedObservationRow, 'rowNumber'>> = {
  claimid: 'claimId',
  dealername: 'dealerName',
  dealercode: 'dealerCode',
  invoicedate: 'invoiceDate',
  vinno: 'vinNo',
  customername: 'customerName',
  schemetype: 'schemeType',
  remarks: 'remarks',
};

/** Read a cell's value as trimmed text, tolerating rich-text / hyperlink /
 *  formula cell shapes. Empty / whitespace-only -> null. */
function cellText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.trim() || null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text.trim() || null; // hyperlink
    if (Array.isArray(v.richText)) {
      return (
        v.richText
          .map((r) => (r as { text?: string }).text ?? '')
          .join('')
          .trim() || null
      );
    }
    if ('result' in v) return cellText(v.result as ExcelJS.CellValue); // formula
  }
  return null;
}

/** Largest plausible Excel serial date (~9999-12-31); guards against garbage numerics. */
const MAX_EXCEL_SERIAL = 2958465;

/** Coerce a cell into a Date, handling native dates, Excel serials, strings,
 *  formula results, and rich-text / hyperlink shapes (consistent with cellText). */
function cellDate(value: ExcelJS.CellValue): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'number') {
    // Excel serial date -> JS Date (1900 date system, day 25569 == 1970-01-01).
    // Reject absurd serials so a stray large number isn't read as a year-275760 date.
    if (value < 1 || value > MAX_EXCEL_SERIAL) return null;
    const ms = Math.round((value - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'string') {
    const d = new Date(value.trim());
    return isNaN(d.getTime()) ? null : d;
  }
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>;
    if ('result' in v) return cellDate(v.result as ExcelJS.CellValue);
    // Rich-text / hyperlink cells: reuse the text extraction, then parse the string.
    const asText = cellText(value);
    return asText ? cellDate(asText) : null;
  }
  return null;
}

/**
 * Parse an uploaded .xlsx buffer into observation rows. Throws
 * ObservationParseError for file/structure problems; per-row issues are
 * collected into `errors` so one bad row never sinks the whole upload.
 */
export async function parseObservationWorkbook(buffer: Buffer): Promise<ParseResult> {
  // .xlsx is a ZIP container — reject anything without the "PK\x03\x04" signature
  // up front (magic bytes, not just the filename extension).
  if (
    buffer.length < 4 ||
    buffer[0] !== 0x50 ||
    buffer[1] !== 0x4b ||
    buffer[2] !== 0x03 ||
    buffer[3] !== 0x04
  ) {
    throw new ObservationParseError('UNREADABLE_FILE', 'The file is not a valid .xlsx workbook');
  }

  const wb = new ExcelJS.Workbook();
  try {
    // Cast to load()'s own declared param type: @types/node's generic
    // Buffer<ArrayBufferLike> doesn't line up with exceljs's non-generic Buffer,
    // though the value is a valid Buffer at runtime.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new ObservationParseError('UNREADABLE_FILE', 'The file could not be read as an .xlsx workbook');
  }

  const ws = wb.worksheets[0];
  if (!ws || ws.rowCount < 2) {
    throw new ObservationParseError('EMPTY_SHEET', 'The first worksheet has no data rows');
  }

  // Map each recognised header to its column index (tolerates reordering).
  const colByField = new Map<keyof ParsedObservationRow, number>();
  const headerRow = ws.getRow(1);
  headerRow.eachCell((cell, col) => {
    const text = cellText(cell.value);
    if (!text) return;
    const field = FIELD_BY_HEADER[normalize(text)];
    if (field && !colByField.has(field)) colByField.set(field, col);
  });

  const claimIdCol = colByField.get('claimId');
  if (!claimIdCol) {
    throw new ObservationParseError(
      'MISSING_CLAIM_ID_COLUMN',
      'No "Claim ID" column was found in the header row'
    );
  }

  // The remaining data columns must also be present (claimId is checked above),
  // otherwise a mistyped/omitted header would silently drop that field to null
  // for every row.
  const EXPECTED_FIELDS: (keyof ParsedObservationRow)[] = [
    'dealerName',
    'dealerCode',
    'invoiceDate',
    'vinNo',
    'customerName',
    'schemeType',
    'remarks',
  ];
  const missing = EXPECTED_FIELDS.filter((f) => !colByField.has(f));
  if (missing.length > 0) {
    throw new ObservationParseError(
      'MISSING_COLUMNS',
      `Missing expected column(s): ${missing.join(', ')}`
    );
  }

  const rows: ParsedObservationRow[] = [];
  const errors: ParseError[] = [];
  // Stable list of mapped column indices, reused for the blank-row check below.
  const mappedCols = [...colByField.values()];
  const text = (r: ExcelJS.Row, field: keyof ParsedObservationRow): string | null => {
    const col = colByField.get(field);
    return col ? cellText(r.getCell(col).value) : null;
  };

  // Bound the scan by total worksheet rows as well, so a flood of blank rows
  // can't sneak past the per-claim MAX_IMPORT_ROWS cap.
  const lastRow = Math.min(ws.rowCount, MAX_IMPORT_ROWS + 1);
  if (ws.rowCount > MAX_IMPORT_ROWS + 1) {
    errors.push({
      rowNumber: 0,
      message: `Sheet has more than ${MAX_IMPORT_ROWS} rows; only the first ${MAX_IMPORT_ROWS} were read`,
    });
  }

  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber++) {
    const row = ws.getRow(rowNumber);
    const claimId = cellText(row.getCell(claimIdCol).value);
    // Skip fully-blank trailing rows silently; flag rows that have data but no Claim ID.
    if (!claimId) {
      const hasAnyData = mappedCols.some((c) => cellText(row.getCell(c).value));
      if (hasAnyData) errors.push({ rowNumber, message: 'Missing Claim ID' });
      continue;
    }
    const invoiceCol = colByField.get('invoiceDate');
    rows.push({
      rowNumber,
      claimId,
      dealerName: text(row, 'dealerName'),
      dealerCode: text(row, 'dealerCode'),
      invoiceDate: invoiceCol ? cellDate(row.getCell(invoiceCol).value) : null,
      vinNo: text(row, 'vinNo'),
      customerName: text(row, 'customerName'),
      schemeType: text(row, 'schemeType'),
      remarks: text(row, 'remarks'),
    });
  }

  return { rows, errors };
}
