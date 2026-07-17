import { Jimp } from 'jimp';
import jsQR from 'jsqr';
import { Validator, FindingInput } from './types.js';
import { qrOutcome } from './logic.js';
import { rasterizePdf } from '../lib/pdfExtractor.js';

// Policy QR codes are small on an A4 page — at the OCR raster scale (2) jsQR
// either misses them or reports an empty-payload "hit"; scale 3 decodes them
// reliably (measured on the reviewer sample PDFs). Page cap mirrors the OCR one.
const PDF_QR_SCALE = 3;
const MAX_QR_PAGES = 12;

export function decodePixels(
  data: Uint8ClampedArray,
  width: number,
  height: number
): string | null {
  const res = jsQR(data, width, height);
  // jsQR can locate a QR but decode a 0-byte payload on low-res rasters —
  // that's a failed decode, not a value.
  return res && res.data ? res.data : null;
}

async function decodeQrImage(absolutePath: string): Promise<string | null> {
  try {
    const img = await Jimp.read(absolutePath);
    const { data, width, height } = img.bitmap;
    return decodePixels(new Uint8ClampedArray(data), width, height);
  } catch {
    return null;
  }
}

async function decodeQrPdf(absolutePath: string): Promise<{ page: number; value: string }[]> {
  const out: { page: number; value: string }[] = [];
  // rasterizePdf returns [] on any failure, so an unreadable PDF just yields no QR.
  for (const p of await rasterizePdf(absolutePath, MAX_QR_PAGES, PDF_QR_SCALE)) {
    try {
      const img = await Jimp.read(p.png);
      const { data, width, height } = img.bitmap;
      const v = decodePixels(new Uint8ClampedArray(data), width, height);
      if (v) out.push({ page: p.page, value: v });
    } catch {
      // unreadable page raster → no QR on that page
    }
  }
  return out;
}

export const qrValidator: Validator = {
  key: 'QR',
  column: 'qrStatus',
  async run(ctx) {
    const scannable = ctx.documents.filter(
      (d) => (d.mimeType ?? '').startsWith('image/') || d.mimeType === 'application/pdf'
    );
    const values: string[] = [];
    // Per-document decoded values, persisted in result.details so the UI can show them.
    const decoded: { documentId: string; fileName: string; value: string; page?: number }[] = [];
    const missing: FindingInput[] = [];
    for (const doc of scannable) {
      const hits: { page?: number; value: string }[] =
        doc.mimeType === 'application/pdf'
          ? await decodeQrPdf(doc.readablePath)
          : await decodeQrImage(doc.readablePath).then((v) => (v ? [{ value: v }] : []));
      if (hits.length > 0) {
        for (const h of hits) {
          values.push(h.value);
          decoded.push({
            documentId: doc.id,
            fileName: doc.fileName,
            value: h.value,
            ...(h.page !== undefined ? { page: h.page } : {}),
          });
        }
      } else {
        missing.push({
          documentId: doc.id,
          code: 'QR_MISSING',
          message: `No QR code found in ${doc.fileName}.`,
        });
      }
    }
    const outcome = qrOutcome(values.length, scannable.length, values);
    if (outcome.status === 'FAILED') outcome.findings = missing;
    if (decoded.length > 0) outcome.details = { values, decoded };
    return outcome;
  },
};
