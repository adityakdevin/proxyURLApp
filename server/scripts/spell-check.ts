// Debug CLI: run the SPELL check over real documents the way the validator does
// (pdfjs text layer + tesseract OCR for image-only pages), and print every hit with
// its tier. Use it to measure a tokenizer/threshold change against the reviewer
// sample before shipping it, instead of guessing.
//   npx tsx scripts/spell-check.ts ../docs/samples/spelling-checks/*.pdf
import path from 'path';
import { extractPdf } from '../src/lib/pdfExtractor.js';
import { TesseractOcrPort } from '../src/lib/ocr.js';
import { spellCandidates, findTermMisspellings, EXPECTED_TERMS } from '../src/validators/logic.js';
import nspell from 'nspell';
import enDictionary from 'dictionary-en';

interface Spell {
  correct(word: string): boolean;
}

function loadSpell(): Promise<Spell> {
  return new Promise((resolve, reject) =>
    enDictionary((err, dict) => (err ? reject(err) : resolve(nspell(dict))))
  );
}

/** Same extraction path metaValidator takes for a PDF. */
async function textOf(file: string, ocr: TesseractOcrPort): Promise<string> {
  if (!file.toLowerCase().endsWith('.pdf')) return (await ocr.extractImage(file)).text;
  const digital = await extractPdf(file);
  if (!digital || !digital.text) return (await ocr.extractPdf(file)).text;
  if (digital.textlessPages.length === 0) return digital.text;
  const ocrd = await ocr.extractPdf(file, digital.textlessPages);
  return `${digital.text}\n${ocrd.text}`;
}

async function main() {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error('usage: npx tsx scripts/spell-check.ts <file.pdf|image> [...]');
    process.exit(1);
  }
  const spell = await loadSpell();
  const isRealWord = (w: string) => spell.correct(w) || spell.correct(w.toLowerCase());
  const ocr = new TesseractOcrPort();
  try {
    for (const file of files) {
      const text = await textOf(file, ocr);
      const hits = findTermMisspellings(spellCandidates(text), isRealWord, EXPECTED_TERMS);
      const bad = hits.filter((h) => !h.doubtful);
      const soft = hits.filter((h) => h.doubtful);
      console.log(
        `\n${path.basename(file)}  [${text.length} chars]  ${bad.length} flagged, ${soft.length} doubtful`
      );
      for (const h of bad) console.log(`   FLAG     ${h.token} -> ${h.term}`);
      for (const h of soft) console.log(`   doubtful ${h.token} -> ${h.term}`);
    }
  } finally {
    await ocr.close();
  }
}
main();
