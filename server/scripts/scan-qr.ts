// Debug CLI: scan an image or PDF for QR codes the way the QR validator does
// (zxing tryHarder, scale-3 pass + scale-8 retry for PDFs).
//   npx tsx scripts/scan-qr.ts <file.pdf|image>
// Useful when a reviewer reports "document has a QR but the check says none".
import { Jimp } from 'jimp';
import { decodeAll, decodeQrPdf } from '../src/validators/qrValidator.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx scripts/scan-qr.ts <file.pdf|image>');
    process.exit(1);
  }
  if (file.toLowerCase().endsWith('.pdf')) {
    const hits = await decodeQrPdf(file);
    if (hits.length === 0) console.log('no QR found');
    for (const h of hits) console.log(`page ${h.page}: QR = ${h.value}`);
  } else {
    const img = await Jimp.read(file);
    const { data, width, height } = img.bitmap;
    const values = await decodeAll(new Uint8ClampedArray(data), width, height);
    if (values.length === 0) console.log('no QR found');
    for (const v of values) console.log(`QR = ${v}`);
  }
}
main();
