import { compareValidator } from '../compareValidator.js';
import { ValidatorDoc } from '../types.js';

const doc = (id: string): ValidatorDoc => ({
  id,
  fileName: `${id}.pdf`,
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png',
  source: 'UPLOADED',
  documentTypeId: null,
});
const box = (text: string, x: number) => ({ text, page: 1, bbox: { x, y: 0.5, w: 0.05, h: 0.02 } });

describe('compareValidator findings', () => {
  it('boxes the disagreeing value so the finding row can zoom to it', async () => {
    const invoice = 'TAX INVOICE Invoice No 1\nChassis No: MAT1234567890';
    const policy = 'Policy No 9 Insured X Premium 1 Sum Insured 2\nChassis Number: MAT9999999999';
    const outcome = await compareValidator.run({
      claim: { id: 'c1', claimId: 'CLM1', subCategoryId: 's1' },
      documents: [doc('d1'), doc('d2')],
      prisma: {} as never,
      ocr: {} as never,
      shared: new Map([['d1', invoice], ['d2', policy]]),
      pageTexts: new Map([['d1', [invoice]], ['d2', [policy]]]),
      wordBoxes: new Map([
        ['d1', [box('Chassis', 0.1), box('No:', 0.2), box('MAT1234567890', 0.3)]],
        ['d2', [box('Chassis', 0.1), box('Number:', 0.2), box('MAT9999999999', 0.6)]],
      ]),
    });
    const f = outcome.findings!.find((x) => x.code === 'CROSS_CHASSIS_MISMATCH')!;
    expect(f.page).toBe(1);
    // Around the outlier's own value, on its own document — not its label.
    const onDoc = f.documentId === 'd1' ? 0.3 : 0.6;
    expect(f.bbox).toEqual({ x: onDoc, y: 0.5, w: expect.closeTo(0.05, 5), h: expect.closeTo(0.02, 5) });
  });
  it('fails Data Compare when an old car policy is for another vehicle', async () => {
    const rc = 'CERTIFICATE GK ReGYTRALON 277\n2. Vehicle Class Motor Cab\n3. Registered Owner ACME\nOwnership Type CMPY\n12. Chassis Number MATBS53007RLH00222';
    const policy =
      "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000001\nInsured's Name : MR. RAVI KUMAR\nChassis No.\nNew MEDCHAL MZBGBSI4LTNI0444 G4FLTV300001 1497";
    const outcome = await compareValidator.run({
      claim: { id: 'c1', claimId: 'MZBGD81AUTN000111', subCategoryId: 's1' },
      documents: [doc('d1'), doc('d2')],
      prisma: {} as never,
      ocr: {} as never,
      shared: new Map([['d1', rc], ['d2', policy]]),
      pageTexts: new Map([['d1', [rc]], ['d2', [policy]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.findings!.some((f) => f.code === 'CROSS_OLD_CAR_CHASSIS_MISMATCH')).toBe(true);
  });

  it('compares the GST certificate with the invoice GSTIN', async () => {
    const inv = 'TAX INVOICE\nInvoice No: INV-1\nDealer GSTIN: 27PQRSX5678K1ZY\nBuyer GSTIN: 23ABCDE1234F1Z8';
    const cert = 'Form GST REG-06\nRegistration Certificate\nRegistration Number : 23ABCDE1234F1Z\nLegal Name : ABC TRADERS';
    const outcome = await compareValidator.run({
      claim: { id: 'c1', claimId: 'CLM1', subCategoryId: 's1' },
      documents: [doc('d1')],
      prisma: {} as never,
      ocr: {} as never,
      shared: new Map([['d1', `${inv}\n${cert}`]]),
      pageTexts: new Map([['d1', [inv, cert]]]),
      wordBoxes: new Map(),
    });
    expect(outcome.status).toBe('FAILED');
    expect(outcome.findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CROSS_GSTIN_MISMATCH', documentId: 'd1', page: 2 })])
    );
  });

  describe('holder names and new-car policies (client sheet 2026-10-31)', () => {
    const VIN = 'MZBGD81AUTN000111';
    const DMS = 'ANIL KUMAR SHARMA';
    const INVOICE = 'TAX INVOICE\nInvoice No: INV-1\nHypothecation\nCustomer Name: ANIL KUMAR SHARMA\nChassis No: MZBGD81AUTN000111\nTotal Amount 1500000';
    const STAFF_NAME_P = 'ACME PUBLIC SCHOOL\nIdentity Card\n| Name P KIRAN VARMA\nDesignation TEACHER\nEmployee ID: E1234';
    const NEW_POLICY_OWN = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000003\nInsured's Name : MR. ANIL KUMAR SHARMA\nRegistration No. New Chassis No. MZBGD81AUTN000111 Engine No. G4FLTV300002";
    const NEW_POLICY_OTHER = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000002\nInsured's Name : MR. RAVI KUMAR\nRegistration No. New Chassis No. MZBGB814LTN310444 Engine No. G4FLTV300001";
    const PAYSLIP = 'ACME INDUSTRIES LIMITED\nPAY SLIP FOR THE MONTH OF MAY 2026\nSri / Smt: KIRAN .\nVARMA\nEmployee Code E1234\nBasic Pay 30000\nNet Pay 28000\nGross Earnings 31000';
    const FAMILY_RC = 'Registration Certificate\nRegistered Owner: SITA DEVI\nOwnership Type INDIVIDUAL\nChassis No: MZBGB813LSN200777';
    const FAMILY_POLICY = 'Policy No 1\nInsured Name: X\nChassis No.\nMZBGB813LSN200777';

    // One page per document, so the page number is always 1 and the document id tells pages apart.
    const run = (pages: string[], customerName: string | null = DMS, claimId = VIN) =>
      compareValidator.run({
        claim: { id: 'c1', claimId, subCategoryId: 's1', customerName },
        documents: pages.map((_, i) => doc(`d${i + 1}`)),
        prisma: {} as never,
        ocr: {} as never,
        shared: new Map(pages.map((t, i) => [`d${i + 1}`, t])),
        pageTexts: new Map(pages.map((t, i) => [`d${i + 1}`, [t]])),
        wordBoxes: new Map(),
      });
    const on = (o: Awaited<ReturnType<typeof run>>, code: string, documentId: string) =>
      o.findings!.filter((f) => f.code === code && f.documentId === documentId);

    it('row 30: a staff ID in another name fails Data Compare', async () => {
      const o = await run([INVOICE, STAFF_NAME_P]);
      expect(o.status).toBe('FAILED');
      expect(on(o, 'CROSS_HOLDER_NAME_MISMATCH', 'd2')).toHaveLength(1);
    });

    it('row 31: a payslip gets the holder finding and no second name line', async () => {
      const o = await run([INVOICE, NEW_POLICY_OWN, PAYSLIP]);
      expect(on(o, 'CROSS_HOLDER_NAME_MISMATCH', 'd3')).toHaveLength(1);
      expect(on(o, 'CROSS_NAME_MISMATCH', 'd3')).toHaveLength(0);
    });

    it("row 32: another car's new policy is flagged once, without the set-aside note", async () => {
      const o = await run([INVOICE, NEW_POLICY_OWN, NEW_POLICY_OTHER]);
      expect(on(o, 'CROSS_POLICY_OTHER_VEHICLE', 'd3')).toHaveLength(1);
      expect(on(o, 'CROSS_HOLDER_NAME_MISMATCH', 'd3')).toHaveLength(1);
      expect(on(o, 'CROSS_OTHER_VEHICLE', 'd3')).toHaveLength(0);
    });

    it('M2: another car\'s policy with a labelled chassis gets one chassis line, not two', async () => {
      const o = await run([INVOICE, NEW_POLICY_OTHER.replace('Chassis No.', 'Chassis No:')]);
      expect(on(o, 'CROSS_POLICY_OTHER_VEHICLE', 'd2')).toHaveLength(1);
      expect(on(o, 'CROSS_CHASSIS_MISMATCH', 'd2')).toHaveLength(0);
    });

    it('M3: a holder-flagged policy whose VIN is unlabelled gets no set-aside note', async () => {
      const unlabelled = NEW_POLICY_OTHER.replace('Chassis No. MZBGB814LTN310444', 'VIN MZBGB814LTN310444');
      const o = await run([INVOICE, NEW_POLICY_OWN, unlabelled]);
      expect(on(o, 'CROSS_HOLDER_NAME_MISMATCH', 'd3')).toHaveLength(1);
      expect(on(o, 'CROSS_OTHER_VEHICLE', 'd3')).toHaveLength(0);
    });

    it('M6: a P1 old-car chassis page does not also get the set-aside note', async () => {
      const oldRc = 'Registration Certificate\nOwner Name\nRAVI KUMAR\nOwnership Type INDIVIDUAL\nChassis No: MA3EWDE1S00000777';
      const o = await run([INVOICE, NEW_POLICY_OWN, oldRc, "CERTIFICATE OF INSURANCE\nPolicy No. D000000004\nInsured's Name : MR. RAVI KUMAR\nRegistration No. TS09AB1234 Chassis No. MA3EWDE1S00000999"]);
      expect(on(o, 'CROSS_OLD_CAR_CHASSIS_MISMATCH', 'd4').length).toBeGreaterThan(0);
      expect(on(o, 'CROSS_OTHER_VEHICLE', 'd4')).toHaveLength(0);
    });

    it('F16: the other-vehicle note says it is not a mismatch and still names the VIN', async () => {
      const o = await run([INVOICE, NEW_POLICY_OWN, FAMILY_RC, FAMILY_POLICY]);
      const notes = o.findings!.filter((f) => f.code === 'CROSS_OTHER_VEHICLE');
      expect(notes.length).toBeGreaterThan(0);
      expect(notes[0].message).toContain('not a mismatch');
      expect(notes[0].message).toContain('MZBGB813LSN200777');
    });
  });
});
