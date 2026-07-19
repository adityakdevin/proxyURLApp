import { metaValidator } from '../metaValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

function ctx(documents: ValidatorDoc[], ocrText: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    ocr: { extractImageText: async () => ocrText },
    shared: new Map(),
    wordBoxes: new Map(),
    pageTexts: new Map(),
  };
}
const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd',
  fileName: 'f.png',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png',
  source: 'SCANNED',
  documentTypeId: null,
  ...over,
});

describe('metaValidator', () => {
  it('PASSES and stashes text when OCR yields text', async () => {
    const c = ctx([doc({ id: 'd1' })], 'hello world');
    const out = await metaValidator.run(c);
    expect(out.status).toBe('PASSED');
    expect(c.shared.get('d1')).toBe('hello world');
  });
  it('FAILS when documents exist but no text extracted', async () => {
    expect((await metaValidator.run(ctx([doc({ id: 'd1' })], '  '))).status).toBe('FAILED');
  });
  it('PASSES (N/A) when there are no documents', async () => {
    expect((await metaValidator.run(ctx([], ''))).status).toBe('PASSED');
  });
});
