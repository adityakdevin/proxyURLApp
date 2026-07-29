import { estimateSkewDegrees } from '../deskew.js';

/** A page of text lines tilted by `deg` (positive = running down to the right). */
function page(deg: number, width = 400, height = 300): Uint8Array {
  const g = new Uint8Array(width * height).fill(255);
  const t = Math.tan((deg * Math.PI) / 180);
  // Text lines every 20px, each 3px thick, spanning most of the width.
  for (let line = 1; line * 20 < height - 20; line++) {
    for (let x = 20; x < width - 20; x++) {
      const y = Math.round(line * 20 + x * t);
      for (let d = 0; d < 3; d++) {
        const yy = y + d;
        if (yy >= 0 && yy < height) g[yy * width + x] = 0;
      }
    }
  }
  return g;
}

describe('skew estimation', () => {
  it('reports 0 for a square page', () => {
    expect(estimateSkewDegrees(page(0), 400, 300)).toBe(0);
  });

  it.each([2, 3.5, -3, -5])('recovers a %s° tilt', (deg) => {
    expect(estimateSkewDegrees(page(deg), 400, 300)).toBeCloseTo(deg, 0);
  });

  it('signs the angle so that rotating by its negation squares the page up', () => {
    // Lines running DOWN to the right must report POSITIVE, so the caller rotates by -deg.
    expect(estimateSkewDegrees(page(4), 400, 300)).toBeGreaterThan(0);
    expect(estimateSkewDegrees(page(-4), 400, 300)).toBeLessThan(0);
  });

  it('declines to guess on a blank page', () => {
    expect(estimateSkewDegrees(new Uint8Array(400 * 300).fill(255), 400, 300)).toBe(0);
  });

  it('declines to guess on a solid photo (no line structure to measure)', () => {
    expect(estimateSkewDegrees(new Uint8Array(400 * 300).fill(10), 400, 300)).toBe(0);
  });

  it('is safe on a degenerate image', () => {
    expect(estimateSkewDegrees(new Uint8Array(4), 2, 2)).toBe(0);
  });
});
