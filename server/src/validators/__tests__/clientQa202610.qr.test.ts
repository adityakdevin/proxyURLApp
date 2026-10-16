/** Regressions from the client QA summary report of 2026-10: QR points #35-38. */
import { docFieldGroups } from '../docFields.js';
import { compareQrToFields, panCarriesQr, qrForeignChassis } from '../qrCompare.js';
import { classifyQrOutcome, decodeQrImage, qrValidator } from '../qrValidator.js';

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
    expect(cmp[0].verdict).toBe('MATCH');
    const other = compareQrToFields('Vehicle Model:CRETA', [{ label: 'Model', value: 'SONET HTK' }] as never);
    expect(other[0]?.verdict).toBe('MISMATCH');
  });
  // Value: protects=a NEW-car policy QR naming another chassis is flagged, and only that;
  // fails_when=the "New" registration gate, VIN shape or glyph-tolerant match is dropped;
  // why_new=the rule sat inline in qrValidator (Jimp), unreachable from Jest; seam=none;
  // no_claim=QR decoding itself
  it.each([
    ['Chassis No:MZBXX000000000001,Reg No:NEW', 'MZBEP812LSN100008', 'MZBXX000000000001'],
    ['Chassis No:MZBEP812LSN100008,Reg No:NEW', 'MZBEP812LSN100008', null],
    ['Chassis No:MZBEP8I2LSN100008,Reg No:New', 'MZBEP812LSN100008', null],
    // The next car of the batch: one digit off in the serial is another vehicle.
    ['Chassis No:MZBEP812LSN100009,Reg No:NEW', 'MZBEP812LSN100008', 'MZBEP812LSN100009'],
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

// Value: protects=an image that cannot be opened is reported as such, not as "budget spent";
// fails_when=the read failure is folded into the retry-budget wording; seam=none (Jimp throws
// before zxing's dynamic import, so Jest reaches it)
it('an image that cannot be opened is marked unreadable, not retried', async () => {
  expect(await decodeQrImage('/nonexistent/qa-card.jpg', true)).toEqual({ hits: [], retried: false, tooLarge: false, unreadable: true });
});

// Value: protects=a real model is still read from a schedule's two-line Make/Model table, and
// a header after "Model :" is not; fails_when=the NOT_A_MODEL prefix check over-rejects or the
// header words are dropped from MODEL_RE (a header compared against the QR's model fails the
// check); why_new=only the 020440 rejection was tested; seam=none; no_claim=variant parsing
it('a real model is still read; a header after "Model :" is not', () => {
  const model = (text: string) => valueOf(docFieldGroups([`${POLICY}${text}`])[0].fields, 'Model');
  expect(model('Make Model Variant\nKIA SYROS SYROS D1.5 6MT')).toBe('SYROS');
  expect(model('Model : Chassis No MZBB1811LSN014084')).toBeNull();
  expect(model('Model - Fuel Type Petrol')).toBeNull();
});

// Value: protects=a column header under "Make - Model" is not read as the model and compared
// against the QR ("No.&chassis" on 020440); fails_when=modelFromRow stops rejecting label words;
// why_new=only "Company"/"Name"-style fragments were covered; seam=none; no_claim=reading the
// real model further down the table
it('a header fragment in the model cell is not a model (020440)', () => {
  const [g] = docFieldGroups([
    `${POLICY}Registration RTO Place Engine/Motor Make - Model Type Of Body\nNo. No.&chassis Type Of Fuel Manf.\nNEW - G3LCSM373438 TSYROS G1.0 SALOON`,
  ]);
  expect(valueOf(g.fields, 'Model')).toBeNull();
});

// Value: protects=a document whose card page says a QR is there but unreadable is not ALSO told
// "No QR code found" (026512), while an older PAN with no QR still is; fails_when=the document
// line is emitted regardless of its page misses; why_new=only classifyQrOutcome was tested, not
// the findings run() emits; seam=rasterizePdf and largestImageWidthPerPage use import(), which
// Jest cannot run, so both come back empty here; no_claim=the coarse-scan branches (a coarse
// Aadhaar suppressing the line, a coarse older PAN keeping it) — those need a real render
describe('"No QR code found" beside an unreadable QR (client QA 2026-10, 026512)', () => {
  const run = (pageText: string) =>
    qrValidator.run({
      claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
      documents: [{ id: 'd', fileName: 'c.pdf', storagePath: 'p', readablePath: '/nonexistent/c.pdf',
        mimeType: 'application/pdf', source: 'UPLOADED', documentTypeId: null }],
      prisma: {} as never,
      ocr: { extractImageText: async () => '' },
      shared: new Map([['d', pageText]]),
      wordBoxes: new Map(),
      pageTexts: new Map([['d', [pageText]]]),
    });
  it('a current-design PAN: no "No QR code found", summary says unreadable', async () => {
    const out = await run('INCOME TAX DEPARTMENT GOVT OF INDIA Permanent Account Number Card ABCPK1234E');
    expect(out.findings?.map((f) => f.message).join('\n')).not.toMatch(/No QR code found/);
    expect(out.summary).toMatch(/present but could not be read/);
  });
  it('an older PAN, which prints no QR: "No QR code found" stays', async () => {
    const out = await run('INCOME TAX DEPARTMENT GOVT OF INDIA Permanent Account Number ABCPK1234E');
    expect(out.findings?.some((f) => f.message === 'No QR code found in c.pdf.')).toBe(true);
    expect(out.summary).toMatch(/No QR code found/);
  });
});
