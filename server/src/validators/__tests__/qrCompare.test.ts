import { compareQrToFields, parseQrPayload } from '../qrCompare.js';
import { DocField } from '../docFields.js';

// The real QR payload decoded from docs/samples/spelling-checks/MZBB2814LSN010383.pdf.
const POLICY_QR =
  'Name:MR. RAVI  SHANKAR|Pol.No.:OG-26-1021-1825-00036132|Model:SYROS|Reg.No:New|' +
  'ChassisNo.:MZBB2814LSN010383|OD period27 Oct 2025  1:00PM-26 Oct 2026 11:59PM|' +
  'CPA Period:27 Oct 2025  1:00PM-26 Oct 2028 11:59PM|URL:http://x.example/a?b=c==';

// What the OCR actually reads off that same page — note the misread glyphs in the chassis
// (MZBB2SIALSNO10383) and the leading 0-for-O in the policy number.
const PANE: DocField[] = [
  { label: 'Policy No', value: '0G-26-1021-1825-00036132' },
  { label: "Insured's Name", value: 'RAVI SHANKAR' },
  { label: 'Chassis No', value: 'MZBB2SIALSNO10383' },
  { label: 'Engine No', value: 'DAFASM359948' },
  { label: 'Model', value: 'SYROS' },
];

const verdictFor = (cmp: ReturnType<typeof compareQrToFields>, label: string) =>
  cmp.find((c) => c.label === label)?.verdict;

describe('QR payload parsing', () => {
  it('splits pipe-delimited Label:Value pairs without breaking on time colons', () => {
    const p = parseQrPayload(POLICY_QR);
    expect(p.get('name')).toBe('MR. RAVI  SHANKAR');
    expect(p.get('polno')).toBe('OG-26-1021-1825-00036132');
    expect(p.get('chassisno')).toBe('MZBB2814LSN010383');
    expect(p.get('cpaperiod')).toBe('27 Oct 2025  1:00PM-26 Oct 2028 11:59PM');
  });

  it('reads the older Aadhaar XML QR attributes', () => {
    const p = parseQrPayload('<PrintLetterBarcodeData uid="466552210629" name="Ravi Shankar" gender="M"/>');
    expect(p.get('uid')).toBe('466552210629');
    expect(p.get('name')).toBe('Ravi Shankar');
  });

  it('compares nothing for an encrypted Secure QR blob', () => {
    expect(parseQrPayload('binary:AAECAwQ=').size).toBe(0);
    expect(compareQrToFields('binary:AAECAwQ=', PANE)).toEqual([]);
  });
});

describe('QR vs document comparison', () => {
  it('passes a genuine claim despite OCR glyph noise in the printed values', () => {
    const cmp = compareQrToFields(POLICY_QR, PANE);
    expect(verdictFor(cmp, 'Policy No')).toBe('MATCH'); // 0G vs OG
    expect(verdictFor(cmp, 'Chassis No')).toBe('MATCH'); // MZBB2SIALSNO10383 vs MZBB2814LSN010383
    expect(verdictFor(cmp, "Insured's Name")).toBe('MATCH'); // "MR. RAVI  SHANKAR" vs "RAVI SHANKAR"
    expect(verdictFor(cmp, 'Model')).toBe('MATCH');
    expect(cmp.every((c) => c.verdict === 'MATCH')).toBe(true);
  });

  it('flags a substituted chassis number', () => {
    const tampered = POLICY_QR.replace('MZBB2814LSN010383', 'MZBF9911LSN778821');
    expect(verdictFor(compareQrToFields(tampered, PANE), 'Chassis No')).toBe('MISMATCH');
  });

  it('flags a different insured name', () => {
    const tampered = POLICY_QR.replace('MR. RAVI  SHANKAR', 'SURESH KUMAR');
    expect(verdictFor(compareQrToFields(tampered, PANE), "Insured's Name")).toBe('MISMATCH');
  });

  it('only compares fields present on both sides', () => {
    const labels = compareQrToFields(POLICY_QR, PANE).map((c) => c.label);
    expect(labels).not.toContain('Engine No'); // the QR carries no engine number
    expect(labels).toEqual(expect.arrayContaining(['Policy No', 'Chassis No', 'Model']));
    // A pane row the QR is silent about is never reported as a mismatch.
    expect(compareQrToFields('Model:SYROS', PANE).map((c) => c.label)).toEqual(['Model']);
  });

  it('does not compare a policy QR against another document type', () => {
    const aadhaarPane: DocField[] = [
      { label: 'Aadhaar Number', value: '4665 5221 0629' },
      { label: 'Holder Name', value: 'Ravi Shankar' },
    ];
    // "Name" still lines up, but the policy number has no row here — no false mismatch.
    const labels = compareQrToFields(POLICY_QR, aadhaarPane).map((c) => c.label);
    expect(labels).toEqual(['Holder Name']);
  });
});
