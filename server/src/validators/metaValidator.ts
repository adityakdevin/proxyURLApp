import { promises as fs } from 'fs';
// Subpath import avoids pdf-parse's import-time debug-mode test-file read.
import pdfParse from 'pdf-parse/lib/pdf-parse.js';
import { Validator, ValidatorContext, ValidatorDoc } from './types.js';
import { metaOutcome } from './logic.js';

async function extractText(ctx: ValidatorContext, doc: ValidatorDoc): Promise<string> {
  const mime = doc.mimeType ?? '';
  if (mime.startsWith('image/')) {
    return ctx.ocr.extractImageText(doc.readablePath);
  }
  if (mime === 'application/pdf') {
    try {
      const buf = await fs.readFile(doc.readablePath);
      const data = await pdfParse(buf);
      return (data.text ?? '').trim();
    } catch {
      return '';
    }
  }
  return '';
}

export const metaValidator: Validator = {
  key: 'META',
  column: 'metaExtractionStatus',
  async run(ctx) {
    let withText = 0;
    for (const doc of ctx.documents) {
      const text = await extractText(ctx, doc);
      if (text && text.replace(/\s/g, '').length >= 3) {
        ctx.shared.set(doc.id, text);
        withText++;
      }
    }
    return metaOutcome(withText, ctx.documents.length);
  },
};
