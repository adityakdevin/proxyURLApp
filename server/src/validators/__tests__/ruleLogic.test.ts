import { evaluateRule, validOperatorsFor, ClaimFacts } from '../ruleLogic.js';

const facts: ClaimFacts = {
  documentCount: 3,
  remarkCount: 1,
  assigned: true,
  presentDocTypeNames: ['Aadhar Card', 'PAN Card'],
  workflowStatusName: 'Pending',
  spellCheckStatus: 'PASSED',
  qrStatus: 'FAILED',
  metaExtractionStatus: 'PASSED',
  intraClaimStatus: 'PASSED',
  fullScanStatus: 'PASSED',
};

describe('ruleLogic', () => {
  it('validOperatorsFor', () => {
    expect(validOperatorsFor('DOCUMENT_COUNT')).toContain('GTE');
    expect(validOperatorsFor('QR_STATUS')).toEqual(['EQ', 'NEQ']);
  });
  it('numeric comparisons', () => {
    expect(evaluateRule({ field: 'DOCUMENT_COUNT', operator: 'GTE', value: '3' }, facts)).toEqual({ passed: true, actual: '3' });
    expect(evaluateRule({ field: 'DOCUMENT_COUNT', operator: 'GT', value: '3' }, facts).passed).toBe(false);
    expect(evaluateRule({ field: 'REMARK_COUNT', operator: 'EQ', value: '1' }, facts).passed).toBe(true);
  });
  it('enum/status EQ/NEQ', () => {
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'EQ', value: 'PASSED' }, facts).passed).toBe(false);
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'NEQ', value: 'PASSED' }, facts).passed).toBe(true);
    expect(evaluateRule({ field: 'WORKFLOW_STATUS', operator: 'EQ', value: 'Pending' }, facts).passed).toBe(true);
  });
  it('HAS_DOCUMENT_TYPE presence', () => {
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Aadhar Card' }, facts)).toEqual({ passed: true, actual: 'present' });
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Bill' }, facts)).toEqual({ passed: false, actual: 'absent' });
    expect(evaluateRule({ field: 'HAS_DOCUMENT_TYPE', operator: 'NEQ', value: 'Bill' }, facts).passed).toBe(true);
  });
  it('ASSIGNED boolean', () => {
    expect(evaluateRule({ field: 'ASSIGNED', operator: 'EQ', value: 'true' }, facts).passed).toBe(true);
    expect(evaluateRule({ field: 'ASSIGNED', operator: 'EQ', value: 'false' }, facts).passed).toBe(false);
  });
  it('numeric operator on non-numeric field is false', () => {
    expect(evaluateRule({ field: 'QR_STATUS', operator: 'GTE', value: 'PASSED' }, facts).passed).toBe(false);
  });
  it('validation status compares on the binary PASSED/FAILED collapse', () => {
    // Everything except a literal FAILED reads as PASSED, matching the report.
    for (const s of ['PASSED', 'PENDING', 'IN_PROGRESS', 'DOCS_NOT_AVAILABLE']) {
      expect(evaluateRule({ field: 'SPELL_STATUS', operator: 'EQ', value: 'PASSED' }, { ...facts, spellCheckStatus: s })).toEqual({ passed: true, actual: 'PASSED' });
    }
    // Only a literal FAILED fails "= PASSED".
    expect(evaluateRule({ field: 'SPELL_STATUS', operator: 'EQ', value: 'PASSED' }, { ...facts, spellCheckStatus: 'FAILED' })).toEqual({ passed: false, actual: 'FAILED' });
  });
});
