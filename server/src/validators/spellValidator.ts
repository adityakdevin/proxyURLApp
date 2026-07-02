import nspell from 'nspell';
import enDictionary from 'dictionary-en';
import { Validator, FindingInput, WordBox } from './types.js';
import { spellOutcome, tokenizeWords } from './logic.js';

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
    // Single pass over each document's text (shared is documentId -> text) so every
    // suspect word is attributed to its source file; the dictionary loads lazily on the
    // first document that actually has words, so a text-less claim never pays for it.
    let spell: Spell | null = null;
    let total = 0;
    let misspelled = 0;
    const sample: string[] = []; // back-compat details.suspect (<=50)
    const findings: FindingInput[] = [];
    for (const [documentId, text] of ctx.shared) {
      const words = tokenizeWords(text);
      if (words.length === 0) continue;
      total += words.length;
      const s = spell ?? (spell = await getSpell());
      // OCR word boxes let us anchor each suspect to a region on an image (Phase 2).
      const boxIndex = indexBoxes(ctx.wordBoxes.get(documentId) ?? []);
      for (const w of words) {
        if (s.correct(w)) continue;
        misspelled++;
        if (sample.length < 50) sample.push(w);
        const box = boxIndex.get(w)?.shift();
        findings.push({
          documentId,
          code: 'SPELL_SUSPECT',
          message: `Suspect word: "${w}"`,
          page: box?.page ?? null,
          bbox: box?.bbox ?? null,
          data: { word: w },
        });
      }
    }

    const outcome = spellOutcome(misspelled, total, sample);
    // Only surface per-word findings when the check FAILED (avoid noise on a pass).
    if (outcome.status === 'FAILED') outcome.findings = findings.slice(0, 200);
    return outcome;
  },
};
