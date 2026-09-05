import { findTermMisspellings } from '../logic.js';

/**
 * Glossary behaviour at the level that matters: a short form the reviewers registered
 * must not be reported as a misspelling of anything. The validator expresses this by
 * folding the glossary into `isRealWord`, so that is what is exercised here.
 */
describe('glossary abbreviations are treated as real words', () => {
  const glossary = new Set(['pvt', 'ltd']);
  const isRealWord = (w: string) => glossary.has(w.toLowerCase());

  it('does not flag a registered abbreviation', () => {
    // "pvt" is 1 edit from "put" and 2 from "pvts"; without the glossary it is a candidate.
    expect(findTermMisspellings(['pvt'], isRealWord, ['part', 'post'])).toEqual([]);
  });

  it('still flags a genuine misspelling that is not in the glossary', () => {
    const [hit] = findTermMisspellings(['profesion'], isRealWord, ['profession']);
    expect(hit.term).toBe('profession');
  });
});
