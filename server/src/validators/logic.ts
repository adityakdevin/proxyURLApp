import { ValidatorOutcome } from './types.js';

export const SPELL_MAX_RATIO = 0.2;

export function metaOutcome(docsWithText: number, totalDocs: number): ValidatorOutcome {
  if (totalDocs === 0) return { status: 'PASSED', summary: 'No documents to extract.' };
  if (docsWithText === 0)
    return { status: 'FAILED', summary: `No text extracted from ${totalDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Extracted text from ${docsWithText} of ${totalDocs} documents.`,
  };
}

export function spellOutcome(
  misspelled: number,
  total: number,
  sample: string[]
): ValidatorOutcome {
  if (total === 0) return { status: 'PASSED', summary: 'No text to spell-check.' };
  const ratio = misspelled / total;
  const pct = Math.round(ratio * 100);
  const status = ratio <= SPELL_MAX_RATIO ? 'PASSED' : 'FAILED';
  return {
    status,
    summary: `${pct}% suspect (${misspelled}/${total} words).`,
    details: { suspect: sample },
  };
}

export function qrOutcome(found: number, imageCount: number, values: string[]): ValidatorOutcome {
  if (imageCount === 0) return { status: 'PASSED', summary: 'No image documents to scan.' };
  if (found === 0)
    return { status: 'FAILED', summary: `No QR code found across ${imageCount} image(s).` };
  return {
    status: 'PASSED',
    summary: `${found} QR code(s) found across ${imageCount} image(s).`,
    details: { values },
  };
}

export function intraOutcome(foundInDocs: number, textDocs: number): ValidatorOutcome {
  if (textDocs === 0) return { status: 'PASSED', summary: 'No document text to compare.' };
  if (foundInDocs === 0)
    return { status: 'FAILED', summary: `Claim ID not found in any of ${textDocs} document(s).` };
  return {
    status: 'PASSED',
    summary: `Claim ID found in ${foundInDocs} of ${textDocs} document(s).`,
  };
}

export function completenessOutcome(
  presentTypeNames: string[],
  requiredTypeNames: string[]
): ValidatorOutcome {
  if (requiredTypeNames.length === 0)
    return { status: 'PASSED', summary: 'No required document types configured.' };
  const missing = requiredTypeNames.filter((t) => !presentTypeNames.includes(t));
  const present = requiredTypeNames.length - missing.length;
  if (missing.length === 0)
    return {
      status: 'PASSED',
      summary: `All ${requiredTypeNames.length} required document types present.`,
    };
  return {
    status: 'FAILED',
    summary: `${present} of ${requiredTypeNames.length} required document types present.`,
    details: { missing },
  };
}

export function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Claim IDs shorter than this match too loosely as a bare substring. */
export const INTRA_MIN_LOOSE_LEN = 6;

/**
 * Does the document text contain the claim ID? Long IDs use a normalized,
 * OCR-tolerant substring match; short IDs (< INTRA_MIN_LOOSE_LEN) require a
 * separator-bounded match so "001" doesn't match inside "Invoice 2001".
 */
export function matchesClaimId(text: string, claimId: string): boolean {
  const norm = normalizeText(claimId);
  if (norm.length === 0) return false;
  if (norm.length >= INTRA_MIN_LOOSE_LEN) {
    return normalizeText(text).includes(norm);
  }
  const escaped = claimId.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}([^A-Za-z0-9]|$)`).test(text);
}

export function tokenizeWords(s: string): string[] {
  return s.toLowerCase().match(/[a-z]{3,}/g) ?? [];
}
