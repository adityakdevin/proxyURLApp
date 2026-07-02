import { mulTransform, runToWords } from '../pdfExtractor.js';

describe('pdfExtractor coordinate math', () => {
  it('mulTransform matches affine matrix composition', () => {
    // Identity ∘ M = M
    expect(mulTransform([1, 0, 0, 1, 0, 0], [12, 0, 0, 12, 100, 700])).toEqual([12, 0, 0, 12, 100, 700]);
  });

  it('maps a text run on a standard 612x792 page to a normalized top-left box', () => {
    // Portrait page: viewport transform flips y (user-space bottom-left -> device top-left).
    const viewportTransform = [1, 0, 0, -1, 0, 792];
    // Font size 12 at x=100, baseline y=700 (user space), run width 50.
    const words = runToWords('Hello', [12, 0, 0, 12, 100, 700], 50, 12, viewportTransform, 612, 792, 1);
    expect(words).toHaveLength(1);
    const b = words[0].bbox;
    expect(words[0].text).toBe('Hello');
    expect(words[0].page).toBe(1);
    expect(b.x).toBeCloseTo(100 / 612, 5); // left
    expect(b.y).toBeCloseTo((792 - 700 - 12) / 792, 5); // top = 792 - baseline - ascent
    expect(b.w).toBeCloseTo(50 / 612, 5);
    expect(b.h).toBeCloseTo(12 / 792, 5);
  });

  it('splits a multi-word run into proportional boxes that stay in [0,1]', () => {
    const words = runToWords('ab cd', [10, 0, 0, 10, 0, 100], 100, 10, [1, 0, 0, -1, 0, 200], 100, 200, 2);
    expect(words.map((w) => w.text)).toEqual(['ab', 'cd']);
    // "ab" (2 of 5 chars) then a space, then "cd": second word starts after 3/5 of the width.
    expect(words[1].bbox.x).toBeCloseTo(0.6, 5);
    for (const w of words) {
      expect(w.bbox.x).toBeGreaterThanOrEqual(0);
      expect(w.bbox.x).toBeLessThanOrEqual(1);
      expect(w.bbox.w).toBeGreaterThanOrEqual(0);
      expect(w.page).toBe(2);
    }
  });

  it('returns nothing for blank or zero-size input', () => {
    expect(runToWords('   ', [1, 0, 0, 1, 0, 0], 10, 10, [1, 0, 0, 1, 0, 0], 100, 100, 1)).toHaveLength(0);
    expect(runToWords('x', [1, 0, 0, 1, 0, 0], 10, 10, [1, 0, 0, 1, 0, 0], 0, 0, 1)).toHaveLength(0);
  });
});
