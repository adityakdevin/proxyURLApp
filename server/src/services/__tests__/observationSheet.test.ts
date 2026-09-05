import { deriveForgeryStatus, ValidationStatuses } from '../observationSheet.js';

const base: ValidationStatuses = {
  spellCheckStatus: 'PASSED',
  qrStatus: 'PASSED',
  metaExtractionStatus: 'PASSED',
  intraClaimStatus: 'PASSED',
  fullScanStatus: 'PASSED',
  redFlagStatus: 'PASSED',
  duplicateStatus: 'PASSED',
};

describe('deriveForgeryStatus', () => {
  it("returns 'OK' when every check passed", () => {
    expect(deriveForgeryStatus(base)).toBe('OK');
  });

  it("returns 'Forged' when any check failed (failure wins over pending)", () => {
    expect(deriveForgeryStatus({ ...base, qrStatus: 'FAILED' })).toBe('Forged');
    expect(
      deriveForgeryStatus({ ...base, spellCheckStatus: 'PENDING', fullScanStatus: 'FAILED' })
    ).toBe('Forged');
  });

  it("returns 'OK' for any non-FAILED state (binary model — no more 'Pending')", () => {
    expect(deriveForgeryStatus({ ...base, metaExtractionStatus: 'PENDING' })).toBe('OK');
    expect(deriveForgeryStatus({ ...base, intraClaimStatus: 'IN_PROGRESS' })).toBe('OK');
    expect(deriveForgeryStatus({ ...base, fullScanStatus: 'DOCS_NOT_AVAILABLE' })).toBe('OK');
  });
});
