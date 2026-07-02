import Jimp from 'jimp';
import jsQR from 'jsqr';
import { Validator, ValidatorContext, FindingInput } from './types.js';
import { qrOutcome } from './logic.js';

async function decodeQr(absolutePath: string): Promise<string | null> {
  try {
    const img = await Jimp.read(absolutePath);
    const { data, width, height } = img.bitmap; // RGBA Buffer
    const res = jsQR(new Uint8ClampedArray(data), width, height);
    return res ? res.data : null;
  } catch {
    return null;
  }
}

export const qrValidator: Validator = {
  key: 'QR',
  column: 'qrStatus',
  async run(ctx: ValidatorContext) {
    const images = ctx.documents.filter((d) => (d.mimeType ?? '').startsWith('image/'));
    const values: string[] = [];
    const missing: FindingInput[] = [];
    for (const img of images) {
      const v = await decodeQr(img.readablePath);
      if (v) values.push(v);
      else
        missing.push({
          documentId: img.id,
          code: 'QR_MISSING',
          message: `No QR code found in ${img.fileName}.`,
        });
    }
    const outcome = qrOutcome(values.length, images.length, values);
    if (outcome.status === 'FAILED') outcome.findings = missing;
    return outcome;
  },
};
