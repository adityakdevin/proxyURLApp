import { properNounWarning } from '../spellTermService.js';

// No database: properNounWarning only needs the bundled dictionary, so it runs anywhere.
// The sibling spellTermService.test.ts is DB-backed and covers the create/update rules.
describe('properNounWarning', () => {
  // The dictionary loads from disk on first use.
  jest.setTimeout(20000);

  it('says nothing about ordinary form vocabulary', async () => {
    for (const term of ['designation', 'allowance', 'signatory', 'statement', 'leadership']) {
      expect(await properNounWarning(term)).toBeNull();
    }
  });

  it('warns about the place and brand names found on the live database', async () => {
    // The exact ACTIVE admin-added terms that were causing false positives in production.
    for (const term of ['lucknow', 'bhopal', 'jindal', 'bajaj', 'flipkart', 'india']) {
      const w = await properNounWarning(term);
      expect(w).toContain(term);
      expect(w).toMatch(/place or brand name/);
    }
  });

  it('never warns about a curated built-in term, including the ones the US dictionary rejects', async () => {
    // These 11 are in the built-in list and absent from dictionary-en, so a plain
    // dictionary check would nag about known-good vocabulary. 'authorised' is in the list
    // precisely BECAUSE the US dictionary rejects the British spelling.
    for (const term of ['authorised', 'pincode', 'january', 'june', 'november', 'december']) {
      expect(await properNounWarning(term)).toBeNull();
    }
  });

  it('quotes the edit-distance cap the term will actually match with', async () => {
    // 6+ characters widens the cap to 2, which is why long place names catch so much noise.
    expect(await properNounWarning('lucknow')).toMatch(/within 2 characters/);
    // Shorter terms stay at 1.
    expect(await properNounWarning('india')).toMatch(/within 1 character\b/);
  });

  it('stays silent on a word that is both a brand and an English word', async () => {
    // Documented miss, not an oversight: 'prudential' is an adjective, so the dictionary
    // accepts it and no heuristic built on the dictionary can flag it.
    expect(await properNounWarning('prudential')).toBeNull();
  });
});
