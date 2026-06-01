import { Validator } from './types.js';
import { metaValidator } from './metaValidator.js';
import { spellValidator } from './spellValidator.js';
import { intraValidator } from './intraValidator.js';
import { qrValidator } from './qrValidator.js';
import { fullValidator } from './fullValidator.js';

// Order matters: META extracts text first; SPELL + INTRA consume it; QR is independent; FULL aggregates.
export const registry: Validator[] = [
  metaValidator,
  spellValidator,
  intraValidator,
  qrValidator,
  fullValidator,
];
