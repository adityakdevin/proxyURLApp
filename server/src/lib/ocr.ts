import os from 'os';
import path from 'path';
import { createWorker, Worker } from 'tesseract.js';
import { OcrPort } from '../validators/types.js';

// Cache tesseract language data OUTSIDE the repo. With no cachePath, tesseract.js
// writes `<lang>.traineddata` into the process cwd (the repo's server/ dir).
const OCR_CACHE_PATH = process.env.OCR_CACHE_DIR || path.join(os.tmpdir(), 'claims-ocr-cache');

export class TesseractOcrPort implements OcrPort {
  private worker: Worker | null = null;

  private async getWorker(): Promise<Worker> {
    if (!this.worker) {
      // Reuse one worker across all images in a run — spinning one up (and loading
      // the language data) per image is the dominant cost otherwise.
      this.worker = await createWorker('eng', undefined, { cachePath: OCR_CACHE_PATH });
    }
    return this.worker;
  }

  async extractImageText(absolutePath: string): Promise<string> {
    try {
      const worker = await this.getWorker();
      const { data } = await worker.recognize(absolutePath);
      return (data.text ?? '').trim();
    } catch {
      return '';
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
