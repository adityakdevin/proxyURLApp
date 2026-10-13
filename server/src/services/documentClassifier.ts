import { normalizeText as norm } from '../validators/logic.js';

export interface ClassifiableType {
  id: string;
  name: string;
  category: string; // 'GOVT' | 'CUSTOM'
  govtCode: string | null;
  displayOrder: number;
}

/**
 * Classify a filename to one of the global ACTIVE DocumentTypeMasters by
 * token match: GOVT → govtCode or name; CUSTOM → name. One match → assign;
 * multiple → lowest displayOrder (tie → name); none → null.
 */
export function classify(fileName: string, docTypes: ClassifiableType[]): string | null {
  const matches = docTypes.filter((t) => {
    const tokens = t.category === 'GOVT' ? [t.govtCode ?? '', t.name] : [t.name];
    return tokens.some((tok) => tok !== '' && nameHasToken(fileName, norm(tok)));
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  return matches[0].id;
}

/** Short type codes fused onto a following word that still name the document:
 *  "PANCARD.pdf", "dl_front", "pancopy". */
const FUSED_SUFFIX = /^(?:card|book|no|number|copy|front|back|doc|scan|\d)/;

/** Does `fileName` carry `tok` as a word, not merely as letters inside one? A bare substring
 *  match typed "Insurance Company.pdf" and "Pankaj_salary.pdf" as PAN cards, and Missing Docs
 *  then reported a PAN as provided when the claim had none (client QA 2026-10).
 *  The token must start a word; a short one (a govt code like PAN or DL) must also end the
 *  word, or run into a suffix like "card". */
function nameHasToken(fileName: string, tok: string): boolean {
  // Word starts: after a separator, or at a lower→Upper camelCase step ("aadharPan").
  const words = fileName.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const rest = words.slice(i).join('');
    if (!rest.startsWith(tok)) continue;
    if (tok.length > 4) return true;
    const after = words[i].slice(tok.length);
    if (after === '' || FUSED_SUFFIX.test(after)) return true;
  }
  // A long type name may also END a run-together word ("taxinvoice.pdf",
  // "vehicleinsurance.pdf"). Long only: a short code at a word's end is too often letters
  // of another word ("Japan" ends in "pan").
  return tok.length > 4 && words.some((w) => w.length > tok.length && w.endsWith(tok));
}
