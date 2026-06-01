import { normalizeText as norm } from '../validators/logic.js';

export interface ClassifiableType {
  id: string;
  name: string;
  category: string; // 'GOVT' | 'CUSTOM'
  govtCode: string | null;
  displayOrder: number;
}

/**
 * Classify a filename to one of the SubCategory's ACTIVE DocumentTypeMasters by
 * token match: GOVT → govtCode or name; CUSTOM → name. One match → assign;
 * multiple → lowest displayOrder (tie → name); none → null.
 */
export function classify(fileName: string, docTypes: ClassifiableType[]): string | null {
  const f = norm(fileName);
  const matches = docTypes.filter((t) => {
    const tokens = t.category === 'GOVT' ? [t.govtCode ?? '', t.name] : [t.name];
    return tokens.some((tok) => tok !== '' && f.includes(norm(tok)));
  });
  if (matches.length === 0) return null;
  matches.sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  return matches[0].id;
}
