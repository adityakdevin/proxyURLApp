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
});
