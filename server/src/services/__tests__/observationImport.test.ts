import ExcelJS from 'exceljs';
import {
  parseObservationWorkbook,
  ObservationParseError,
} from '../observationImportService.js';
import { OBSERVATION_HEADERS } from '../observationSheet.js';

/** Build an .xlsx buffer from a header row + data rows. */
async function makeBuffer(headers: unknown[], rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(headers);
  rows.forEach((r) => ws.addRow(r));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const FULL_ROW = [
  1,
  'MZBFB812LSN538764',
  'I.P. Developers Private Limited',
  'UP308',
  new Date('2025-08-30'),
  'MZBFB812LSN538764',
  'SUDARSHAN CHAUHAN',
  'Corporate',
  '', // Status (blank on upload)
  'Uploaded Salary slips are invalid',
];

describe('parseObservationWorkbook', () => {
  it('parses rows, dropping S.No/Status and keeping business fields', async () => {
    const buf = await makeBuffer([...OBSERVATION_HEADERS], [FULL_ROW]);
    const { rows, errors } = await parseObservationWorkbook(buf);
    expect(errors).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rowNumber: 2,
      claimId: 'MZBFB812LSN538764',
      dealerName: 'I.P. Developers Private Limited',
      dealerCode: 'UP308',
      vinNo: 'MZBFB812LSN538764',
      customerName: 'SUDARSHAN CHAUHAN',
      schemeType: 'Corporate',
      remarks: 'Uploaded Salary slips are invalid',
    });
    expect(rows[0].invoiceDate?.toISOString().slice(0, 10)).toBe('2025-08-30');
  });

  it('trims whitespace and tolerates reordered columns', async () => {
    // All expected columns present, but in a shuffled order.
    const headers = [
      'Remarks',
      'Claim ID',
      'Scheme Type',
      'Customer Name',
      'VIN No.',
      'Invoice Date',
      'Dealer Code',
      'Dealer Name',
    ];
    const buf = await makeBuffer(headers, [
      ['note', '  ABC-1  ', 'Corporate', 'Jane', 'VIN1', null, 'DC1', 'Dealer Z'],
    ]);
    const { rows } = await parseObservationWorkbook(buf);
    expect(rows[0]).toMatchObject({
      claimId: 'ABC-1',
      remarks: 'note',
      customerName: 'Jane',
      schemeType: 'Corporate',
      vinNo: 'VIN1',
      dealerCode: 'DC1',
      dealerName: 'Dealer Z',
    });
  });

  it('throws when an expected data column is missing (no silent data loss)', async () => {
    const headers = [...OBSERVATION_HEADERS].filter((h) => h !== 'Scheme Type');
    const buf = await makeBuffer(headers, [
      [1, 'ABC-1', 'D', 'DC', null, 'V', 'Cust', '', 'note'],
    ]);
    await expect(parseObservationWorkbook(buf)).rejects.toMatchObject({ code: 'MISSING_COLUMNS' });
  });

  it('flags a data row that is missing a Claim ID, but skips fully-blank rows', async () => {
    const buf = await makeBuffer(
      [...OBSERVATION_HEADERS],
      [
        FULL_ROW,
        [2, '', 'Dealer X', '', null, '', '', '', '', 'orphan remark'],
        [3, '', '', '', null, '', '', '', '', ''], // fully blank -> skipped silently
      ]
    );
    const { rows, errors } = await parseObservationWorkbook(buf);
    expect(rows).toHaveLength(1);
    expect(errors).toEqual([{ rowNumber: 3, message: 'Missing Claim ID' }]);
  });

  it('throws when no Claim ID column exists', async () => {
    const buf = await makeBuffer(['Dealer Name', 'Remarks'], [['x', 'y']]);
    await expect(parseObservationWorkbook(buf)).rejects.toBeInstanceOf(ObservationParseError);
  });

  it('throws on an unreadable / non-xlsx buffer', async () => {
    await expect(parseObservationWorkbook(Buffer.from('not a spreadsheet'))).rejects.toBeInstanceOf(
      ObservationParseError
    );
  });
});
