import QRCode from 'qrcode';
import { qrValidator, decodePixels } from '../qrValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd',
  fileName: 'q.png',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png',
  source: 'UPLOADED',
  documentTypeId: null,
  ...over,
});
function ctx(documents: ValidatorDoc[]): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
  };
}

/** Render a QR straight to RGBA pixels via qrcode's bit matrix — Jimp and pdfjs
 *  use dynamic import() and can't run under this jest setup (CJS, no vm-modules),
 *  so the decode logic is tested at the pixel level and the file/PDF plumbing via
 *  `npx tsx scripts/scan-qr.ts <file>` against real documents. */
function qrPixels(text: string): { data: Uint8ClampedArray; size: number } {
  const qr = QRCode.create(text);
  const n = qr.modules.size;
  const margin = 4;
  const px = 8; // pixels per module
  const dim = (n + margin * 2) * px;
  const data = new Uint8ClampedArray(dim * dim * 4).fill(255);
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!qr.modules.get(r, c)) continue;
      for (let y = (r + margin) * px; y < (r + margin + 1) * px; y++)
        for (let x = (c + margin) * px; x < (c + margin + 1) * px; x++) {
          const i = (y * dim + x) * 4;
          data[i] = data[i + 1] = data[i + 2] = 0;
        }
    }
  return { data, size: dim };
}

describe('qrValidator', () => {
  it('decodePixels decodes a rendered QR', () => {
    const { data, size } = qrPixels('CLAIM-PAYLOAD');
    expect(decodePixels(data, size, size)).toBe('CLAIM-PAYLOAD');
  });
  it('decodePixels returns null when there is no QR', () => {
    const blank = new Uint8ClampedArray(64 * 64 * 4).fill(255);
    expect(decodePixels(blank, 64, 64)).toBeNull();
  });
  it('FAILS a PDF with no readable QR', async () => {
    const out = await qrValidator.run(
      ctx([doc({ fileName: 'x.pdf', readablePath: 'missing.pdf', mimeType: 'application/pdf' })])
    );
    expect(out.status).toBe('FAILED');
    expect(out.findings?.[0].code).toBe('QR_MISSING');
  });
  it('PASSES (N/A) when there are no image or PDF documents', async () => {
    expect((await qrValidator.run(ctx([doc({ mimeType: 'text/plain' })]))).status).toBe('PASSED');
  });
});
