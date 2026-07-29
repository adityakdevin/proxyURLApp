// Debug CLI: show what META actually reads off each page of a PDF — the text layer,
// which pages get sent to OCR, the merged per-page text, and the field pane that text
// produces. Answers "the viewer shows a PAN card but the pane says nothing was read".
//   npx tsx scripts/dump-pages.ts <file.pdf> [page]
import { extractPdf } from '../src/lib/pdfExtractor.js';
import { TesseractOcrPort } from '../src/lib/ocr.js';
import { docFieldGroups } from '../src/validators/docFields.js';

async function main() {
  const file = process.argv[2];
  const only = process.argv[3] ? Number(process.argv[3]) : null;
  if (!file) {
    console.error('usage: npx tsx scripts/dump-pages.ts <file.pdf> [page]');
    process.exit(1);
  }
  const r = await extractPdf(file);
  if (!r) {
    console.log('pdfjs could not open the file');
    return;
  }
  console.log(`text-layer pages: ${r.pageTexts.length}`);
  console.log(`sent to OCR (no/thin text layer): ${r.textlessPages.join(', ') || 'none'}`);

  const pageTexts = [...r.pageTexts];
  const ocr = new TesseractOcrPort();
  try {
    if (r.textlessPages.length > 0) {
      const ocrd = await ocr.extractPdf(file, r.textlessPages);
      // Same merge metaValidator does — keep the OCR's line breaks, which the ID-card
      // field readers anchor on. Space-joining word boxes here would make this script
      // disagree with production about what a page says.
      for (const { page, text } of ocrd.pages ?? []) {
        if (text) pageTexts[page - 1] = pageTexts[page - 1] ? `${pageTexts[page - 1]}\n${text}` : text;
      }
      console.log(`OCR read pages: ${(ocrd.pages ?? []).map((p) => p.page).join(', ') || 'none'}`);
    }
  } finally {
    await ocr.close();
  }

  pageTexts.forEach((t, i) => {
    if (only && i + 1 !== only) return;
    console.log(`\n───── page ${i + 1} (${t.length} chars) ─────\n${t}`);
  });

  console.log('\n───── field panes ─────');
  for (const g of docFieldGroups(pageTexts)) {
    console.log(`${g.type} pages ${g.pages.join(',')}`);
    for (const f of g.fields) console.log(`  ${f.label}: ${f.value ?? '(not found)'}`);
  }
}
main();
