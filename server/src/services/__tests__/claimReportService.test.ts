import { buildClaimsWorkbook, buildObservationWorkbook } from '../claimReportService.js';
import { ExportRow } from '../claimService.js';
import { ObservationExportRow } from '../observationSheet.js';

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

const obsRow: ObservationExportRow = {
  sNo: 1,
  claimId: 'MZBFB812LSN538764',
  dealerName: 'I.P. Developers Private Limited',
  dealerCode: 'UP308',
  invoiceDate: '2025-08-30',
  vinNo: 'MZBFB812LSN538764',
  customerName: 'SUDARSHAN CHAUHAN',
  schemeType: 'Corporate',
  status: 'Forged',
  remarks: 'Uploaded Salary slips are invalid',
  checks: {
    spellCheckStatus: 'FAILED',
    qrStatus: 'PASSED',
    metaExtractionStatus: 'PASSED',
    intraClaimStatus: 'PASSED',
    fullScanStatus: 'FAILED',
  },
};

describe('buildObservationWorkbook', () => {
  it('appends the failure summary and the five check outcomes after the upload columns', () => {
    // The export exists to tell a reviewer WHICH check condemned a claim. Status alone only
    // says "Forged". The extra columns come AFTER the 10 upload columns so an exported file
    // can be re-uploaded unchanged — the importer reads S. No..Remarks by position.
    const ws = buildObservationWorkbook([obsRow]).getWorksheet('Observations')!;
    expect(ws.getRow(1).getCell(11).value).toBe('Failed Checks');
    expect(ws.getRow(1).getCell(12).value).toBe('Spell Check');
    expect(ws.getRow(1).getCell(16).value).toBe('Full Scan');
    expect(ws.getRow(2).getCell(11).value).toBe('Spell Check, Full Scan');
    expect(ws.getRow(2).getCell(12).value).toBe('FAILED');
    expect(ws.getRow(2).getCell(13).value).toBe('PASSED');
    expect(ws.getRow(2).getCell(16).value).toBe('FAILED');
  });

  it('leaves the failure summary empty when nothing failed', () => {
    const clean: ObservationExportRow = {
      ...obsRow,
      status: 'OK',
      checks: {
        spellCheckStatus: 'PASSED',
        qrStatus: 'PASSED',
        metaExtractionStatus: 'PASSED',
        intraClaimStatus: 'DOUBTFUL',
        fullScanStatus: 'PASSED',
      },
    };
    const ws = buildObservationWorkbook([clean]).getWorksheet('Observations')!;
    // DOUBTFUL is not a failure — it is shown in its own column, not summarised as one.
    expect(ws.getRow(2).getCell(11).value).toBe('');
    expect(ws.getRow(2).getCell(15).value).toBe('DOUBTFUL');
  });

  it('writes the 10-column observation layout with Status filled', () => {
    const ws = buildObservationWorkbook([obsRow]).getWorksheet('Observations')!;
    expect(ws.getRow(1).getCell(1).value).toBe('S. No');
    expect(ws.getRow(1).getCell(2).value).toBe('Claim ID');
    expect(ws.getRow(1).getCell(9).value).toBe('Status');
    expect(ws.getRow(1).getCell(10).value).toBe('Remarks');
    expect(ws.getRow(2).getCell(1).value).toBe(1);
    expect(ws.getRow(2).getCell(2).value).toBe('MZBFB812LSN538764');
    expect(ws.getRow(2).getCell(9).value).toBe('Forged');
  });

  it('handles an empty row set (header only)', () => {
    const ws = buildObservationWorkbook([]).getWorksheet('Observations')!;
    expect(ws.rowCount).toBe(1);
  });

  it('neutralises formula-injection in user-supplied cells', () => {
    const malicious: ObservationExportRow = {
      ...obsRow,
      dealerName: '=cmd|"/c calc"!A1',
      remarks: '+SUM(1,2)',
    };
    const ws = buildObservationWorkbook([malicious]).getWorksheet('Observations')!;
    expect(ws.getRow(2).getCell(3).value).toBe(`'=cmd|"/c calc"!A1`);
    expect(ws.getRow(2).getCell(10).value).toBe(`'+SUM(1,2)`);
  });
});
