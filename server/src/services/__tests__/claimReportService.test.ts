import { buildClaimsWorkbook } from '../claimReportService.js';
import { ExportRow } from '../claimService.js';

const row: ExportRow = {
  claimId: 'EX-1',
  subCategory: 'RC',
  category: 'Cat',
  workflowStatus: 'Pending',
  assignedTo: 'Unassigned',
  spell: 'PASSED',
  qr: 'FAILED',
  meta: 'PASSED',
  intra: 'PENDING',
  full: 'PASSED',
  documents: 2,
  created: '2026-05-31',
};

describe('buildClaimsWorkbook', () => {
  it('creates a Claims sheet with a header row and data rows', () => {
    const wb = buildClaimsWorkbook([row]);
    const ws = wb.getWorksheet('Claims')!;
    expect(ws.getRow(1).getCell(1).value).toBe('Claim ID');
    expect(ws.getRow(1).getCell(11).value).toBe('Documents');
    expect(ws.getRow(2).getCell(1).value).toBe('EX-1');
    expect(ws.getRow(2).getCell(4).value).toBe('Pending');
    expect(ws.getRow(2).getCell(11).value).toBe(2);
    expect(ws.getRow(2).getCell(12).value).toBe('2026-05-31');
  });
  it('handles an empty row set (header only)', () => {
    const ws = buildClaimsWorkbook([]).getWorksheet('Claims')!;
    expect(ws.rowCount).toBe(1);
  });
});
