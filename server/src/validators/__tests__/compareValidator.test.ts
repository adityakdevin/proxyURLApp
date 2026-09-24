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
});
