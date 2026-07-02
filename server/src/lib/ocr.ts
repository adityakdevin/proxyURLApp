import os from 'os';
import path from 'path';
import { Jimp } from 'jimp';
import { createWorker, Worker } from 'tesseract.js';
import { OcrPort, WordBox } from '../validators/types.js';
import { clamp01 } from './bbox.js';

/** Walk Tesseract's block hierarchy (v5) — or the flat `words` fallback — into WordBoxes. */
function collectWords(data: unknown, width: number, height: number): WordBox[] {
  if (!width || !height) return [];
  const out: WordBox[] = [];
  const push = (w: { text?: string; bbox?: { x0: number; y0: number; x1: number; y1: number }; confidence?: number }) => {
    const t = (w.text ?? '').trim();
    if (!t || !w.bbox) return;
    const { x0, y0, x1, y1 } = w.bbox;
    out.push({
      text: t,
      page: 1,
      bbox: {
        x: clamp01(x0 / width),
        y: clamp01(y0 / height),
        w: clamp01((x1 - x0) / width),
        h: clamp01((y1 - y0) / height),
      },
      conf: w.confidence,
    });
  };
  const d = data as {
    words?: unknown[];
    blocks?: { paragraphs?: { lines?: { words?: unknown[] }[] }[] }[];
  };
  if (Array.isArray(d.blocks)) {
    for (const b of d.blocks)
      for (const p of b.paragraphs ?? [])
        for (const l of p.lines ?? []) for (const w of l.words ?? []) push(w as never);
  }
  if (out.length === 0 && Array.isArray(d.words)) {
    for (const w of d.words) push(w as never);
  }
  return out;
}

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

  async extractImage(absolutePath: string): Promise<{ text: string; words: WordBox[] }> {
    try {
      const worker = await this.getWorker();
      // blocks:true keeps the word hierarchy (with per-word bbox) in the result.
      const { data } = await worker.recognize(absolutePath, {}, { blocks: true });
      const text = (data.text ?? '').trim();
      let width = 0;
      let height = 0;
      try {
        const img = await Jimp.read(absolutePath);
        width = img.bitmap.width;
        height = img.bitmap.height;
      } catch {
        // dimensions unavailable → words emitted without boxes (text still returned)
      }
      return { text, words: collectWords(data, width, height) };
    } catch {
      return { text: '', words: [] };
    }
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
  }
}
