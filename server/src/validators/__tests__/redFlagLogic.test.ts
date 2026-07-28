import {
  checkPan,
  checkGst,
  checkDl,
  checkUdyam,
  checkPassportNumber,
  checkPassportFileNo,
  checkPassportPages,
  checkAadhaar,
  checkAadhaarFormat,
  checkVid,
  checkVoterId,
  checkSignature,
  checkSignatoryWord,
  checkEditorWatermark,
  checkDates,
  ocrAdjacent,
  aadhaarNumbers,
} from '../redFlagLogic.js';

const codes = (fs: { code: string }[]) => fs.map((f) => f.code);

describe('PAN', () => {
  // Client UAT: "Employee id card is not scanned by portal.. 'Auth. Sing' written".
  it('flags a misspelt signature block, stays quiet on correct ones', () => {
    const typo = checkSignatoryWord('For ABC Motors\nAuth. Sing\nEmployee ID Card');
    expect(codes(typo)).toEqual(['REDFLAG_SIGNATORY_TYPO']);
    expect(typo[0].severity).toBe('ERROR');
    expect(typo[0].message).toContain('is not "sign"');

    // Correct forms — every one of these appears on genuine Indian paperwork.
    expect(checkSignatoryWord('Authorised Signatory')).toEqual([]);
    expect(checkSignatoryWord('AUTHORIZED SIGNATURE')).toEqual([]);
    expect(checkSignatoryWord('Auth. Sign')).toEqual([]);
    expect(checkSignatoryWord('Authorised Signatories')).toEqual([]);
    // Not a signature block at all.
    expect(checkSignatoryWord('Authorised Dealer of Bajaj Auto')).toEqual([]);
    expect(checkSignatoryWord('the author of this report')).toEqual([]);
  });

  it('keeps an OCR-garbled signature block advisory, not a red flag', () => {
    // Real tokens from the reviewer sample; failing these would re-break two claims.
    for (const garbled of ['Authorised Sighatopy', 'Authorised Signotiry']) {
      const fs = checkSignatoryWord(garbled);
      expect(codes(fs)).toEqual(['REDFLAG_SIGNATORY_UNREADABLE']);
      expect(fs[0].severity).toBe('WARNING');
    }
  });

  it('records a valid PAN as an INFO note naming the holder category', () => {
    // Reviewers reported "basic checks are not getting identified as 4 letter is P" —
    // a passing check used to produce nothing at all, so it looked like it never ran.
    const fs = checkPan('PAN: ABCPD1234E');
    expect(codes(fs)).toEqual(['REDFLAG_PAN_OK']);
    expect(fs[0].severity).toBe('INFO');
    expect(fs[0].message).toContain("4th letter 'P' = Individual");
  });
  it('flags a 9-char PAN as malformed', () => {
    const fs = checkPan('PAN No ABCD1234E');
    expect(codes(fs)).toEqual(['REDFLAG_PAN_FORMAT']);
    expect(fs[0].severity).toBe('ERROR');
  });
  it('flags an invalid 4th-letter category', () => {
    // 4th char X is not a valid category
    expect(codes(checkPan('PAN ABCXD1234E'))).toEqual(['REDFLAG_PAN_CATEGORY']);
  });
  it('treats an OCR-garbled PAN as unreadable (advisory), not a red flag', () => {
    // B misread as 8 in the letter block: A8CPD1234E → OCR-adjacent to ABCPD1234E
    const fs = checkPan('PAN A8CPD1234E');
    expect(codes(fs)).toEqual(['REDFLAG_PAN_UNREADABLE']);
    expect(fs[0].severity).toBe('WARNING');
  });
  it('stays silent when no PAN candidate is present', () => {
    expect(checkPan('just some invoice text, no id here')).toEqual([]);
  });
});

describe('GST', () => {
  const valid = '27ABCPD1234E1Z5';
  it('passes a valid GSTIN', () => {
    expect(checkGst(`GSTIN: ${valid}`)).toEqual([]);
  });
  it('flags a GSTIN missing the mandatory Z', () => {
    const bad = '27ABCPD1234E1X5'; // 14th char = X, not Z
    expect(codes(checkGst(`GSTIN: ${bad}`))).toEqual(['REDFLAG_GST_FORMAT']);
  });
  it('flags a wrong-length GSTIN', () => {
    expect(codes(checkGst('GST No 27ABCPD1234E1Z'))).toEqual(['REDFLAG_GST_FORMAT']);
  });
  it('stays silent with no GST candidate', () => {
    expect(checkGst('nothing here')).toEqual([]);
  });
});

describe('DL', () => {
  it('passes a valid DL (2 letters + 13 digits)', () => {
    expect(checkDl('DL No: MH0120200001234')).toEqual([]);
  });
  it('flags a malformed DL', () => {
    expect(codes(checkDl('Driving Licence MH01202'))).toEqual(['REDFLAG_DL_FORMAT']);
  });
  it('stays silent with no DL candidate', () => {
    expect(checkDl('unrelated')).toEqual([]);
  });
});

describe('Udyam', () => {
  it('passes a valid Udyam number', () => {
    expect(checkUdyam('UDYAM-UP-12-1234567')).toEqual([]);
  });
  it('flags a malformed Udyam number', () => {
    expect(codes(checkUdyam('UDYAM-UP-AB-1234567'))).toEqual(['REDFLAG_UDYAM_FORMAT']);
  });
  it('stays silent with no Udyam token', () => {
    expect(checkUdyam('no registration here')).toEqual([]);
  });
});

describe('Passport', () => {
  it('passes a valid passport number (1 letter + 7 digits)', () => {
    expect(checkPassportNumber('Passport No: A1234567')).toEqual([]);
  });
  it('flags a genuinely malformed passport number (too short)', () => {
    // 1 letter + 5 digits, not OCR-adjacent to the 1+7 shape → a real red flag.
    expect(codes(checkPassportNumber('Passport Number A12345'))).toEqual(['REDFLAG_PASSPORT_FORMAT']);
  });
  it('treats an all-digit passport number as OCR-unreadable (leading 1 could be I)', () => {
    expect(codes(checkPassportNumber('Passport Number 12345678'))).toEqual(['REDFLAG_PASSPORT_UNREADABLE']);
  });
  it('passes a file number of 12-15 chars', () => {
    expect(checkPassportFileNo('File No: DL1234567890AB')).toEqual([]);
  });
  it('flags a too-short file number', () => {
    expect(codes(checkPassportFileNo('File No: AB123'))).toEqual(['REDFLAG_PASSPORT_FILENO']);
  });
});

describe('Aadhaar cross-page', () => {
  it('passes when the same number appears on both sides', () => {
    const fs = checkAadhaar([
      { page: 1, text: 'front 2345 6789 0123' },
      { page: 2, text: 'back 2345 6789 0123' },
    ]);
    expect(fs).toEqual([]);
  });
  it('flags a front/back mismatch', () => {
    const fs = checkAadhaar([
      { page: 1, text: '2345 6789 0123' },
      { page: 2, text: '9999 8888 7777' },
    ]);
    expect(codes(fs)).toEqual(['REDFLAG_AADHAAR_MISMATCH']);
  });
  it('extracts distinct 12-digit numbers', () => {
    expect(aadhaarNumbers('a 234567890123 b 2345 6789 0123')).toEqual(['234567890123']);
  });
});

describe('Aadhaar / VID format', () => {
  it('passes a 12-digit Aadhaar and flags a wrong-length one', () => {
    expect(checkAadhaarFormat('Aadhaar No: 2345 6789 0123')).toEqual([]);
    const short = checkAadhaarFormat('Aadhaar No: 2345 6789 012');
    expect(codes(short)).toEqual(['REDFLAG_AADHAAR_FORMAT']);
    expect(short[0].severity).toBe('ERROR');
    expect(short[0].message).toContain('11 digits, not 12');
    // 13 digits — the case aadhaarNumbers() could never see.
    expect(codes(checkAadhaarFormat('AADHAR 2345 6789 01234'))).toEqual(['REDFLAG_AADHAAR_FORMAT']);
  });

  it('does not read the VID or enrolment number as the Aadhaar number', () => {
    expect(checkAadhaarFormat('Aadhaar VID : 1234 5678 9012 3456')).toEqual([]);
    expect(checkAadhaarFormat('Aadhaar Enrolment No 1234/56789/01234')).toEqual([]);
  });

  it('stays silent when the page carries no Aadhaar label', () => {
    expect(checkAadhaarFormat('Invoice 2345 6789 0123')).toEqual([]);
  });

  it('checks the VID digit count', () => {
    expect(checkVid('VID: 1234 5678 9012 34')).toEqual([]); // 14 per client spec
    expect(codes(checkVid('VID: 1234 5678 9012 3456'))).toEqual(['REDFLAG_VID_FORMAT']);
    expect(checkVid('no virtual id here')).toEqual([]);
  });
});

describe('Passport cross-page', () => {
  it('passes when the same number repeats across pages', () => {
    expect(checkPassportPages([{ page: 1, text: 'A1234567' }, { page: 2, text: 'barcode A1234567' }])).toEqual([]);
  });
  it('flags a number that differs between pages', () => {
    const fs = checkPassportPages([{ page: 1, text: 'A1234567' }, { page: 2, text: 'B7654321' }]);
    expect(codes(fs)).toEqual(['REDFLAG_PASSPORT_MISMATCH']);
    expect(fs[0].severity).toBe('ERROR');
  });
});

describe('Voter ID', () => {
  it('passes a single consistent EPIC', () => {
    expect(checkVoterId([{ page: 1, text: 'ABC1234567' }, { page: 2, text: 'ABC1234567' }])).toEqual([]);
  });
  it('reports Back side NA when only the front was uploaded', () => {
    const fs = checkVoterId([{ page: 1, text: 'ABC1234567' }]);
    expect(codes(fs)).toEqual(['REDFLAG_VOTER_BACK_NA']);
    expect(fs[0].severity).toBe('INFO'); // a note, never a red flag
  });
  it('flags EPIC differing across sides', () => {
    expect(codes(checkVoterId([{ page: 1, text: 'ABC1234567' }, { page: 2, text: 'XYZ7654321' }]))).toEqual([
      'REDFLAG_VOTER_MISMATCH',
    ]);
  });
});

describe('Every-doc rules', () => {
  it('passes when a signature keyword is present', () => {
    expect(checkSignature('Authorised Signatory')).toEqual([]);
  });
  it('warns (not fails) when no signature wording is found', () => {
    const fs = checkSignature('plain body text');
    expect(codes(fs)).toEqual(['REDFLAG_NO_SIGNATURE']);
    expect(fs[0].severity).toBe('WARNING');
  });
  it('flags an editor/AI watermark from the Producer', () => {
    expect(codes(checkEditorWatermark('iLovePDF; modified using iText 5.5.9'))).toEqual([
      'REDFLAG_EDITOR_WATERMARK',
    ]);
  });
  it('passes a clean Producer', () => {
    expect(checkEditorWatermark('Adobe PDF Library 15.0')).toEqual([]);
  });
  // Was previously image-only, so an AI-generated PDF passed clean.
  it('flags an AI tool named in the Producer or Creator of a PDF', () => {
    expect(codes(checkEditorWatermark('ChatGPT'))).toEqual(['REDFLAG_AI_WATERMARK']);
    expect(codes(checkEditorWatermark(null, 'Gemini'))).toEqual(['REDFLAG_AI_WATERMARK']);
  });
});

describe('Calendar dates', () => {
  it('passes a valid date', () => {
    expect(checkDates('Invoice date 15/06/2025')).toEqual([]);
  });
  it('flags 31 in a 30-day month', () => {
    expect(codes(checkDates('date 31/04/2025'))).toEqual(['REDFLAG_BAD_DATE']);
  });
  it('flags 29 Feb in a non-leap year', () => {
    expect(codes(checkDates('29/02/2025'))).toEqual(['REDFLAG_BAD_DATE']);
  });
  it('passes 29 Feb in a leap year', () => {
    expect(checkDates('29/02/2024')).toEqual([]);
  });
  it('flags month > 12', () => {
    expect(codes(checkDates('15/13/2025'))).toEqual(['REDFLAG_BAD_DATE']);
  });
});

describe('ocrAdjacent', () => {
  it('is false for an already-valid token', () => {
    expect(ocrAdjacent('ABCPD1234E', /^[A-Z]{5}[0-9]{4}[A-Z]$/)).toBe(false);
  });
  it('is true for a single OCR swap away from valid', () => {
    expect(ocrAdjacent('A8CPD1234E', /^[A-Z]{5}[0-9]{4}[A-Z]$/)).toBe(true);
  });
  it('is false for a genuinely malformed token', () => {
    expect(ocrAdjacent('XY9QD1234E', /^[A-Z]{5}[0-9]{4}[A-Z]$/)).toBe(false);
  });
});
