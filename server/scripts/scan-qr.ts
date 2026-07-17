import { rasterizePdf } from '../src/lib/pdfExtractor.js';
import { Jimp } from 'jimp';
import { decodePixels } from '../src/validators/qrValidator.js';

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: npx tsx scripts/scan-qr.ts <file.pdf|image> [scale]');
    process.exit(1);
  }
  const scale = Number(process.argv[3] ?? 3);
  if (file.toLowerCase().endsWith('.pdf')) {
    const pages = await rasterizePdf(file, 12, scale);
    console.log(`${pages.length} page(s) rasterized at scale ${scale}`);
    for (const p of pages) {
      const img = await Jimp.read(p.png);
      const { data, width, height } = img.bitmap;
      const v = decodePixels(new Uint8ClampedArray(data), width, height);
      console.log(`  page ${p.page} (${width}x${height}): ${v ? `QR = ${v}` : 'no QR'}`);
    }
  } else {
    const img = await Jimp.read(file);
    const { data, width, height } = img.bitmap;
    const v = decodePixels(new Uint8ClampedArray(data), width, height);
    console.log(`${file} (${width}x${height}): ${v ? `QR = ${v}` : 'no QR'}`);
  }
}
main();
