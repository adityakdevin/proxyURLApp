import nspell from 'nspell';
import enDictionary from 'dictionary-en';
import { PrismaClient } from '@prisma/client';
import { Validator, FindingInput, WordBox } from './types.js';
import { spellCandidates, findTermMisspellings, SPELL_MIN_TERM_HITS, EXPECTED_TERMS } from './logic.js';

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
    const terms = rows.map((r) => r.term.toLowerCase().trim()).filter((t) => t.length >= 4);
    return terms.length > 0 ? terms : EXPECTED_TERMS;
  } catch {
    return EXPECTED_TERMS;
  }
}

/** Index a document's word boxes by their normalized text, as consumable queues,
 *  so repeated occurrences of a word map to distinct boxes in reading order. */
function indexBoxes(boxes: WordBox[]): Map<string, WordBox[]> {
  const idx = new Map<string, WordBox[]>();
  for (const b of boxes) {
    const key = b.text.toLowerCase().replace(/[^a-z]/g, '');
    if (!key) continue;
    const arr = idx.get(key);
    if (arr) arr.push(b);
    else idx.set(key, [b]);
  }
  return idx;
}

interface Spell {
  correct(word: string): boolean;
}

let spellPromise: Promise<Spell> | null = null;

function loadSpell(): Promise<Spell> {
  return new Promise<Spell>((resolve, reject) => {
    // dictionary-en@3 is callback-style: load((err, {aff, dic}) => ...).
    enDictionary((err, dict) => (err ? reject(err) : resolve(nspell(dict))));
  });
}

async function getSpell(): Promise<Spell> {
  // Don't cache a rejected promise — clear the singleton on failure so the next
  // run retries instead of marking every claim FAILED until restart.
  if (!spellPromise) {
    spellPromise = loadSpell().catch((e) => {
      spellPromise = null;
      throw new Error(`Dictionary load failed: ${e instanceof Error ? e.message : String(e)}`);
    });
  }
  return spellPromise;
}

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
    const findings: FindingInput[] = [];
    const distinct = new Set<string>();
    for (const [documentId, text] of ctx.shared) {
      const words = spellCandidates(text);
      if (words.length === 0) continue;
      const s = spell ?? (spell = await getSpell());
      // A token counts as a real word if the dictionary accepts it in its own case
      // or lowercased (dictionary-en holds many proper nouns only capitalised).
      const isRealWord = (w: string) => s.correct(w) || s.correct(w.toLowerCase());
      // OCR word boxes let us anchor each hit to a region on an image (Phase 2).
      const boxIndex = indexBoxes(ctx.wordBoxes.get(documentId) ?? []);
      for (const { token, term } of findTermMisspellings(words, isRealWord, terms)) {
        distinct.add(token);
        if (sample.length < 50) sample.push(`${token}→${term}`);
        const box = boxIndex.get(token)?.shift();
        findings.push({
          documentId,
          code: 'SPELL_SUSPECT',
          message: `Misspelled "${token}" (expected "${term}")`,
          page: box?.page ?? null,
          bbox: box?.bbox ?? null,
          data: { word: token, expected: term },
        });
      }
    }

    const status = distinct.size >= SPELL_MIN_TERM_HITS ? 'FAILED' : 'PASSED';
    return {
      status,
      summary: distinct.size
        ? `${distinct.size} expected-term misspelling(s): ${sample.slice(0, 8).join(', ')}`
        : 'No expected-term misspellings found.',
      details: { suspect: sample },
      // Surface the per-word findings only on a FAIL (avoid noise on a pass).
      findings: status === 'FAILED' ? findings.slice(0, 200) : [],
    };
  },
};
