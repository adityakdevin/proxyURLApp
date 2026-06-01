import nspell from 'nspell';
import enDictionary from 'dictionary-en';
import { Validator } from './types.js';
import { spellOutcome, tokenizeWords } from './logic.js';

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
    const text = [...ctx.shared.values()].join(' ');
    const words = tokenizeWords(text);
    if (words.length === 0) return spellOutcome(0, 0, []);
    const spell = await getSpell();
    const suspect: string[] = [];
    for (const w of words) {
      if (!spell.correct(w)) suspect.push(w);
    }
    return spellOutcome(suspect.length, words.length, suspect.slice(0, 50));
  },
};
