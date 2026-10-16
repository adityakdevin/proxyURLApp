/** Regressions from the client QA summary report of 2026-10: Spell points #41-46. */
import { findTermMisspellings, EXPECTED_TERMS } from '../logic.js';
import { extractNames } from '../crossDocLogic.js';
import { spellValidator, secondReading } from '../spellValidator.js';
import type { ValidatorContext, WordBox } from '../types.js';

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

// Value: protects=a near-miss whose single reading cannot be trusted (#42 a text-layer word
// with no confidence, #44 an OCR word read at 69) is a visible misspelling once a second
// reading confirms it, and stays hidden when that reading disagrees or is unsure;
// fails_when=the second reading is ignored, trusted below CONFIDENT_OCR, matched on another
// page, or asked about a name, a place or a signing-line word; why_new=SPELL had no second
// reading; seam=secondReading.pages (rendering a PDF page is unreachable from Jest);
// no_claim=what tesseract actually reads, or the scan-resolution gate inside the seam
// (both measured by the tsx harness over the 570 QA claims, not here)
describe('client QA 2026-10 — a second reading of an untrusted near-miss', () => {
  const real = secondReading.pages;
  let asked: number[] = [];
  const answer = (words: WordBox[]) => {
    secondReading.pages = async (_c, _d, pages) => {
      asked.push(...pages);
      return words;
    };
  };
  afterEach(() => {
    secondReading.pages = real;
    asked = [];
  });
  const box = (text: string, page: number, conf?: number): WordBox => ({
    text,
    page,
    conf,
    bbox: { x: 0.3, y: 0.5, w: 0.1, h: 0.02 },
  });
  const run = async (text: string, boxes: WordBox[]) => {
    const ctx: ValidatorContext = {
      claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
      documents: [],
      prisma: {} as never,
      ocr: { extractImageText: async () => '' },
      shared: new Map([['d1', text]]),
      wordBoxes: new Map([['d1', boxes]]),
      pageTexts: new Map(),
    };
    const res = await spellValidator.run(ctx);
    return Object.fromEntries((res.findings ?? []).map((f) => [f.data?.word, f.severity]));
  };

  it('#42 a text-layer glyph swap both readers agree on is a misspelling', async () => {
    answer([box('Assoolate', 2, 91)]);
    expect(await run('Card No 366010 Assoolate No 2571590', [box('Assoolate', 2)])).toEqual({ assoolate: 'ERROR' });
    expect(asked).toEqual([2]);
  });
  it("a scanning app's misread that our OCR does not repeat stays hidden", async () => {
    answer([box('Invoice', 1, 96)]);
    expect(await run('Invoicc No UP402K', [box('Invoicc', 1)])).toEqual({ invoicc: 'WARNING' });
  });
  it('#44 a low-confidence read confirmed confidently is a misspelling', async () => {
    answer([box('Enginear', 2, 93)]);
    expect(await run('Designation : Software Enginear', [box('Enginear', 2, 68.7)])).toEqual({ enginear: 'ERROR' });
  });
  it('an unsure, disagreeing, or other-page second reading changes nothing', async () => {
    const first = [box('Enginear', 2, 68.7)];
    answer([box('Enginear', 2, 66)]);
    expect(await run('Software Enginear', first)).toEqual({ enginear: 'WARNING' });
    answer([box('Engineer', 2, 95)]);
    expect(await run('Software Enginear', first)).toEqual({ enginear: 'WARNING' });
    answer([box('Enginear', 3, 95)]);
    expect(await run('Software Enginear', first)).toEqual({ enginear: 'WARNING' });
  });
  it("our own OCR is not asked to confirm its glyph swaps or its guesses", async () => {
    answer([box('Perlod', 1, 95), box('Inyoice', 1, 95), box('Palicy', 1, 95)]);
    const first = [box('Perlod', 1, 83), box('Inyoice', 1, 93), box('Palicy', 1, 41)];
    expect(await run('Perlod Inyoice Palicy', first)).toEqual({ perlod: 'WARNING', inyoice: 'WARNING', palicy: 'WARNING' });
    expect(asked).toEqual([]);
  });
  it('#46 a place is not re-read, and stays hidden', async () => {
    answer([box('LUCNOW', 2, 95)]);
    expect(await run('UAN 100123456789 Branch LUCNOW', [box('LUCNOW', 2, 49)])).toEqual({ lucnow: 'WARNING' });
    expect(asked).toEqual([]);
  });
  it('a word on the signing line is not re-read: a pen stroke fools both readers', async () => {
    answer([box('Sighature', 1, 93)]);
    expect(await run('Sighature of Customer', [box('Sighature', 1)])).toEqual({ sighature: 'WARNING' });
    expect(asked).toEqual([]);
  });
  it('a word used as a name is not re-read', async () => {
    answer([box('Managar', 1, 95)]);
    expect(await run('Employee Name : MANAGAR SINGH', [box('MANAGAR', 1, 60)])).toEqual({ managar: 'WARNING' });
    expect(asked).toEqual([]);
  });
});
