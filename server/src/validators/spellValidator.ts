import { PrismaClient } from '@prisma/client';
import { Validator, FindingInput, WordBox } from './types.js';
import { getSpell, isRealWord as dictHasWord, type Spell } from './dictionary.js';
import {
  spellCandidates,
  findTermMisspellings,
  SPELL_MIN_TERM_HITS,
  EXPECTED_TERMS,
  MIN_TERM_LEN,
} from './logic.js';

/** The expected-vocabulary the near-miss matcher checks against. Prefer the
 *  admin-managed `SpellTerm` table so the list can be tuned without a deploy;
 *  fall back to the built-in EXPECTED_TERMS when it's empty or unreadable so the
 *  check never silently degrades to "no terms → nothing ever flagged". */
async function loadExpectedTerms(prisma: PrismaClient): Promise<string[]> {
  try {
    const rows = await prisma.spellTerm.findMany({
      where: { status: 'ACTIVE' },
      select: { term: true },
    });
    // Rows that can never match are dropped here as a backstop; SpellTermService rejects
    // them at entry, so this only catches terms stored before that validation existed.
    const terms = rows
      .map((r) => r.term.toLowerCase().trim())
      .filter((t) => t.length >= MIN_TERM_LEN && !/\s/.test(t));
    return terms.length > 0 ? terms : EXPECTED_TERMS;
  } catch {
    return EXPECTED_TERMS;
  }
}

/** Index a document's word boxes by their normalized text, as consumable queues,
 *  so repeated occurrences of a word map to distinct boxes in reading order.
 *  A box is indexed under EVERY letter run it contains, mirroring how spellCandidates
 *  tokenizes the text: collapsing "Quartarly Retantion" (one merged OCR/pdfjs box) or
 *  "30Dayes" to a single key meant the lookup missed and the finding lost its highlight. */
function indexBoxes(boxes: WordBox[]): Map<string, WordBox[]> {
  const idx = new Map<string, WordBox[]>();
  for (const b of boxes) {
    for (const key of b.text.toLowerCase().match(/[a-z]+/g) ?? []) {
      const arr = idx.get(key);
      if (arr) arr.push(b);
      else idx.set(key, [b]);
    }
  }
  return idx;
}

/** Tesseract word confidence (0-100) below which a hit is treated as doubtful rather
 *  than as a misspelling. Digital PDF text has no confidence and is never softened. */
const LOW_OCR_CONFIDENCE = 70;

export const spellValidator: Validator = {
  key: 'SPELL',
  column: 'spellCheckStatus',
  async run(ctx) {
    // Forgery signal = misspellings of EXPECTED form vocabulary, not a raw
    // dictionary-miss ratio. On scanned Indian paperwork the ratio just tracked OCR
    // quality (place/personal names + OCR garbage swamp the real typos); matching
    // near-misses of a curated term list isolates the words reviewers actually flag.
    // The dictionary loads lazily on the first document that has candidate words.
    let spell: Spell | null = null;
    const terms = await loadExpectedTerms(ctx.prisma);
    const sample: string[] = []; // details.suspect: "token→term" (<=50)
    const doubtfulSample: string[] = [];
    const findings: FindingInput[] = [];
    const distinct = new Set<string>();
    const doubtful = new Set<string>();
    for (const [documentId, text] of ctx.shared) {
      const words = spellCandidates(text);
      if (words.length === 0) continue;
      const s = spell ?? (spell = await getSpell());
      // A token counts as a real word if the dictionary accepts it in its own case
      // or lowercased (dictionary-en holds many proper nouns only capitalised).
      const isRealWord = (w: string) => dictHasWord(s, w);
      // OCR word boxes let us anchor each hit to a region on an image (Phase 2).
      const boxIndex = indexBoxes(ctx.wordBoxes.get(documentId) ?? []);
      for (const hit of findTermMisspellings(words, isRealWord, terms)) {
        const { token, term } = hit;
        const box = boxIndex.get(token)?.shift();
        // A low-confidence OCR read is itself grounds for doubt, whatever the glyphs say.
        const soft = hit.doubtful || (box?.conf !== undefined && box.conf < LOW_OCR_CONFIDENCE);
        (soft ? doubtful : distinct).add(token);
        const into = soft ? doubtfulSample : sample;
        if (into.length < 50) into.push(`${token}→${term}`);
        findings.push({
          documentId,
          code: soft ? 'SPELL_DOUBTFUL' : 'SPELL_SUSPECT',
          severity: soft ? 'WARNING' : 'ERROR',
          message: soft
            ? `Doubtful "${token}" (expected "${term}") — the scan quality can account for this, please confirm visually`
            : `Misspelled "${token}" (expected "${term}")`,
          page: box?.page ?? null,
          bbox: box?.bbox ?? null,
          data: { word: token, expected: term, doubtful: soft },
        });
      }
    }

    // Only CONFIDENT misspellings FAIL the check — a poor scan must not fail a claim.
    // A doubtful-only run returns PASSED here and the service downgrades it to DOUBTFUL
    // off the WARNING findings (deriveCheckStatus), so it never shows a green badge.
    const status = distinct.size >= SPELL_MIN_TERM_HITS ? 'FAILED' : 'PASSED';
    const parts: string[] = [];
    if (distinct.size) parts.push(`${distinct.size} expected-term misspelling(s): ${sample.slice(0, 8).join(', ')}`);
    if (doubtful.size) parts.push(`${doubtful.size} doubtful (possible scan misread): ${doubtfulSample.slice(0, 8).join(', ')}`);
    return {
      status,
      summary: parts.length ? parts.join('. ') : 'No expected-term misspellings found.',
      details: { suspect: sample, doubtful: doubtfulSample },
      // Both tiers surface: a doubtful word still needs the reviewer's eye on the page.
      findings: findings.slice(0, 200),
    };
  },
};
