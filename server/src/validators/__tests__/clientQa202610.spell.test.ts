/** Regressions from the client QA summary report of 2026-10: Spell points #41-46. */
import { findTermMisspellings, EXPECTED_TERMS } from '../logic.js';
import { extractNames } from '../crossDocLogic.js';

const isReal = (w: string) => ['surgeon', 'associate', 'security', 'senior', 'nurse', 'sales'].includes(w.toLowerCase());
const hits = (words: string[]) => findTermMisspellings(words, isReal).map((h) => `${h.token}→${h.term}`);

describe('client QA 2026-10 — Spell', () => {
  it('#41-43 misspelt job titles on an ID card have a term to be near', () => {
    expect(hits(['Surgoen'])).toEqual(['surgoen→surgeon']);
    expect(hits(['Asociate'])).toEqual(['asociate→associate']);
    expect(hits(['Securty'])).toEqual(['securty→security']);
  });
  it('correctly spelt titles are not flagged', () => {
    expect(hits(['Surgeon', 'Associate', 'Senior', 'Nurse'])).toEqual([]);
  });
  it('the new terms are all single words the matcher can act on', () => {
    for (const t of ['surgeon', 'associate', 'technician']) expect(EXPECTED_TERMS).toContain(t);
    // The matcher compares one token at a time: a term with a space could never match.
    expect(EXPECTED_TERMS.filter((t) => /\s/.test(t))).toEqual([]);
  });
  it('#44-46 a misspelt label does not run on into the name', () => {
    expect(extractNames('Employee Name : RAJESH KUMAR Desigantion Engineer')).toEqual(['RAJESH KUMAR']);
  });
});
