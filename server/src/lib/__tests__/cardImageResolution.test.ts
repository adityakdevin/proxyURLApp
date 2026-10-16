import path from 'path';
import { largestImageWidthPerPage } from '../pdfExtractor.js';

/**
 * Contract tests for the measurement that separates "our decoder missed it" from "the scan
 * does not contain a readable QR".
 *
 * It CANNOT assert real pixel dimensions here. Under Jest the dynamic
 * `import('pdfjs-dist/legacy/build/pdf.mjs')` throws ("A dynamic import callback was invoked
 * without --experimental-vm-modules"), so every pdfjs-backed function degrades to its safe
 * path — which is why no existing test in this file's neighbour touches extractPdf,
 * rasterizePdf or readPdfInfo either; they are all pure coordinate math. Asserting a width
 * here would encode the failure, not the behaviour.
 *
 * The real numbers are verified through `npm run qa:qr-debug`, which runs under tsx where
 * the import works: 1080x685 on a card whose QR decodes, 777x488 on one that fails at every
 * scale, filter, tile and upscale. That pair is what put MIN_CARD_IMAGE_WIDTH at 1000.
 *
 * What IS worth pinning is the safe path, because the whole point of this function is to
 * decorate a message: it must never throw, and must never invent a size it does not have.
 */
describe('largestImageWidthPerPage', () => {
  jest.setTimeout(30000);

  const sample = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '..',
    'docs',
    'samples',
    'spelling-checks',
    'MZBB1811LSN014084.pdf'
  );

  // A Map when the file was read, null when it was not: SPELL must tell "no image on this page"
  // from "could not look", and re-reads only the first (ship review 2026-10-16).
  it('never throws on a real file: a Map, or null where pdfjs cannot load', async () => {
    const sizes = await largestImageWidthPerPage(sample, [4]);
    expect(sizes === null || sizes instanceof Map).toBe(true);
  });

  it('says it could not look (null) for a missing file rather than throwing', async () => {
    expect(await largestImageWidthPerPage('/definitely/not/here.pdf', [1])).toBeNull();
  });

  it('reports nothing for pages outside the document rather than guessing', async () => {
    const sizes = await largestImageWidthPerPage(sample, [0, -1, 99999]);
    expect(sizes?.has(0) ?? false).toBe(false);
    expect(sizes?.has(99999) ?? false).toBe(false);
  });

  it('never reports a zero or negative size for any page it does report', async () => {
    // Vacuous where pdfjs is unavailable, meaningful where it is — the invariant holds in
    // both, which is the only kind of assertion worth making across the two environments.
    const sizes = await largestImageWidthPerPage(sample, [1, 2, 3, 4, 5]);
    for (const [, wh] of sizes ?? []) {
      expect(wh.width).toBeGreaterThan(0);
      expect(wh.height).toBeGreaterThan(0);
    }
  });
});
