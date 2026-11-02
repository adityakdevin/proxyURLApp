import { spawnSync } from 'child_process';
import fs from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { classifyPage } from '../segment.js';
import { checkInternetImage, checkSpecimenCard } from '../redFlagLogic.js';
import { redFlagValidator } from '../redFlagValidator.js';
import { ValidatorContext, ValidatorDoc, WordBox } from '../types.js';
import { unrotateBox } from '../../lib/bbox.js';
import { imagePdf, textPagesPdf } from '../../__tests__/helpers/imagePdf.js';
import { BLANK_INK_MAX, inkFraction, readingTurn, signatureArea, signatureExpected } from '../signatureBox.js';

const SRC = path.join(__dirname, '..', '..');

/** pdf.js and Jimp's decoders do not load under Jest, so the measuring path runs in a plain
 *  Node child under tsx (the pattern of pdfExtractor.test.ts); returns its last stdout line, parsed. */
function runChild<T>(script: string, args: string[]): T {
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, ...args], {
    cwd: path.join(SRC, '..'),
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, SRC_URL: pathToFileURL(SRC + path.sep).href },
  });
  if (r.status !== 0) throw new Error(`child exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout.trim().split('\n').pop()!) as T;
}

// The signature area as measured from two word lists, and the same area measured on a full render.
const CLIP_CHILD = `
const [, file, offWords, halfWords] = process.argv;
const src = process.env.SRC_URL;
const { signatureInk } = await import(new URL('validators/redFlagValidator.ts', src).href);
const { rasterizePdf } = await import(new URL('lib/pdfExtractor.ts', src).href);
const { inkFraction } = await import(new URL('validators/signatureBox.ts', src).href);
const { Jimp } = await import('jimp');
const doc = { id: 'd1', fileName: 'f.pdf', storagePath: file, readablePath: file, mimeType: 'application/pdf',
  source: 'UPLOADED', documentTypeId: null };
const off = await signatureInk(doc, 1, JSON.parse(offWords));
const half = await signatureInk(doc, 1, JSON.parse(halfWords));
const [page] = await rasterizePdf(file, 1, 2, [1]);
const { width, height, data } = (await Jimp.read(page.png)).bitmap;
const luma = new Uint8Array(width * height);
for (let i = 0; i < luma.length; i++) luma[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
console.log(JSON.stringify({ off, half, full: half && inkFraction(luma, width, height, half.bbox) }));
process.exit(0);
`;

// REDFLAG over one PAN page per case; prints each run's finding codes. A case with \`png\` first
// writes that picture: a grey ground with an optional grey rectangle [x, y, w, h, luma] in pixels,
// in the format of the file's extension, and an optional rectangle \`clear\` [x, y, w, h] made
// transparent (alpha 0, its colour kept). With \`exif6\` it is a JPEG stored a quarter turn
// counter-clockwise, tagged EXIF Orientation 6 (little-endian), so a viewer shows it as drawn.
const VALIDATOR_CHILD = `
const [, cases] = process.argv;
const { redFlagValidator } = await import(new URL('validators/redFlagValidator.ts', process.env.SRC_URL).href);
const { Jimp } = await import('jimp');
const { writeFileSync } = await import('fs');
const out = [];
for (const c of JSON.parse(cases)) {
  if (c.png) {
    const { width, height, ground, rect, exif6, clear } = c.png;
    const img = new Jimp({ width, height, color: 0xffffffff });
    const inside = (r, x, y) => r && x >= r[0] && x < r[0] + r[2] && y >= r[1] && y < r[1] + r[3];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        img.bitmap.data.fill(inside(rect, x, y) ? rect[4] : ground, (y * width + x) * 4, (y * width + x) * 4 + 3);
        if (inside(clear, x, y)) img.bitmap.data[(y * width + x) * 4 + 3] = 0;
      }
    }
    if (exif6) {
      img.rotate(90);
      const jpg = Buffer.from(await img.getBuffer('image/jpeg', { quality: 100 }));
      // APP1 after SOI: "II" TIFF header, one IFD entry, tag 0x0112 (Orientation) SHORT = 6.
      const tiff = [0x49, 0x49, 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
      const exif = Buffer.concat([Buffer.from('Exif\\0\\0'), Buffer.from(tiff)]);
      const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, 0, exif.length + 2]), exif]);
      writeFileSync(c.file, Buffer.concat([jpg.subarray(0, 2), app1, jpg.subarray(2)]));
    } else await img.write(c.file);
  }
  const r = await redFlagValidator.run({
    claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's' },
    documents: [{ id: 'd1', fileName: 'card', storagePath: c.file, readablePath: c.file, mimeType: c.mimeType,
      source: 'UPLOADED', documentTypeId: null }],
    prisma: {},
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map([['d1', c.words]]),
    pageTexts: new Map([['d1', ['INCOME TAX DEPARTMENT Permanent Account Number Card ABCPK1234E']]]),
    ...(c.pageImage ? { pageImages: new Map([['d1', new Map([[1, c.pageImage]])]]) } : {}),
  });
  out.push((r.findings ?? []).map((f) => f.code));
}
console.log(JSON.stringify(out));
process.exit(0);
`;

// signatureInk's ink (or null) per case of VALIDATOR_CHILD, whose pictures it reads after that run.
const INK_CHILD = `
const [, cases] = process.argv;
const { signatureInk } = await import(new URL('validators/redFlagValidator.ts', process.env.SRC_URL).href);
const out = [];
for (const c of JSON.parse(cases)) {
  const m = await signatureInk({ id: 'd1', fileName: 'card', storagePath: c.file, readablePath: c.file,
    mimeType: c.mimeType, source: 'UPLOADED', documentTypeId: null }, 1, c.words);
  out.push(m ? m.ink : null);
}
console.log(JSON.stringify(out));
process.exit(0);
`;

// signatureInk on a white 595x842 PNG with Jimp.read made to throw; prints its result.
const NO_JIMP_CHILD = `
const [, file, words] = process.argv;
const { createRequire } = await import('module');
const { Jimp } = await import('jimp');
await new Jimp({ width: 595, height: 842, color: 0xffffffff }).write(file);
// Both of Jimp's builds: the validator may load either.
for (const J of [Jimp, createRequire(process.cwd() + '/')('jimp').Jimp]) {
  J.read = async () => { throw new Error('Jimp.read decodes the whole picture on the main thread'); };
}
const { signatureInk } = await import(new URL('validators/redFlagValidator.ts', process.env.SRC_URL).href);
const doc = { id: 'd1', fileName: 'card.png', storagePath: file, readablePath: file, mimeType: 'image/png',
  source: 'UPLOADED', documentTypeId: null };
console.log(JSON.stringify(await signatureInk(doc, 1, JSON.parse(words))));
process.exit(0);
`;

// REDFLAG over one-page PAN PDFs read through their own text layer; prints, per file, the
// signature area, its ink and the finding codes.
const PDF_PAN_CHILD = `
const files = process.argv.slice(1);
const src = process.env.SRC_URL;
const { extractPdf } = await import(new URL('lib/pdfExtractor.ts', src).href);
const { signatureArea } = await import(new URL('validators/signatureBox.ts', src).href);
const { redFlagValidator, signatureInk } = await import(new URL('validators/redFlagValidator.ts', src).href);
const out = [];
for (const file of files) {
  const { words } = await extractPdf(file);
  const doc = { id: 'd1', fileName: 'card.pdf', storagePath: file, readablePath: file, mimeType: 'application/pdf',
    source: 'UPLOADED', documentTypeId: null };
  const r = await redFlagValidator.run({
    claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's' },
    documents: [doc],
    prisma: {},
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map([['d1', words]]),
    pageTexts: new Map([['d1', ['INCOME TAX DEPARTMENT Permanent Account Number Card ABCPK1234E']]]),
  });
  const m = await signatureInk(doc, 1, words);
  out.push({ area: signatureArea(words, 1), ink: m ? m.ink : null, codes: (r.findings ?? []).map((f) => f.code) });
}
console.log(JSON.stringify(out));
process.exit(0);
`;

const unsigned = (codes: string[]): boolean => codes.includes('REDFLAG_PAN_UNSIGNED');

const doc = (over: Partial<ValidatorDoc> = {}): ValidatorDoc => ({
  id: 'd1',
  fileName: 'bundle.pdf',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png', // non-PDF: redFlagValidator skips readPdfInfo (no pdfjs under jest)
  source: 'UPLOADED',
  documentTypeId: null,
  ...over,
});

function ctx(over: Partial<ValidatorContext>): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'CLM1', subCategoryId: 's' },
    documents: [doc()],
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
    pageTexts: new Map(),
    ...over,
  };
}

describe('client sheet 2026-10-31 - internet and specimen cards', () => {
  // Value: protects=a Google Images printout passing as the customer's own scan
  it('flags a page printed from Google Images', () => {
    const f = checkInternetImage(
      '10/12/26, 1:05 PM images (397x503)\nhttps://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcX&s=10 1/1',
      8,
    );
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      code: 'REDFLAG_INTERNET_IMAGE',
      severity: 'ERROR',
      page: 8,
      data: { source: 'encrypted-tbn0.gstatic.com' },
      message:
        "Page 8 is a printout of a Google Images search result (encrypted-tbn0.gstatic.com), not a scan of the customer's own document",
    });
  });

  it('reads the host through OCR noise in the scheme', () => {
    expect(
      checkInternetImage('hitps:/encrypted-tbn0.gstatic.com/images?q=tbn:X'),
    ).toHaveLength(1);
  });

  it('ignores other web addresses', () => {
    for (const t of [
      'https://web.whatsapp.com/0000aaaa-bbbb blob',
      'https://www.icicilombard.com/grievance',
      'Visit www.google.com for help',
    ]) {
      expect(checkInternetImage(t, 1)).toEqual([]);
    }
  });

  it('says "This document" when the page is unknown', () => {
    expect(checkInternetImage('encrypted-tbn1.gstatic.com')[0].message).toMatch(
      /^This document is a printout/,
    );
  });

  // Value: protects=a generated or specimen ID card passing as an issued one
  it.each(['DEMO', 'SPECIMEN', 'SAMPLE'])('flags an ID card marked %s', (m) => {
    const f = checkSpecimenCard(`Holder's Signature\n${m} Test Holder`, 3);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      code: 'REDFLAG_SPECIMEN_CARD',
      severity: 'ERROR',
      data: { marker: m },
      message: `ID card on page 3 is marked "${m}": a specimen or generated card, not an issued one`,
    });
  });

  it('does not read a specimen-signature label or policy wording as a marker', () => {
    for (const t of [
      'Specimen Signature of the REGISTERED OWNER',
      'SPECIMEN SIGNATURE',
      'Sample claim calculation',
      'SAMPLE COPY',
      'demonstration',
    ]) {
      expect(checkSpecimenCard(t, 1)).toEqual([]);
    }
  });

  // Value: protects=dealer and form wording on an ID-classified page read as a specimen stamp; fails_when=DEMO/SAMPLE/SPECIMEN before VEHICLE, CAR, FORM or OF counts as a marker; why_new=final review M3; seam=none; no_claim=other wording
  it('does not read a demo vehicle, a sample of signatures or a specimen form as a marker', () => {
    for (const t of ['Vehicle status: DEMO VEHICLE', 'SAMPLE OF SIGNATURES BELOW', 'SPECIMEN OF FORM', 'DEMO CAR']) {
      expect(checkSpecimenCard(t, 1)).toEqual([]);
    }
    expect(checkSpecimenCard('SPECIMEN CARD', 1)).toHaveLength(1);
  });

  it('runs the internet rule on every page and the specimen rule on ID pages only', async () => {
    const p1 = 'Tax Invoice\nhttps://encrypted-tbn0.gstatic.com/images?q=tbn:X';
    const p2 =
      'MAHARASHTRA STATE MOTOR DRIVING LICENCE DL No: MH12 20110012345\nDEMO';
    const p3 = 'Policy schedule\nDEMO';
    expect(classifyPage(p2)).toBe('DL');
    expect(classifyPage(p3)).toBeNull();
    const r = await redFlagValidator.run(
      ctx({ pageTexts: new Map([['d1', [p1, p2, p3]]]) }),
    );
    expect(r.status).toBe('FAILED');
    const has = (code: string, page: number) =>
      (r.findings ?? []).some((f) => f.code === code && f.page === page);
    expect(has('REDFLAG_INTERNET_IMAGE', 1)).toBe(true);
    expect(has('REDFLAG_SPECIMEN_CARD', 2)).toBe(true);
    expect(has('REDFLAG_SPECIMEN_CARD', 3)).toBe(false);
  });
});

describe('client sheet 2026-10-31 - PAN signature area and ink', () => {
  const W = (text: string, x: number, y: number, w: number, h: number, page = 1): WordBox => ({
    text,
    page,
    bbox: { x, y, w, h },
  });
  const ABOVE = [0.1, 0.15, 0.2, 0.25, 0.3].map((y) => W('word', 0.1, y, 0.1, 0.02));
  const BELOW = [0.7, 0.75, 0.8, 0.85, 0.9].map((y) => W('word', 0.1, y, 0.1, 0.02));
  const LINE = [
    W('Permanent', 0.1, 0.4, 0.12, 0.02),
    W('Account', 0.24, 0.4, 0.1, 0.02),
    W('Number', 0.36, 0.4, 0.09, 0.02),
  ];
  const turned = (words: WordBox[], t: number): WordBox[] =>
    words.map((w) => ({ ...w, bbox: unrotateBox(w.bbox, t) }));
  const near = (got: { x: number; y: number; w: number; h: number } | undefined, want: typeof got): void => {
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(got?.[k]).toBeCloseTo(want![k], 6);
  };
  const CURRENT = [...ABOVE, W('Valid', 0.695, 0.67, 0.031, 0.008), W('unless', 0.732, 0.67, 0.04, 0.008)];
  const CURRENT_BOX = { x: 0.336, y: 0.64, w: 0.268, h: 0.05 };
  const OLDER = [...ABOVE, ...LINE, W('Signature', 0.6, 0.8, 0.1, 0.02)];
  const OLDER_BOX = { x: 0.45, y: 0.7, w: 0.35, h: 0.093 };

  it('finds the box left of "Valid unless" on the current design', () => {
    const a = signatureArea(CURRENT, 1);
    expect(a?.design).toBe('current');
    expect(a?.turn).toBe(0);
    near(a?.bbox, CURRENT_BOX);
  });

  it('falls back to "Physically" when "unless" was not read', () => {
    const a = signatureArea([...ABOVE, W('Physically', 0.787, 0.82, 0.0648, 0.01), W('signed', 0.86, 0.82, 0.04, 0.01)], 1);
    near(a?.bbox, { x: 0.343, y: 0.79, w: 0.268, h: 0.05 });
  });

  it('finds the area above the "Signature" label on older designs', () => {
    const a = signatureArea([...ABOVE, W('Signature', 0.6, 0.8, 0.1, 0.02)], 1);
    expect(a?.design).toBe('older');
    near(a?.bbox, OLDER_BOX);
  });

  it('ignores an e-PAN "Signature Not Verified" widget', () => {
    const words = [
      ...ABOVE,
      W('Signature', 0.6, 0.5, 0.1, 0.02),
      W('Not', 0.71, 0.5, 0.03, 0.02),
      W('Verified', 0.6, 0.53, 0.08, 0.02),
    ];
    expect(signatureArea(words, 1)).toBeNull();
  });

  // Value: protects=an e-PAN digital-signature widget taken as the card's label when OCR misreads its words; fails_when=the widget words must read exactly; why_new=final review M1; seam=none; no_claim=misreads more than one letter off
  it('ignores an e-PAN widget whatever OCR made of its words', () => {
    for (const [a, b] of [['N0t', 'Verifed'], ['valid', 'Digitally']]) {
      const words = [
        ...ABOVE,
        W('Signature', 0.6, 0.5, 0.1, 0.02),
        W(a, 0.71, 0.5, 0.03, 0.02),
        W(b, 0.6, 0.53, 0.08, 0.02),
      ];
      expect(signatureArea(words, 1)).toBeNull();
    }
  });

  // Value: protects=an older card whose "Signature" label OCR reads next to a holder's name one letter from "not" (Nat, Nit, Net, Nut) skipped; fails_when="not" matches at edit distance 1 again, or "N0t" stops matching; why_new=P6X item 3 (fix-wave re-review minor); seam=none; no_claim=a widget whose "Verified" OCR misread by two letters and "Not" by one
  it('anchors on "Signature" before a name one letter from "not", and not before "Not" or "N0t"', () => {
    const after = (a: string, b: string): WordBox[] => [
      ...ABOVE,
      W('Signature', 0.6, 0.8, 0.1, 0.02),
      W(a, 0.71, 0.8, 0.03, 0.02),
      W(b, 0.75, 0.8, 0.08, 0.02),
    ];
    for (const name of ['Nat', 'Nit', 'Net', 'Nut']) {
      const a = signatureArea(after(name, 'Kumar'), 1);
      expect(a?.design).toBe('older');
      near(a?.bbox, OLDER_BOX);
    }
    for (const widget of ['Not', 'N0t']) expect(signatureArea(after(widget, 'Kumar'), 1)).toBeNull();
  });

  it('ignores a form label "Signature of ..."', () => {
    const words = [
      ...ABOVE,
      W('Signature', 0.1, 0.9, 0.1, 0.02),
      W('of', 0.21, 0.9, 0.02, 0.02),
      W('Applicant', 0.24, 0.9, 0.1, 0.02),
    ];
    expect(signatureArea(words, 1)).toBeNull();
  });

  it('reads the turn of a card photographed sideways or upside down', () => {
    expect(readingTurn(OLDER)).toBe(0);
    for (const t of [90, 180, 270]) expect(readingTurn(turned(OLDER, t))).toBe(t);
  });

  // Value: protects=row 38 p10, a blank card photographed sideways on an A4 page (ink 0.0009 in this band); fails_when=the band is rescaled for the page's shape (it then reaches the card's print, 0.0501); why_new=a page-shape rescale lost that flag; seam=none; no_claim=signed sideways cards (3 of 39 signed upright cards read blank in a half-height band)
  it('finds the signature area on a turned card, in page coordinates, in the same normalized band', () => {
    for (const t of [90, 180, 270]) {
      const o = signatureArea(turned(OLDER, t), 1);
      expect(o?.design).toBe('older');
      expect(o?.turn).toBe(t);
      near(o?.bbox, unrotateBox(OLDER_BOX, t));
      const c = signatureArea(turned([...CURRENT, ...LINE], t), 1);
      expect(c?.design).toBe('current');
      expect(c?.turn).toBe(t);
      near(c?.bbox, unrotateBox(CURRENT_BOX, t));
    }
    near(signatureArea(turned(OLDER, 270), 1)?.bbox, { x: 0.7, y: 0.2, w: 0.093, h: 0.35 });
  });

  // Value: protects=a turned card whose words nearest its label hold no reading line (OCR split them into lone words) keeps its check, in the turn its page read from its other words; fails_when=an undecided neighbourhood counts as reading at 0 against the page's turn; why_new=P6X fix 1 reads each anchor's turn from its 12 nearest words; seam=none; no_claim=which neighbourhood size is best
  it('keeps the page turn for a turned card whose words near the label read no line', () => {
    // Eleven lone words stacked above the label are its nearest; LINE, farther up, gives the turn.
    const lone = Array.from({ length: 11 }, (_, k) => W('word', 0.6, 0.5 + 0.025 * k, 0.1, 0.02));
    for (const t of [0, 90, 180, 270]) {
      const o = signatureArea(turned([...ABOVE, ...LINE, ...lone, W('Signature', 0.6, 0.8, 0.1, 0.02)], t), 1);
      expect(o?.turn).toBe(t);
      near(o?.bbox, unrotateBox(OLDER_BOX, t));
    }
  });

  // Value: protects=an upright card's check when OCR emits a line's right block before its left block with a stamp word between (corpus row 16 p6 lost its check); fails_when=the neighbourhood pairs words that are not next to each other in reading order; why_new=P6X literal rule, corpus e2e; seam=none; no_claim=which block order OCR uses
  it('pairs only words next to each other in reading order when reading a card\'s turn', () => {
    const stamp = W('stamp', 0.9, 0.45, 0.01, 0.08);
    const split = [0.5, 0.55, 0.6].flatMap((y) => [W('right', 0.35, y, 0.1, 0.02), stamp, W('left', 0.1, y, 0.1, 0.02)]);
    const o = signatureArea([...ABOVE, ...LINE, ...split, W('Signature', 0.1, 0.7, 0.1, 0.02)], 1);
    expect(o).toMatchObject({ design: 'older', turn: 0 });
  });

  it('needs a readable line and most words above the anchor', () => {
    expect(signatureArea([...ABOVE, W('Signature', 0.6, 0.5, 0.02, 0.1)], 1)).toBeNull();
    expect(signatureArea([...BELOW, W('Signature', 0.6, 0.2, 0.1, 0.02)], 1)).toBeNull();
    expect(
      signatureArea([...BELOW, W('Valid', 0.2, 0.2, 0.031, 0.008), W('unless', 0.24, 0.2, 0.04, 0.008)], 1),
    ).toBeNull();
  });

  it('uses only the words of the asked page', () => {
    expect(signatureArea([...ABOVE, W('unless', 0.732, 0.67, 0.04, 0.008, 2)], 1)).toBeNull();
  });

  // Value: protects=another document's label or a prose "unless" taken as the card's anchor; fails_when=the anchor search falls through to a later "Signature" or accepts "unless" outside "Valid unless physically signed"; why_new=final review I1 probes (a) and (d); seam=none; no_claim=two cards on one page
  it('uses only the card\'s own anchor: no later form label, no prose "unless"', () => {
    const cardOnTop = [
      ...ABOVE,
      W('Signature', 0.6, 0.4, 0.1, 0.02),
      ...BELOW,
      W('Applicant', 0.1, 0.92, 0.1, 0.02),
      W('Signature', 0.22, 0.92, 0.1, 0.02),
      W(':', 0.33, 0.92, 0.01, 0.02),
    ];
    expect(signatureArea(cardOnTop, 1)).toBeNull();
    const prose = [...ABOVE, W('unless', 0.1, 0.8, 0.06, 0.02), W('the', 0.17, 0.8, 0.03, 0.02)];
    expect(signatureArea(prose, 1)).toBeNull();
  });

  const bitmap = (fill: (x: number, y: number) => number): Uint8Array => {
    const a = new Uint8Array(100 * 50);
    for (let y = 0; y < 50; y++) for (let x = 0; x < 100; x++) a[y * 100 + x] = fill(x, y);
    return a;
  };
  const AREA = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };

  it('reads a white box, a pastel pattern and a pale watermark as no ink', () => {
    expect(inkFraction(bitmap(() => 250), 100, 50, AREA)).toBe(0);
    expect(inkFraction(bitmap((x) => (x % 2 ? 200 : 230)), 100, 50, AREA)).toBe(0);
    expect(inkFraction(bitmap((x, y) => (y === 25 && x >= 20 && x < 80 ? 150 : 250)), 100, 50, AREA)).toBe(0);
  });

  it('reads a blank white box on a mid-tone card ground as no ink', () => {
    const inBox = (x: number, y: number): boolean => x >= 30 && x < 70 && y >= 15 && y < 35;
    const whole = { x: 0, y: 0, w: 1, h: 1 };
    expect(inkFraction(bitmap((x, y) => (inBox(x, y) ? 250 : 135)), 100, 50, whole)).toBe(0);
    const stroked = bitmap((x, y) => (x >= 30 && x < 50 && (y === 25 || y === 26) ? 30 : inBox(x, y) ? 250 : 135));
    const f = inkFraction(stroked, 100, 50, whole);
    expect(f).toBeCloseTo(0.008, 6);
    expect(f!).toBeGreaterThan(BLANK_INK_MAX);
  });

  it('reads a thin pen stroke as ink above the blank threshold', () => {
    const f = inkFraction(bitmap((x, y) => (x >= 30 && x < 70 && (y === 25 || y === 26) ? 30 : 250)), 100, 50, {
      x: 0.1,
      y: 0.1,
      w: 0.8,
      h: 0.8,
    });
    expect(f).toBeCloseTo(0.025, 6); // 40 px x 2 rows = 80 ink pixels of the 80x40 area
    expect(f!).toBeGreaterThan(BLANK_INK_MAX);
  });

  it('returns null for an area clipped to a sliver or off the image', () => {
    const b = bitmap(() => 250);
    expect(inkFraction(b, 100, 50, { x: 0.95, y: 0.1, w: 0.2, h: 0.8 })).toBeNull();
    expect(inkFraction(b, 100, 50, { x: 1.2, y: 0.1, w: 0.2, h: 0.8 })).toBeNull();
  });

  // "Valid unless" with "unless" at x: the area runs from x - 0.396 to x - 0.128 (U = 0.04).
  const leftCard = (x: number): WordBox[] => [
    ...ABOVE,
    W('Valid', x - 0.038, 0.63, 0.031, 0.008),
    W('unless', x, 0.63, 0.04, 0.008),
  ];

  // Value: protects=a signature area that leaves the page read as blank paper, an ERROR on any card; fails_when=the clip render is not clamped to the page first; why_new=the clip render drew off-page space as white; seam=none; no_claim=CropBox pages, OCR word boxes
  it('measures only the on-page part of the signature area, and nothing when none of it is on the page', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-clip-'));
    try {
      const file = path.join(dir, 'card.pdf');
      // A 10x2 pt pen stroke whose top-left is (5, 124) pt on a 200x200 pt page: 20x4 px at scale 2.
      fs.writeFileSync(file, imagePdf({ cm: '10 0 0 2 5 74' }));
      const r = runChild<{ off: unknown; half: { ink: number; bbox: WordBox['bbox'] } | null; full: number | null }>(
        CLIP_CHILD,
        [file, JSON.stringify(leftCard(0.045)), JSON.stringify(leftCard(0.228))],
      );
      expect(r.off).toBeNull();
      near(r.half?.bbox, { x: 0, y: 0.6, w: 0.1, h: 0.05 });
      expect(r.half?.ink).toBeCloseTo(r.full!, 6);
      expect(r.full).toBeCloseTo(0.1, 6); // 80 stroke px of the 40x20 px on the page
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=the reported blank boxes, whose printed card artwork reads as pale marks (corpus: 0.0135 and 0.0157 of the area at 0.8x paper); fails_when=pale marks veto the blank finding; why_new=a faint-ink veto suppressed all three reported boxes; seam=none; no_claim=PDF pages (same measure after the render)
  it('flags a blank signature box on a picture, also over pale printed marks', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-pale-'));
    try {
      // CURRENT's area on a 595x842 picture is x 200-359, y 539-581 px.
      const card = (name: string, png: object) => ({ file: path.join(dir, name), mimeType: 'image/png', words: CURRENT, png });
      const [blank, pale] = runChild<string[][]>(VALIDATOR_CHILD, [
        JSON.stringify([
          card('blank.png', { width: 595, height: 842, ground: 255 }),
          card('pale.png', { width: 595, height: 842, ground: 240, rect: [220, 555, 120, 2, 150] }),
        ]),
      ]);
      expect(unsigned(blank)).toBe(true);
      expect(unsigned(pale)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=row 38 p10, a blank card in a 312x496 px picture (P4 calls it small); fails_when=the signature check skips small pictures; why_new=a small-picture skip lost that flag (corpus: 10 signed cards on small pictures read 0.0236-0.1392); seam=none; no_claim=what counts as small (secondReads' rule)
  it('checks the signature on a small picture page too', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-small-'));
    try {
      const card = {
        file: path.join(dir, 'blank.png'),
        mimeType: 'image/png',
        words: CURRENT,
        png: { width: 595, height: 842, ground: 255 },
      };
      const small = { width: 500, height: 700, box: { x: 0, y: 0, w: 1, h: 1 } };
      const [plain, onSmall] = runChild<string[][]>(VALIDATOR_CHILD, [
        JSON.stringify([card, { ...card, pageImage: small }]),
      ]);
      expect(unsigned(plain)).toBe(true);
      expect(unsigned(onSmall)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=the server's event loop while a PAN photo is measured (Jimp.read held it about 0.5 s on a 12 MP JPEG here, 0.9 s in review); fails_when=the picture path decodes with Jimp again; why_new=P6 review I4 (image path); seam=Jimp.read stubbed to throw in the child; no_claim=TIFF (canvas cannot decode it, so Jimp still does), the PDF path
  it('measures a picture without decoding it in Jimp', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-nojimp-'));
    try {
      const r = runChild<{ ink: number; bbox: WordBox['bbox'] } | null>(NO_JIMP_CHILD, [
        path.join(dir, 'card.png'),
        JSON.stringify(CURRENT),
      ]);
      expect(r?.ink).toBe(0);
      near(r?.bbox, CURRENT_BOX);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=a cut-out PNG card: transparent pixels are neither paper nor ink, so an area partly or wholly transparent is not measured; fails_when=pictureInk measures an area over 5% transparent (canvas reads those pixels black: a strip's edge read as ink, an all-clear picture as blank paper and an ERROR); why_new=P6X review M2; seam=none; no_claim=TIFF (Jimp fallback, stored colour as before), PDF pages
  it('does not measure a signature area that is partly or wholly transparent', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-alpha-'));
    try {
      // CURRENT's area on a 595x842 picture is x 200-359, y 539-581 px: the strip clears x < 248 (30% of it).
      const card = (name: string, clear?: number[]) => ({
        file: path.join(dir, name),
        mimeType: 'image/png',
        words: CURRENT,
        png: { width: 595, height: 842, ground: 255, clear },
      });
      const cases = JSON.stringify([card('opaque.png'), card('strip.png', [0, 0, 248, 842]), card('clear.png', [0, 0, 595, 842])]);
      const codes = runChild<string[][]>(VALIDATOR_CHILD, [cases]);
      expect(runChild<(number | null)[]>(INK_CHILD, [cases])).toEqual([0, null, null]);
      expect(codes.map(unsigned)).toEqual([true, false, false]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=a photo's blank/signed outcome, upright or turned by its EXIF tag, and a TIFF's; fails_when=the pixels measured are not the ones OCR's boxes point at (one decoder applies EXIF Orientation and the other not), or a TIFF is no longer measured; why_new=P6X item 2 moved the picture decode to @napi-rs/canvas; seam=none; no_claim=big-endian EXIF and mirrored orientations (probed the same in both decoders, not pinned)
  it('reads the same blank and signed boxes on a PNG, an EXIF-turned JPEG and a TIFF', () => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6-exif-'));
    try {
      // CURRENT's area on 595x842 is x 200-359, y 539-581 px; a signature is a 120x3 px stroke in it.
      const SIGNED = [220, 555, 120, 3, 20];
      // Where the area falls on the JPEG as stored, were its EXIF tag ignored: a stroke there reads as ink.
      const DECOY = [195, 290, 3, 200, 20];
      const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', tiff: 'image/tiff' };
      const card = (name: string, png: object) => ({
        file: path.join(dir, name),
        mimeType: MIME[name.split('.')[1]],
        words: CURRENT,
        png: { width: 595, height: 842, ground: 255, ...png },
      });
      const got = runChild<string[][]>(VALIDATOR_CHILD, [
        JSON.stringify([
          card('blank.png', {}),
          card('signed.png', { rect: SIGNED }),
          card('blank.jpg', { rect: DECOY, exif6: true }),
          card('signed.jpg', { rect: SIGNED, exif6: true }),
          card('blank.tiff', {}),
          card('signed.tiff', { rect: SIGNED }),
        ]),
      ]);
      expect(got.map(unsigned)).toEqual([true, false, true, false, true, false]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('client sheet 2026-10-31 - PAN signature on a page with other text', () => {
  // The P6X review's A4 page: an upright older-design card in Helvetica, signed over its label.
  const CARD = [
    ...(
      [
        ['INCOME TAX DEPARTMENT', 800],
        ['GOVT. OF INDIA', 782],
        ['RAHUL KUMAR', 764],
        ['SURESH KUMAR', 746],
        ['01/01/1990', 728],
        ['Permanent Account Number', 712],
        ['ABCPK1234E', 696],
      ] as const
    ).map(([t, y]) => `BT /F1 12 Tf 60 ${y} Td (${t}) Tj ET`),
    '4 w 70 652 m 100 668 l 130 650 l 160 664 l S',
    'BT /F1 10 Tf 60 630 Td (Signature) Tj ET',
  ].join('\n');
  type Read = { area: { design: string; turn: number; bbox: WordBox['bbox'] } | null; ink: number | null; codes: string[] };
  const read = (pages: Record<string, string>): Read[] => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), 'p6x-pan-'));
    try {
      const files = Object.entries(pages).map(([name, content]) => {
        const file = path.join(dir, `${name}.pdf`);
        fs.writeFileSync(file, textPagesPdf([`${CARD}\n${content}`], { mediaBox: '0 0 595 842' }));
        return file;
      });
      return runChild<Read[]>(PDF_PAN_CHILD, files);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // Value: protects=a signed upright card failed as unsigned because text below it (another document copied upside down or mirrored, with a scanner layer) turned the page to 180 and the blank paper under its label was measured; fails_when=the page's turn is used for an anchor whose own words read at another turn, or a mirrored run votes 180; why_new=P6X review I1; seam=none; no_claim=two cards on one page
  it('measures no blank paper under an upright card when upside-down or mirrored lines below outvote it', () => {
    const lines = (m: string): string =>
      Array.from({ length: 10 }, (_, k) => `BT /F1 12 Tf ${m} 540 ${520 - 30 * k} Tm (the quick brown fox jumps over the lazy dog) Tj ET`).join('\n');
    for (const r of read({ upsideDown: lines('-1 0 0 -1'), mirrored: lines('-1 0 0 1') })) {
      // In the card's own turn (0) most of the page's words are below its label: no area.
      expect(r.area).toBeNull();
      expect(unsigned(r.codes)).toBe(false);
    }
  }, 60_000);

  // Value: protects=a signed upright card failed as unsigned because a few upside-down lines under its label read as the card's own turn; fails_when=an anchor is tried in a turn other than the page's; why_new=P6X fix1 re-review e3/e1; seam=none; no_claim=a turned card on a page whose other text reads upright
  it('measures no blank paper under an upright card when a stray upside-down line sits under its label', () => {
    const letter = Array.from({ length: 10 }, (_, k) => `BT /F1 12 Tf 60 ${420 - 25 * k} Td (Dear Sir we enclose the documents for the claim) Tj ET`).join('\n');
    const flipped = (ys: number[]): string => ys.map((y) => `BT /F1 12 Tf -1 0 0 -1 320 ${y} Tm (the quick brown fox jumps over the lazy dog) Tj ET`).join('\n');
    for (const r of read({ one: `${flipped([560])}\n${letter}`, two: `${flipped([560, 545])}\n${letter}` })) {
      expect(r.area).toBeNull();
      expect(unsigned(r.codes)).toBe(false);
    }
  }, 60_000);

  // Value: protects=an upright card on a page whose long sideways caption outvotes its words is left unchecked, not measured in a guessed turn; fails_when=the anchor is tried in its card's turn when the page reads another; why_new=P6X review M1, fix1 re-review (trying other turns raised false ERRORs); seam=none; no_claim=captions near enough to the label to outvote the card's own words
  it('leaves an upright card unchecked on a page with a long sideways caption', () => {
    const caption = 'electronically generated document reference printed vertically alongside margin without manual intervention whatsoever';
    const [alone, down, up] = read({
      alone: '',
      down: `BT /F1 8 Tf 0 -1 1 0 20 820 Tm (${caption}) Tj ET`,
      up: `BT /F1 8 Tf 0 1 -1 0 30 100 Tm (${caption}) Tj ET`,
    });
    expect(alone.area).toMatchObject({ design: 'older', turn: 0 });
    expect(alone.ink).toBeGreaterThan(BLANK_INK_MAX);
    for (const r of [down, up]) {
      expect(r.area).toBeNull();
      expect(unsigned(r.codes)).toBe(false);
    }
  }, 60_000);
});

describe('client sheet 2026-10-31 - PAN signature check in REDFLAG', () => {
  const T = 'INCOME TAX DEPARTMENT Permanent Account Number Card ';

  // Value: protects=a company card (no signature) flagged blank, and an individual's card with a wrong letter escaping the check
  it('expects a signature unless the card is a non-individual one without a father\'s name', () => {
    // Combined tree: fixtures 1, 4, 5 read Company, Individual, none; 2 and 3 print a father's
    // name, so P3 reports a holder type instead of a category (no REDFLAG_PAN_OK).
    expect(signatureExpected(T + 'ABCCK1234E', 1)).toBe(false);
    expect(signatureExpected(T + "Father's Name ABCLK1234E", 1)).toBe(true);
    expect(signatureExpected(T + 'Fathers Name ABCCK1234E', 1)).toBe(true);
    expect(signatureExpected(T + 'ABCPK1234E', 1)).toBe(true);
    expect(signatureExpected(T + 'no number here', 1)).toBe(true);
  });

  // Value: protects=a partner's card on a firm's two-card page skipped as a company card; fails_when=the gate's father label is narrower than P3's PAN_FATHER_LABEL; why_new=final review M4; seam=none; no_claim=a card with no father label at all
  it('reads the father\'s label as P3 does, OCR "Mame" and Hindi included', () => {
    // Two cards: P3 reports the firm's PAN_OK (Company), so only the label keeps the check on.
    expect(signatureExpected(T + "ABCCK1234E Father's Mame RAVI ABCPK1234E", 1)).toBe(true);
    expect(signatureExpected(T + 'ABCCK1234E पिता RAVI ABCPK1234E', 1)).toBe(true);
  });

  // Value: protects=an unreadable page image failing the whole REDFLAG card
  it('a PAN page whose image cannot be opened gets no signature finding, and the check still completes', async () => {
    const W = (text: string, x: number, y: number, w: number, h: number): WordBox => ({
      text,
      page: 1,
      bbox: { x, y, w, h },
    });
    const words = [
      ...[0.1, 0.15, 0.2, 0.25, 0.3].map((y) => W('word', 0.1, y, 0.1, 0.02)),
      W('Valid', 0.695, 0.67, 0.031, 0.008),
      W('unless', 0.732, 0.67, 0.04, 0.008),
    ];
    // The words must give an area, or the loader is never reached and this test proves nothing.
    expect(signatureArea(words, 1)).not.toBeNull();
    const r = await redFlagValidator.run(
      ctx({
        documents: [doc({ readablePath: '/nonexistent/p6-card.png', mimeType: 'image/png' })],
        pageTexts: new Map([['d1', ['INCOME TAX DEPARTMENT Permanent Account Number Card ABCPK1234E']]]),
        wordBoxes: new Map([['d1', words]]),
      }),
    );
    expect(r.status).toBe('PASSED');
    expect((r.findings ?? []).some((f) => f.code === 'REDFLAG_PAN_UNSIGNED')).toBe(false);
  });
});
