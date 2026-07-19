import { Validator } from './types.js';
import { metaValidator } from './metaValidator.js';
import { spellValidator } from './spellValidator.js';
import { intraValidator } from './intraValidator.js';
import { qrValidator } from './qrValidator.js';
import { redFlagValidator } from './redFlagValidator.js';
import { fullValidator } from './fullValidator.js';

// Order matters: META extracts text + per-page text first; SPELL + INTRA consume it;
// QR is independent; REDFLAG classifies pages and runs format rules; FULL aggregates.
export const registry: Validator[] = [
  metaValidator,
  spellValidator,
  intraValidator,
  qrValidator,
  redFlagValidator,
  fullValidator,
];
