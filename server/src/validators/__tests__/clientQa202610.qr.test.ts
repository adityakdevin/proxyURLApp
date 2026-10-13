/** Regressions from the client QA summary report of 2026-10: QR points #35-38. */
import { docFieldGroups } from '../docFields.js';
import { compareQrToFields } from '../qrCompare.js';
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
});
