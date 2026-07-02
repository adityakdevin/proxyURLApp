import { promises as fs } from 'fs';
import { WordBox } from '../validators/types.js';
import { clamp01 } from './bbox.js';

/** Cap pages scanned per PDF so a giant document can't dominate a run. */
const MAX_PDF_PAGES = 50;

type Matrix = number[]; // [a, b, c, d, e, f]

/** 2D affine matrix product (same semantics as pdfjs Util.transform). */
export function mulTransform(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * Convert one pdfjs text run into normalized ([0..1], top-left) per-word boxes. The page
 * viewport transform already bakes in rotation and the y-flip, so we just multiply and
 * divide by the viewport dimensions. The run width is distributed across whitespace-split
 * words proportionally to character count. Exported for unit testing the coordinate math.
 */
export function runToWords(
  str: string,
  itemTransform: Matrix,
  itemWidth: number,
  itemHeight: number,
  viewportTransform: Matrix,
  vw: number,
  vh: number,
  page: number
): WordBox[] {
  if (str.trim() === '' || !vw || !vh) return [];
  const tx = mulTransform(viewportTransform, itemTransform);
  const fontHeight = Math.hypot(tx[2], tx[3]) || itemHeight;
  const left = tx[4];
  const top = tx[5] - fontHeight; // tx[5] is the baseline; subtract ascent for the top edge
  const scaleX = Math.hypot(viewportTransform[0], viewportTransform[1]);
  const runWidth = itemWidth * scaleX;
  const len = str.length || 1;
  const out: WordBox[] = [];
  let cursor = left;
  for (const token of str.split(/(\s+)/)) {
    const tokW = (token.length / len) * runWidth;
    const t = token.trim();
    if (t) {
      out.push({
        text: t,
        page,
        bbox: {
          x: clamp01(cursor / vw),
          y: clamp01(top / vh),
          w: clamp01(tokW / vw),
          h: clamp01(fontHeight / vh),
        },
      });
    }
    cursor += tokW;
  }
  return out;
}

interface PdfTextItem {
  str?: string;
  transform?: number[];
  width?: number;
  height?: number;
}

/**
 * Extract a PDF's text plus per-word NORMALIZED boxes using pdfjs-dist. Returns null on ANY
 * failure (image-only/scanned PDFs still return {text:'',words:[]}; hard errors return null)
 * so the caller can fall back to text-only extraction — highlighting degrades to no boxes.
 */
export async function extractPdf(
  absolutePath: string
): Promise<{ text: string; words: WordBox[] } | null> {
  try {
    // Dynamic import: pdfjs-dist ships ESM-only; NodeNext keeps this a native import()
    // so it loads under both tsx (dev) and compiled dist (prod).
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const data = new Uint8Array(await fs.readFile(absolutePath));
    const doc = await getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise;
    const words: WordBox[] = [];
    const parts: string[] = [];
    try {
      const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
      for (let p = 1; p <= pageCount; p++) {
        const page = await doc.getPage(p);
        const viewport = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        for (const item of content.items as PdfTextItem[]) {
          const str = typeof item.str === 'string' ? item.str : '';
          if (str.trim() === '' || !item.transform) continue;
          parts.push(str);
          words.push(
            ...runToWords(
              str,
              item.transform,
              item.width ?? 0,
              item.height ?? 0,
              viewport.transform as Matrix,
              viewport.width,
              viewport.height,
              p
            )
          );
        }
      }
    } finally {
      await doc.cleanup?.();
      await doc.destroy?.();
    }
    return { text: parts.join(' ').trim(), words };
  } catch {
    return null;
  }
}
