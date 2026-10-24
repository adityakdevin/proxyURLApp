// Regression check: an image neither Jimp nor Tesseract can read must cost one empty OCR
// result, not the server process. Exits non-zero (or dies outright) if it does not.
//   OCR_CACHE_DIR=. npx tsx scripts/ocr-bad-file.ts
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TesseractOcrPort } from '../src/lib/ocr.js';

async function main() {
  const bad = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ocr-bad-')), 'broken.jpg');
  fs.writeFileSync(bad, 'not an image at all');
  const ocr = new TesseractOcrPort();
  try {
    assert.deepStrictEqual(await ocr.extractImage(bad), { text: '', words: [] });
  } finally {
    await ocr.close();
  }
  console.log('ok: unreadable image read as empty, process survived');
}
main();
