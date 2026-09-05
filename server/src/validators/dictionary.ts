import nspell from 'nspell';
import enDictionary from 'dictionary-en';
import { pluralStems } from './logic.js';

/** The slice of nspell this codebase uses. */
export interface Spell {
  correct(word: string): boolean;
}

let spellPromise: Promise<Spell> | null = null;

function loadSpell(): Promise<Spell> {
  return new Promise<Spell>((resolve, reject) => {
    // dictionary-en@3 is callback-style: load((err, {aff, dic}) => ...).
    enDictionary((err, dict) => (err ? reject(err) : resolve(nspell(dict))));
  });
}

/**
 * The shared en dictionary, loaded once per process on first use.
 *
 * Lives here rather than inside spellValidator because the admin Spell Dictionary screen
 * needs the same instance to warn about proper nouns. Two lazy singletons would mean two
 * copies of the dictionary resident for the life of the process.
 */
export async function getSpell(): Promise<Spell> {
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

/**
 * Whether the dictionary accepts a word in its own case or lowercased. dictionary-en holds
 * many proper nouns only capitalised, so both forms are tried — the same rule the SPELL
 * validator applies to OCR tokens.
 */
export function isRealWord(spell: Spell, word: string): boolean {
  const known = (w: string) => spell.correct(w) || spell.correct(w.toLowerCase());
  if (known(word)) return true;
  // Plurals are not misspellings. The dictionary has "dealers" but not the plural of every
  // proper noun and trade term on this paperwork, so fall back to the singular form.
  return pluralStems(word).some(known);
}
