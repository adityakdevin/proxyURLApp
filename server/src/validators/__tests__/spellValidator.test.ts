import { spellValidator } from '../spellValidator.js';
import { ValidatorContext } from '../types.js';

function ctx(text: string): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents: [],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(text ? [['d1', text]] : []),
    wordBoxes: new Map(),
  };
}

describe('spellValidator', () => {
  it('PASSES clean English text', async () => {
    expect((await spellValidator.run(ctx('the quick brown fox jumps over the lazy dog'))).status).toBe('PASSED');
  });
  it('FAILS text that is mostly gibberish', async () => {
    expect((await spellValidator.run(ctx('zzzqqq wwwxxx vvvbbb nnnmmm lkjhg fdsapo iuyt'))).status).toBe('FAILED');
  });
  it('PASSES (N/A) when there is no text', async () => {
    expect((await spellValidator.run(ctx(''))).status).toBe('PASSED');
  });
});
