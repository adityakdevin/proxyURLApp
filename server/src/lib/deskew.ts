/**
 * Skew estimation for photographed documents.
 *
 * A claim page shot by hand sits a few degrees off square. Tesseract tolerates almost none
 * of it: the Vehicle Tax Invoice in a real claim bundle came back as noise ("qe AMOUNT(Rs)"),
 * so the page classified as nothing and never got a field pane at all. The 90°/180°/270°
 * retries do not help — this is a 2-6° tilt, not a quarter turn.
 *
 * Method: projection profile. Text lines are rows of ink separated by white space, so when
 * the image is square-on, summing ink per row gives a spiky histogram — and when it is
 * tilted, the same ink smears across neighbouring rows and the histogram flattens. Testing
 * candidate angles and keeping the spikiest is the standard estimator, and it needs no
 * rotation per candidate: shearing the row index by x·tan(θ) is equivalent and far cheaper.
 *
 * Pure (plain arrays in, number out) so it unit-tests against synthetic bitmaps.
 */

/** Beyond this a page is not "tilted", it is rotated — that is the 90° sweep's job. */
export const MAX_SKEW_DEG = 8;
const STEP_DEG = 0.25;
/** Ink is darker than the page. Slightly below the mean so a grey background is not ink. */
const INK_RATIO = 0.85;

/**
 * The page's skew in degrees: positive when text lines run DOWN to the right. Rotating the
 * image by the negation of this squares it up. Returns 0 when there is too little ink to
 * judge, so a blank or near-blank page is never rotated on noise.
 *
 * `grey` is one byte per pixel, row-major. Downscale before calling — skew is a geometric
 * property of the whole page and survives downsampling, which keeps this O(pixels) pass
 * cheap enough to run per candidate angle.
 */
export function estimateSkewDegrees(grey: Uint8Array, width: number, height: number): number {
  if (width < 8 || height < 8) return 0;

  let total = 0;
  for (let i = 0; i < grey.length; i++) total += grey[i];
  const threshold = (total / grey.length) * INK_RATIO;

  // Ink coordinates, gathered once and reused for every candidate angle.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (grey[row + x] < threshold) {
        xs.push(x);
        ys.push(y);
      }
    }
  }
  // Too little ink (blank page) or too much (a photo, not text) → no reliable estimate.
  const inkRatio = xs.length / (width * height);
  if (inkRatio < 0.005 || inkRatio > 0.6) return 0;

  const maxTan = Math.tan((MAX_SKEW_DEG * Math.PI) / 180);
  const offset = Math.ceil(width * maxTan) + 1;
  const rows = height + 2 * offset;

  let bestAngle = 0;
  let bestScore = -1;
  for (let a = -MAX_SKEW_DEG; a <= MAX_SKEW_DEG + 1e-9; a += STEP_DEG) {
    const t = Math.tan((a * Math.PI) / 180);
    const buckets = new Float64Array(rows);
    for (let i = 0; i < xs.length; i++) {
      // Shear instead of rotate: which text line this pixel belongs to, if the page were
      // tilted by `a`. The true angle is the one that packs each line into one bucket.
      buckets[(ys[i] - Math.round(xs[i] * t) + offset) | 0]++;
    }
    // Sum of squares peaks when the ink is concentrated in few rows (Wolf/Postl criterion).
    let score = 0;
    for (let r = 0; r < rows; r++) score += buckets[r] * buckets[r];
    // Strictly greater keeps 0° on a tie, so a square page is never nudged.
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }
  // Snap near-zero results: a fraction of a degree is not worth a resample.
  return Math.abs(bestAngle) < 0.5 ? 0 : Number(bestAngle.toFixed(2));
}
