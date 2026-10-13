/** Regressions from the client QA summary report of 2026-10: QR points #35-38. */
import { docFieldGroups } from '../docFields.js';
import { compareQrToFields, panCarriesQr, qrForeignChassis } from '../qrCompare.js';
import { classifyQrOutcome } from '../qrValidator.js';

const valueOf = (fields: { label: string; value: string | null }[], label: string) =>
  fields.find((f) => f.label === label)?.value ?? null;
const POLICY = 'CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPeriod of Insurance\nPremium\n';

describe('client QA 2026-10 — QR', () => {
  it('#33 a current-design PAN with no readable QR is UNREADABLE, not NO_QR', () => {
    const base = { mismatches: 0, decodedValues: 0, scannableDocs: 1, opaquePayloads: 0, truncatedScans: 0 };
    expect(classifyQrOutcome({ ...base, missing: [{ data: { qrExpected: true } }] })).toBe('UNREADABLE');
    expect(classifyQrOutcome({ ...base, missing: [{ data: { qrExpected: false } }] })).toBe('NO_QR');
  });
  it('#36 "Policy No" over "Private Car" is not a policy number', () => {
    const [g] = docFieldGroups([`${POLICY}Policy No\nPrivate Car Package Policy`]);
    expect(valueOf(g.fields, 'Policy No')).toBeNull();
    const [real] = docFieldGroups([`${POLICY}Policy No. 3001/123456789/00/000`]);
    expect(valueOf(real.fields, 'Policy No')).toBe('3001/123456789/00/000');
  });
  it('#37/38 "Model : Company Fitted" is not a model', () => {
    const [g] = docFieldGroups([`${POLICY}Model : Company Fitted CNG`]);
    expect(valueOf(g.fields, 'Model') ?? '').not.toMatch(/company/i);
  });
  it('#35 an insurer QR keyed "Insured Name" is compared, and another name mismatches', () => {
    const cmp = compareQrToFields('Policy Number:3001123456,Insured Name:SURESH YADAV', [
      { label: "Insured's Name", value: 'RAM KUMAR' },
      { label: 'Policy No', value: '3001123456' },
    ] as never);
    expect(cmp.find((c) => /name/i.test(c.label))?.verdict).toBe('MISMATCH');
    expect(cmp.find((c) => /policy/i.test(c.label))?.verdict).toBe('MATCH');
  });
  it('#37/38 a QR keyed "Vehicle Model" is compared against the model', () => {
    const cmp = compareQrToFields('Vehicle Model:SONET', [{ label: 'Model', value: 'SONET HTK' }] as never);
    expect(cmp).toHaveLength(1);
  });
  // Value: protects=a NEW-car policy QR naming another chassis is flagged, and only that;
  // fails_when=the "New" registration gate, VIN shape or glyph-tolerant match is dropped;
  // why_new=the rule sat inline in qrValidator (Jimp), unreachable from Jest; seam=none;
  // no_claim=QR decoding itself
  it.each([
    ['Chassis No:MZBXX000000000001,Reg No:NEW', 'MZBEP812LSN100008', 'MZBXX000000000001'],
    ['Chassis No:MZBEP812LSN100008,Reg No:NEW', 'MZBEP812LSN100008', null],
    ['Chassis No:MZBEP8I2LSN100008,Reg No:New', 'MZBEP812LSN100008', null],
    ['Chassis No:MZBXX000000000001,Reg No:MH12AB1234', 'MZBEP812LSN100008', null],
    ['Chassis No:MZBXX000000000001,Reg No:NEW', 'CLM-1', null],
    ['Chassis No:MZBXX000000000001', 'MZBEP812LSN100008', null],
  ])('#35 QR %s vs claim %s → foreign chassis %s', (qr, claimId, expected) => {
    expect(qrForeignChassis(qr, claimId)).toBe(expected);
  });
  it('#33 only the current PAN design is expected to carry a QR', () => {
    expect(panCarriesQr('INCOME TAX DEPARTMENT Permanent Account Number Card ABCPK1234E')).toBe(true);
    expect(panCarriesQr('INCOME TAX DEPARTMENT Permanent Account Number ABCPK1234E')).toBe(false);
    expect(panCarriesQr('TAX INVOICE Invoice No 1')).toBe(false);
  });
});
