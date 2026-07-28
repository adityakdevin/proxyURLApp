// Regression: QA-001 — the FRONT of an Aadhaar card classified as nothing, so the one page
// carrying the holder's name, DOB and Aadhaar number was invisible to every per-type check.
// Found by /qa on 2026-07-28 against claim MZBB1811LSN014084 (page 4 of the bundle).
// Report: .gstack/qa-reports/qa-report-localhost-2026-07-28.md
import { classifyPage } from '../segment.js';

// OCR output of the real card, verbatim from the stored page text.
const AADHAAR_FRONT =
  'Jagjeet Singh s+ fafa DOB: 15/07/1985 _ EEC ISEE 9&9 / MALE Cas Tha 2111 2163 1736 ERSToaDER:';

// The insurance page that follows it in the same bundle. Its toll-free number is
// Aadhaar-shaped, so digits alone must never be enough to classify a page as Aadhaar.
const INSURANCE_WITH_TOLLFREE =
  'Go Digit General Insurance Ltd. Policy No. D210959291 Period of Insurance ' +
  'Email ID: support@kiasafety.com Toll Free No: 1800 2666 9666';

describe('classifyPage — Aadhaar front side', () => {
  it('classifies the front side, which never prints the word "Aadhaar"', () => {
    expect(AADHAAR_FRONT).not.toMatch(/aadhaar|uidai/i); // precondition: no keyword
    expect(classifyPage(AADHAAR_FRONT)).toBe('AADHAR');
  });

  it('still classifies the back side by its keyword', () => {
    expect(classifyPage('UIDAI Unique Identification Authority of India')).toBe('AADHAR');
  });

  it('does not classify an insurance page as Aadhaar on a toll-free number', () => {
    expect(classifyPage(INSURANCE_WITH_TOLLFREE)).not.toBe('AADHAR');
  });

  it('needs BOTH signals — digits alone, or a gender word alone, is not a card', () => {
    expect(classifyPage('Invoice total 2345 6789 0123')).not.toBe('AADHAR');
    expect(classifyPage('Applicant gender: MALE')).not.toBe('AADHAR');
  });
});
