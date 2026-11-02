import { mrzCheckDigit, checkPassportMrz, checkPassportPages, checkPan, checkPassportNumber, checkCustomerPanType, checkGst, checkDl, checkAadhaarFormat, checkVid, checkAadhaar, aadhaarNumbers, verhoeffOk, checkAadhaarChecksum, cleanRead } from '../redFlagLogic';
import { NOT_AN_ID_CARD, typePresent } from '../logic';
import { classifyPage } from '../segment.js';
import { extractIdentifiers } from '../dupIdentifiers';

describe('client sheet 2026-10-31 - PAN reads', () => {
  it('flags an 11-character PAN printed two lines below the label', () => {
    const text =
      'INCOME TAX DEPARTMENT GOVT. OF INDIA\nPermanent Account Number Card\n: - Spe\n= P= ABCDE12345F  [xyz\nName\nRAVI KUMAR';
    expect(checkPan(text, 7)).toEqual([
      { code: 'REDFLAG_PAN_FORMAT', severity: 'ERROR', message: 'PAN "ABCDE12345F" is 11 characters, not 10', page: 7, data: { pan: 'ABCDE12345F' } },
    ]);
  });

  it('says the length when a labelled PAN is the wrong length', () => {
    expect(checkPan('PAN: ABCDE12345F')[0].message).toBe('PAN "ABCDE12345F" is 11 characters, not 10');
  });

  it('reports a 10-character misread under the label as unreadable', () => {
    const text = 'INCOME TAX DEPARTMENT\nPermanent Account Number Card = ein Se 84\nBl ETRY Na\nABCDES6SSA Yzxw\nName';
    expect(checkPan(text, 8).map((f) => f.code)).toEqual(['REDFLAG_PAN_UNREADABLE']);
  });

  it('finds the PAN under an OCR-garbled label', () => {
    const text = 'INCOMETAXDEPARTMENT GOVT. OF INDIA\nRAVI KUMAR\nPormanent Account Number\nABCPAB142P\nSignature';
    expect(checkPan(text, 19).map((f) => f.code)).toEqual(['REDFLAG_PAN_UNREADABLE']);
  });

  it('ignores short junk next to the label', () => {
    const text = 'INCOME TAX DEPARTMENT\nPermanent Account Number Card, S555 Ey\nSP | ABCDEFGHIJ |\nName';
    expect(checkPan(text, 5)).toEqual([]);
  });

  const HEAD = 'INCOME TAX DEPARTMENT\nPermanent Account Number Card\n';

  it('reads a loose PAN through a stray OCR separator, and skips a date', () => {
    expect(checkPan(HEAD + 'ABCPK.1234F\nName', 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
    expect(checkPan(HEAD + 'DOB:01/01/1980\nName', 3)).toEqual([]);
  });

  it('pins the loose read: a non-PAN 10-character token, the window and the length cap', () => {
    const r = checkPan(HEAD + 'ABC1234567\nName', 4);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'REDFLAG_PAN_UNREADABLE', severity: 'ERROR', page: 4, data: { pan: 'ABC1234567' } });
    expect(checkPan(HEAD + 'a\nb\nc\nd\nABC1234567', 4)).toEqual([]);
    expect(checkPan(HEAD + 'ABC1234567890123\nName', 4)).toEqual([]);
  });

  it('skips the PAN Services Unit address and reads under the next PAN label', () => {
    const text =
      'INCOME TAX DEPARTMENT\nIf this card is lost, please inform: Income Tax PAN Services Unit, NSDL\nPUNE411016\nPermanent Account Number Card\nABCDES6SSA\nName';
    const r = checkPan(text, 2);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ code: 'REDFLAG_PAN_UNREADABLE', data: { pan: 'ABCDES6SSA' } });
  });

  it('reads only after the label on the label line', () => {
    expect(checkPan('INCOME TAX DEPARTMENT\nDOB01011980 Permanent Account Number Card\nName', 3)).toEqual([]);
  });
});

describe('client sheet 2026-10-31 - PAN holder', () => {
  const IND =
    "INCOME TAX DEPARTMENT\nPermanent Account Number Card\nAAPLB1234L\nName\nRAVI KUMAR SHAH\nFather's Name\nMOHAN SHAH\nDate of Birth\n01-01-1980";
  const p = (pan: string) => ({ documentId: 'd1', page: 4, pan });

  it('flags an individual card whose 4th letter is not P, and a 5th letter that starts no name word', () => {
    const r = checkPan(IND, 10);
    expect(r.map((f) => f.code)).toEqual(['REDFLAG_PAN_HOLDER_TYPE', 'REDFLAG_PAN_NAME_LETTER']);
    expect(r[0].message).toBe(
      `PAN "AAPLB1234L" has 4th letter 'L' (Local Authority), but the card prints a father's name, so it belongs to an individual (4th letter 'P')`
    );
    expect(r[1].message).toBe(`PAN "AAPLB1234L" 5th letter 'B' starts no word of the holder's name "RAVI KUMAR SHAH"`);
  });

  it('accepts a 5th letter that starts the surname', () => {
    const t = IND.replace('AAPLB1234L', 'ABCPK1234F').replace('RAVI KUMAR SHAH', 'SURESH KAPOOR');
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('skips the letter check with no Name label or an unreadable name line', () => {
    const noLabel = 'INCOME TAX DEPARTMENT GOVT. OF INDIA\nSURESH KAPOOR\nRAM LAL\n01/01/1980\nPermanent Account Number\nABCPZ1234F';
    const junk = "INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPK1234F\na8 Name id\n:-- -- ~~\nFather's Name";
    expect(checkPan(noLabel, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
    expect(checkPan(junk, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('leaves a company card alone', () => {
    const t =
      'INCOME TAX DEPARTMENT\nPermanent Account Number\nABC GLOBAL SERVICES PRIVATE LIMITED\nDate of Incorporation/Formation\n01-01-2010\nAABCA1234Q';
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it("flags a company customer whose only PAN card is an individual's", () => {
    expect(checkCustomerPanType('ABC GLOBAL SERVICES LLP', [p('ABCPY1234F')])).toMatchObject({
      documentId: 'd1',
      finding: {
        code: 'REDFLAG_PAN_HOLDER_TYPE',
        severity: 'ERROR',
        page: 4,
        message:
          "Customer \"ABC GLOBAL SERVICES LLP\" is a company, but the PAN card on page 4 is an individual's (4th letter 'P'); a company's PAN has 'C', an LLP's 'F'",
      },
    });
  });

  it('accepts a company PAN anywhere in the claim, a proprietorship, or no DMS name', () => {
    expect(checkCustomerPanType('ABC GLOBAL SERVICES LLP', [p('ABCPY1234F'), p('AAMFA1234Q')])).toBeNull();
    expect(checkCustomerPanType('RAVI AND SONS', [p('ABCPY1234F')])).toBeNull();
    expect(checkCustomerPanType(null, [p('ABCPY1234F')])).toBeNull();
  });

  it('leaves the holder checks alone on a page holding two PAN cards', () => {
    const t =
      "INCOME TAX DEPARTMENT\nPermanent Account Number\nABC GLOBAL SERVICES PRIVATE LIMITED\nAABCA1234Q\nINCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPK1234F\nName\nSURESH KAPOOR\nFather's Name\nRAM KAPOOR";
    expect(checkPan(t, 2).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('skips the 5th-letter check when the Name label line already holds words', () => {
    const t = "INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPK1234F\nNAME RAVI KUMAR\nFATHER'S NAME MOHAN LAL";
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('skips the 5th-letter check when the name line carries a digit', () => {
    const t = IND.replace('AAPLB1234L', 'ABCPS1234F').replace('RAVI KUMAR SHAH', 'RAVI KUMAR 5HAH');
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('reads a father label with a curly apostrophe', () => {
    expect(checkPan(IND.replace("Father's", 'Father\u2019s'), 10).map((f) => f.code)).toEqual([
      'REDFLAG_PAN_HOLDER_TYPE',
      'REDFLAG_PAN_NAME_LETTER',
    ]);
  });

  it('counts a non-individual PAN read of any length as the company card', () => {
    expect(
      checkCustomerPanType('ABC GLOBAL SERVICES LLP', [p('ABCPY1234F'), { documentId: 'd2', page: 1, pan: 'AAMFA12345Q' }])
    ).toBeNull();
  });

  it('accepts a 5th letter that starts the first word of a surname-first name', () => {
    const t = IND.replace('AAPLB1234L', 'ABCPK1234F').replace('RAVI KUMAR SHAH', 'KAPOOR SURESH');
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('takes the holder name from the Name label, not the father label printed first', () => {
    const t = "INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPK1234F\nFather's Name\nMOHAN SHAH\nName\nSURESH KAPOOR";
    expect(checkPan(t, 3).map((f) => f.code)).toEqual(['REDFLAG_PAN_OK']);
  });

  it('matches company words whole and returns the first individual card', () => {
    expect(checkCustomerPanType('ALTDORF UNLIMITED TRADERS', [p('ABCPY1234F')])).toBeNull();
    expect(checkCustomerPanType('ABC MOTORS PVT. LTD.', [p('ABCPY1234F')])).not.toBeNull();
    const r = checkCustomerPanType('ABC GLOBAL SERVICES LLP', [
      { documentId: 'd1', page: 4, pan: 'ABCPY1234F' },
      { documentId: 'd1', page: 6, pan: 'XYZPQ5678R' },
    ]);
    expect(r?.finding.page).toBe(4);
  });
});

describe('client sheet 2026-10-31 - GST and DL', () => {
  const CERT =
    'Form GST REG-06\nRegistration Certificate\nRegistration Number : 23ABCDE1234F1Z56\nLegal Name ABC TRADERS\nConstitution of Business Proprietorship';

  it('reads the GSTIN after "Registration Number" on a GST certificate', () => {
    const f = checkGst(CERT, 11);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_GST_FORMAT']);
    expect(f[0].message).toContain('is 16 chars, not 15');
    expect(checkGst(CERT.replace('1Z56', '1Z'), 12)[0].message).toContain('is 14 chars, not 15');
  });

  it('never reads a vehicle registration number as a GSTIN', () => {
    expect(
      checkGst('Policy Schedule\nGSTIN: 27ABCPD1234E1Z5\nas per the Registration Certificate of the vehicle\nRegistration Number : MP09AB1234', 2)
    ).toEqual([]);
  });

  it('ignores a word after the GSTIN label', () => {
    expect(checkGst('GSTIN : POLICY NUMBER 123', 9)).toEqual([]);
  });

  it('classifies a GST certificate by "Constitution of Business"', () => {
    expect(
      classifyPage('Form GNT REG-0s\nRegistration Certificate\nReznraton Sumber\nConstitution of Business Proprietorship')
    ).toBe('GST');
  });

  it('reads a DL number printed with a space', () => {
    const f = checkDl('MAHARASHTRA STATE MOTOR DRIVING LICENCE\nDL No: MH12 2024009876501 DOI 15-08-2024\nCOV MCWG LMV', 8);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_DL_FORMAT']);
    expect(f[0].data).toMatchObject({ dl: 'MH122024009876501' });
  });

  it('classifies a DL by "Son/Daughter/Wife of" and reports letters in its digits as a misread', () => {
    const DLP = 'union of india Driving Licence\nKLDO7 2015004812\nSon/Daughter/Wife of\nRAVI KUMAR';
    expect(classifyPage(DLP)).toBe('DL');
    expect(checkDl(DLP, 10).map((x) => x.code)).toEqual(['REDFLAG_DL_UNREADABLE']);
  });

  it('passes a valid printed DL', () => {
    expect(checkDl('DRIVING LICENCE DL No: MH14 20110012345 COV LMV')).toEqual([]);
  });

  it('ignores a word after the DL label', () => {
    expect(checkDl('DRIVING LICENCE\nSTATE OF MAHARASHTRA', 2)).toEqual([]);
    expect(checkDl('DL No: CLAUSE 4 of the policy', 2)).toEqual([]);
  });
});

describe('client sheet 2026-10-31 - Aadhaar and VID', () => {
  const CARD =
    'GOVERNMENT OF INDIA\n1234 5678 9012\nUNIGUF IDENTIFICATION AUTHORITY OF INIA\nAddress: 1 MAIN ROAD\n71234 5678 9012';

  it('classifies a card whose title OCR garbled', () => {
    expect(classifyPage(CARD)).toBe('AADHAR');
  });

  it('flags an unlabelled 13-digit Aadhaar number', () => {
    expect(checkAadhaarFormat(CARD, 12)).toEqual([
      {
        code: 'REDFLAG_AADHAAR_FORMAT',
        severity: 'ERROR',
        message: 'Aadhaar number "71234 5678 9012" is 13 digits, not 12',
        page: 12,
        data: { aadhaar: '7123456789012' },
      },
    ]);
  });

  it('flags an unlabelled 11-digit Aadhaar number printed 4-4-3', () => {
    expect(
      checkAadhaarFormat(
        'Unique Identification Authority of India\nRAVI KUMAR\nDOB: 01/01/1980\nMALE\n2345 6789 012\nMera Aadhaar, Meri Pehchan',
        8,
      ),
    ).toEqual([
      {
        code: 'REDFLAG_AADHAAR_FORMAT',
        severity: 'ERROR',
        message: 'Aadhaar number "2345 6789 012" is 11 digits, not 12',
        page: 8,
        data: { aadhaar: '23456789012' },
      },
    ]);
  });

  it('does not read a VID or the toll-free number as a 13-digit Aadhaar', () => {
    expect(
      checkAadhaarFormat(
        'Unique Identification Authority of India\nAddress: 1 MAIN ROAD\n1234 5678 9012\nVID : 9123 4567 8901 2345\n1800 300 1947 help@uidai.gov.in',
        3,
      ),
    ).toEqual([]);
  });

  it('does not read phone numbers, a short VID or an enrolment number as a short Aadhaar', () => {
    expect(
      checkAadhaarFormat(
        'Unique Identification Authority of India\n2345 6789 0123\nMobile: 9876 5432 10\nPh: 0471 2345 678\nVID : 9123 4567 890\n1800 300 1947 help@uidai.gov.in\nEnrolment No: 1234/12345/12345',
        3,
      ),
    ).toEqual([]);
  });

  it('does not read the head of a longer number as a short Aadhaar', () => {
    expect(
      checkAadhaarFormat('Unique Identification Authority of India\n2345 6789 0123\n: /ID : 9123 4567 8 D9 1234', 3),
    ).toEqual([]);
  });

  it('flags a VID label with no digits read', () => {
    const f = checkVid('Unique Identification Authority of India\nVID:OQGESeS IRZ IM) 0', 5);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_VID_UNREADABLE']);
    expect(f[0].message).toBe('VID could not be read ("OQGESeS IRZ IM) 0"), possibly a scan misread, please confirm visually');
    expect(f[0].data).toEqual({ vid: 'OQGESeS IRZ IM) 0' });
  });

  it('counts a digit OCR read as $ and says the count first', () => {
    expect(checkVid('VID: 91234567 8901 $34', 7)).toEqual([
      {
        code: 'REDFLAG_VID_UNREADABLE',
        severity: 'ERROR',
        message: 'VID "91234567 8901 $34" is 15 digits, not 16 (one group is short), possibly a scan misread, please confirm visually',
        page: 7,
        data: { vid: '912345678901$34' },
      },
    ]);
  });

  it('reads no VID from consent or form prose', () => {
    for (const t of [
      'Unique Identification Authority of India\nI, the holder of Aadhaar number/VID, hereby give my consent to the use of my identity information with UIDAI',
      'Unique Identification Authority of India\nVID can be generated at uidai.gov.in',
      'Unique Identification Authority of India\nAadhaar/VID No. (optional) ____',
      'Unique Identification Authority of India\nVID : Not Available',
    ]) {
      expect(checkVid(t, 2)).toEqual([]);
    }
  });

  it('flags an unreadable VID after a Virtual ID label', () => {
    const f = checkVid('Unique Identification Authority of India\nVirtual ID : OQGESeS IRZ IM) 0', 5);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_VID_UNREADABLE']);
  });

  it('reads no unlabelled Aadhaar from a phone number labelled Tel', () => {
    expect(checkAadhaarFormat('Unique Identification Authority of India\n2345 6789 0123\nTel: 0471 2345 678', 3)).toEqual([]);
  });

  it('runs no unlabelled scan on a page that is not an ID card', () => {
    expect(NOT_AN_ID_CARD.test('Premium')).toBe(true);
    expect(checkAadhaarFormat('Unique Identification Authority of India\nPremium paid\n1234 5678 901', 3)).toEqual([]);
  });

  it('counts a $ digit in a VID printed beside the Aadhaar number', () => {
    expect(checkVid('Unique Identification Authority of India\nVID : 9123 4567 8901 $345 2345 6789 0123', 4)).toEqual([]);
  });

  it('flags 10 digits and leaves 14 alone', () => {
    const f = checkAadhaarFormat('Unique Identification Authority of India\nRAVI KUMAR\n2345 6789 01\nMALE', 4);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_AADHAAR_FORMAT']);
    expect(f[0].message).toBe('Aadhaar number "2345 6789 01" is 10 digits, not 12');
    expect(checkAadhaarFormat('Unique Identification Authority of India\nRAVI KUMAR\n23456 78901 2345\nMALE', 4)).toEqual([]);
  });

  it('skips a run with VID in the 30 characters before it', () => {
    expect(checkAadhaarFormat('Unique Identification Authority of India\nVID noted on the card below\n2345 6789 012', 4)).toEqual([]);
  });

  it('skips a run right after a digit', () => {
    expect(checkAadhaarFormat('Unique Identification Authority of India\n7 2345 6789 012', 4)).toEqual([]);
  });

  it('does not read the UIDAI helpline after help@uidai as an Aadhaar', () => {
    expect(checkAadhaarFormat('Unique Identification Authority of India\n2345 6789 0123\nhelp@uidai.gov.in 1800 300 1947', 3)).toEqual([]);
  });
});

describe('client sheet 2026-10-31 - Aadhaar pairing', () => {
  it("does not pair an e-Aadhaar letter with another person's card", () => {
    expect(
      checkAadhaar([
        { page: 8, text: 'Enrolment No: 0000/00000/00000\nDOB: 09/08/1975\nMale\nYour Aadhaar No.: 2345 1111 2222' },
        { page: 12, text: 'Envolment Ne 12345678\nYour Lata Ne\n5678 3333 4444' },
      ])
    ).toEqual([]);
  });

  it('pairs a back with its own front even when that front shows no number', () => {
    expect(
      checkAadhaar([
        { page: 6, text: 'DOB: 02/11/1981 Male 3456 1111 2222' },
        { page: 10, text: 'Enrollment No.: 1234/56789/00000\nDOB : 14/05 1981\nFemale' },
        { page: 11, text: 'Address: 1 MAIN ROAD\n1947 help@uidai.gov.in\n6789 3333 4444' },
      ])
    ).toEqual([]);
  });

  it('does not read an OCR-garbled enrolment number as an Aadhaar number', () => {
    expect(aadhaarNumbers('AvavEnroiment No. 112233445566 M8')).toEqual([]);
  });

  it('still flags a back two pages after its front that carries another number', () => {
    const f = checkAadhaar([
      { page: 1, text: 'DOB: 02/11/1981\nMale\n2345 1111 2222' },
      { page: 3, text: 'Address: 1 MAIN ROAD\n1947 help@uidai.gov.in\n6789 3333 4444' },
    ]);
    expect(f.map((x) => x.code)).toEqual(['REDFLAG_AADHAAR_MISMATCH']);
  });

  it('never pairs a page that prints a gender but no DOB read as a back', () => {
    expect(
      checkAadhaar([
        { page: 1, text: 'DOB: 02/11/1981\nMale\n2345 1111 2222' },
        { page: 3, text: 'Female\n5678 3333 4444' },
      ])
    ).toEqual([]);
  });
});

// Task 6b reuses MRZ: both MRZ lines are 44 characters and every check digit is valid.
const MRZ =
  '= R1234567\nSHARMA A\nNationality INDIAN\nP<INDSHARMA<<ANIL<<<<<<<<<<<<<<<<<<<<<<<<<<<\nR1234567<5IND8105141M3104013<<<<<<<<<<<<<<<2';

describe('client sheet 2026-10-31 - passport pages', () => {
  it('classifies a passport page by its MRZ line', () => {
    expect(classifyPage(MRZ)).toBe('PASSPORT');
  });

  it('classifies a passport page by an OCR-garbled MRZ prefix', () => {
    expect(classifyPage(MRZ.replace('P<IND', 'P<lND'))).toBe('PASSPORT');
    expect(classifyPage(MRZ.replace('P<IND', 'PKIND'))).toBe('PASSPORT');
  });

  it('still counts a passport present when its document holds a visa page', () => {
    expect(
      typePresent('Passport', 'PASSPORT', ['Republic of India Passport No R1234567 Nationality INDIAN\nVISA Passport No K7654321'])
    ).toBe(true);
  });

  it('classifies the passport back page', () => {
    expect(
      classifyPage('Name of Father / Legal Guardian\nRAVI SHARMA\nOld Passport No. with Date and Place of Issue\nFile No')
    ).toBe('PASSPORT');
  });

  it('does not take a KYC form for a passport', () => {
    expect(
      classifyPage(
        'Customer KYC Declaration\nID proof: Aadhaar / PAN / Passport No. / File No. (if any)\nName of Father / Legal Guardian ________'
      )
    ).not.toBe('PASSPORT');
  });

  it('notes a valid passport number', () => {
    expect(checkPassportNumber('Passport No: R1234567\nNationality INDIAN', 14)).toEqual([
      {
        code: 'REDFLAG_PASSPORT_OK',
        severity: 'INFO',
        message: 'Passport number "R1234567" format is valid (1 letter + 7 digits)',
        page: 14,
        data: { passport: 'R1234567' },
      },
    ]);
  });
});

describe('client sheet 2026-10-31 - passport MRZ', () => {
  const NEW =
    'P<INDSHARMA<<ANIL<<<<<<<<<<<<<<<<<<<<<<<<<<<\nN7654321<5IND8105141M3608153X000000000001<86';
  const OK = (num: string, page: number) => ({
    code: 'REDFLAG_PASSPORT_OK',
    severity: 'INFO',
    message: `Passport basic checks passed: number "${num}" is 1 letter + 7 digits and the MRZ check digits (number, date of birth, expiry, whole line) are valid`,
    page,
    data: { passport: num },
  });
  const UNSURE = (message: string) => ({
    code: 'REDFLAG_PASSPORT_MRZ_UNSURE',
    severity: 'INFO',
    message,
    page: 14,
    data: undefined,
  });
  const FOLDED = 'The MRZ was read with OCR corrections, so this may be a misread, please confirm visually';

  it('computes ICAO 9303 check digits', () => {
    expect(mrzCheckDigit('L898902C3')).toBe('6');
    expect(mrzCheckDigit('740812')).toBe('2');
    expect(mrzCheckDigit('120415')).toBe('9');
    expect(mrzCheckDigit('ZE184226B<<<<<')).toBe('1');
    expect(mrzCheckDigit('L898902C36' + '7408122' + '1204159ZE184226B<<<<<1')).toBe('0');
  });

  it('passes a passport whose MRZ check digits hold', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ }])).toEqual([OK('R1234567', 14)]);
    expect(checkPassportMrz([{ page: 3, text: NEW }])).toEqual([OK('N7654321', 3)]);
  });

  it('reads an MRZ through OCR noise', () => {
    const noisy = MRZ.replace('R1234567<5IND8105141', '~ R1234567<5INDB105141').replace(
      '<<<<<<<<<<<<<<<2',
      '<<<<<<K<<K<KK<LK<K<<2'
    );
    expect(checkPassportMrz([{ page: 14, text: noisy }])).toEqual([OK('R1234567', 14)]);
  });

  it('flags a check digit that fails on a clean read', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ.replace('8105141', '8105151') }])).toEqual([
      {
        code: 'REDFLAG_PASSPORT_MRZ',
        severity: 'ERROR',
        message: 'Passport MRZ check digit fails for: date of birth, whole line. The MRZ has been edited or misprinted',
        page: 14,
        data: { passport: 'R1234567', failed: ['date of birth', 'whole line'] },
      },
    ]);
  });

  it('only notes a failing check digit when the read needed an OCR fold', () => {
    expect(
      checkPassportMrz([{ page: 14, text: MRZ.replace('8105141', '8105151').replace('3104013', '31O4013') }])
    ).toEqual([UNSURE(`Passport MRZ check digit fails for: date of birth, whole line. ${FOLDED}`)]);
    expect(checkPassportMrz([{ page: 14, text: MRZ.replace('<<<<<<<<<<<<<<<2', '<<< 7') }])).toEqual([
      UNSURE(`Passport MRZ check digit fails for: whole line. ${FOLDED}`),
    ]);
  });

  it('notes an MRZ that cannot be read', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ.replace(/\nR1234567<5.*$/, '\nR12345 IND 81 <<<') }])).toEqual([
      UNSURE('Passport MRZ could not be read, so its check digits were not verified, please confirm visually'),
    ]);
  });

  it('flags a passport that had expired by the invoice date', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ }], new Date('2031-05-01'))).toEqual([
      {
        code: 'REDFLAG_PASSPORT_EXPIRED',
        severity: 'ERROR',
        message: 'Passport expired on 2031-04-01 (MRZ), before the invoice date 2031-05-01',
        page: 14,
        data: { passport: 'R1234567', expiry: '2031-04-01', invoiceDate: '2031-05-01' },
      },
    ]);
  });

  it('accepts a passport on its expiry day', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ }], new Date('2031-04-01'))).toEqual([OK('R1234567', 14)]);
  });

  it('does not flag an old passport filed with a valid new one', () => {
    expect(
      checkPassportMrz(
        [
          { page: 3, text: NEW },
          { page: 14, text: MRZ },
        ],
        new Date('2031-05-01')
      )
    ).toEqual([OK('N7654321', 3), OK('R1234567', 14)]);
  });

  it('treats a misaligned or misread personal-number tail as an OCR fold', () => {
    const WHOLE = `Passport MRZ check digit fails for: whole line. ${FOLDED}`;
    expect(checkPassportMrz([{ page: 14, text: MRZ.replace('<<<<<<<<<<<<<<<2', '<<<<<<<<<<<<<<2 1') }])).toEqual([
      UNSURE(WHOLE),
    ]);
    expect(checkPassportMrz([{ page: 3, text: NEW.replace('0001<86', '0001L86') }])).toEqual([
      { ...UNSURE(WHOLE), page: 3 },
    ]);
    expect(checkPassportMrz([{ page: 3, text: NEW }])).toEqual([OK('N7654321', 3)]);
  });

  it('checks every MRZ on a page and spares an old passport filed with a new one', () => {
    expect(checkPassportMrz([{ page: 14, text: MRZ + '\n' + NEW }], new Date('2031-05-01'))).toEqual([
      OK('R1234567', 14),
      OK('N7654321', 14),
    ]);
  });

  it('folds a digit read in a letter position of the passport number', () => {
    // Line 2 for "S1234567": every check digit computed with mrzCheckDigit.
    const body = 'S1234567<';
    const dob = '810514';
    const exp = '310401';
    const pre = body + mrzCheckDigit(body) + 'IND' + dob + mrzCheckDigit(dob) + 'M' + exp + mrzCheckDigit(exp) + '<'.repeat(15);
    const line2 = pre + mrzCheckDigit(pre.slice(0, 10) + pre.slice(13, 20) + pre.slice(21, 28) + '<'.repeat(15));
    const line1 = MRZ.split('\n')[3];
    expect(checkPassportMrz([{ page: 2, text: line1 + '\n' + line2 }])).toEqual([OK('S1234567', 2)]);
    expect(checkPassportMrz([{ page: 2, text: line1 + '\n' + line2.replace('S1234567', '51234567') }])).toEqual([
      OK('S1234567', 2),
    ]);
  });

  it('judges no expiry when the expiry check digit fails', () => {
    const out = checkPassportMrz([{ page: 14, text: MRZ.replace('3104013', '3104015') }], new Date('2031-05-01'));
    expect(out.map((f) => f.code)).not.toContain('REDFLAG_PASSPORT_EXPIRED');
    expect(out.map((f) => f.code)).toContain('REDFLAG_PASSPORT_MRZ');
  });

  // The highlight boxes the first data value, so the passport number must come first.
  it('puts the passport number first in the MRZ and expiry findings', () => {
    const [mrz] = checkPassportMrz([{ page: 14, text: MRZ.replace('8105141', '8105151') }]);
    const [expired] = checkPassportMrz([{ page: 14, text: MRZ }], new Date('2031-05-01'));
    expect(Object.keys(mrz.data ?? {})[0]).toBe('passport');
    expect(Object.keys(expired.data ?? {})[0]).toBe('passport');
  });

  it('leaves the number note to the MRZ on an MRZ page', () => {
    expect(checkPassportNumber(MRZ, 14)).toEqual([]);
  });

  it('still compares the printed number with the MRZ number', () => {
    const out = checkPassportPages([{ page: 14, text: MRZ.replace('= R1234567', '= R1234568') }]);
    expect(out).toHaveLength(1);
    expect(out[0].code).toBe('REDFLAG_PASSPORT_MISMATCH');
    expect(out[0].message).toBe('Passport number differs across pages (R1234568, R1234567)');
  });
});

describe('client sheet 2026-10-31 - Aadhaar check digit', () => {
  // Decision 7: exact only when META kept the page's own text layer AND the reader sees it, with no
  // hidden (OCR) layer on the page. Every other combination is an OCR guess.
  it('takes a read as clean only from a visible text layer with no hidden layer', () => {
    expect(cleanRead(true, { visibleText: true, hiddenText: false })).toBe(true);
    expect(cleanRead(true, { visibleText: true, hiddenText: true })).toBe(false);
    expect(cleanRead(true, { visibleText: false, hiddenText: false })).toBe(false);
    expect(cleanRead(false, { visibleText: true, hiddenText: false })).toBe(false);
    expect(cleanRead(true, undefined)).toBe(false);
  });

  const FRONT = 'Unique Identification Authority of India\nDOB: 01/01/1980\nMALE\n2341 2341 2347';
  const BACK = 'Address: 1 MAIN ROAD\n1947 help@uidai.gov.in\n2341 2341 2347';
  const MSG = 'Aadhaar number 234123412347 fails the Aadhaar check digit';

  it('implements the Verhoeff check', () => {
    expect(['2363', '123451', '1428570', '234123412346'].every(verhoeffOk)).toBe(true);
    expect(['123452', '234123412347'].some(verhoeffOk)).toBe(false);
  });

  it('flags a failing number read from a visible text layer', () => {
    expect(checkAadhaarChecksum([{ documentId: 'd1', page: 3, text: FRONT, clean: true }])).toEqual([
      {
        documentId: 'd1',
        finding: {
          code: 'REDFLAG_AADHAAR_CHECKSUM',
          severity: 'ERROR',
          page: 3,
          message: `${MSG}, so it is not a valid Aadhaar number`,
          data: { aadhaar: '234123412347' },
        },
      },
    ]);
  });

  it('flags a failing number that two OCR reads agree on', () => {
    const out = checkAadhaarChecksum([
      { documentId: 'd1', page: 5, text: FRONT, clean: false },
      { documentId: 'd1', page: 6, text: BACK, clean: false },
    ]);
    expect(out.map((o) => [o.finding.code, o.finding.severity, o.finding.page])).toEqual([
      ['REDFLAG_AADHAAR_CHECKSUM', 'ERROR', 5],
    ]);
  });

  it('only notes a failing number read once by OCR', () => {
    const out = checkAadhaarChecksum([{ documentId: 'd1', page: 5, text: FRONT, clean: false }]);
    expect(out).toHaveLength(1);
    expect(out[0].finding).toMatchObject({
      code: 'REDFLAG_AADHAAR_CHECKSUM_UNSURE',
      severity: 'INFO',
      page: 5,
      message: `${MSG}; it was read once by OCR, so it may be a misread, please confirm visually`,
    });
  });

  it('passes a valid number', () => {
    expect(
      checkAadhaarChecksum([{ documentId: 'd1', page: 3, text: FRONT.replace('2347', '2346'), clean: true }])
    ).toEqual([]);
  });

  it("does not read a date's year as the start of an Aadhaar number", () => {
    expect(aadhaarNumbers('Date of Birth 01/01/1985 1234 5678 Male')).toEqual([]);
  });

  it('reads no phone or toll-free number after an Aadhaar label as an Aadhaar number', () => {
    const head = 'Unique Identification Authority of India\n';
    for (const text of [
      `${head}I authorise e-KYC with UIDAI. Mobile: +91 98765 43210`,
      `${head}Aadhaar linked mobile: +91 98765 43210`,
      `${head}For Aadhaar seeding call toll free 1800 2345 6781`,
    ]) {
      expect(checkAadhaarChecksum([{ documentId: 'd1', page: 2, text, clean: true }])).toEqual([]);
    }
  });

  it('checks a number only the Aadhaar label reads', () => {
    const out = checkAadhaarChecksum([
      { documentId: 'd1', page: 2, text: 'Unique Identification Authority of India\nAadhaar No: 23 41234 12347', clean: true },
    ]);
    expect(out.map((r) => r.finding.code)).toEqual(['REDFLAG_AADHAAR_CHECKSUM']);
  });

  it('counts the same scan uploaded twice as one read', () => {
    const out = checkAadhaarChecksum([
      { documentId: 'd1', page: 5, text: FRONT, clean: false },
      { documentId: 'd2', page: 1, text: FRONT, clean: false },
    ]);
    expect(out.map((r) => r.finding.code)).toEqual(['REDFLAG_AADHAAR_CHECKSUM_UNSURE']);
  });

  it('keeps a valid number behind a stray slash', () => {
    expect(aadhaarNumbers('MALE\n/ 4132 9642 2840')).toEqual(['413296422840']);
  });

  it('reads no Aadhaar check digit from a page that is not an ID card', () => {
    const text = 'Unique Identification Authority of India\nPolicy No: 5\nPremium paid\n2341 2341 2347';
    expect(NOT_AN_ID_CARD.test(text)).toBe(true);
    expect(checkAadhaarChecksum([{ documentId: 'd1', page: 2, text, clean: true }])).toEqual([]);
  });
});

describe('client sheet 2026-10-31 - final review fixes', () => {
  const govt = (text: string) => classifyPage(text);

  it('C1: a name that starts "P K IND" is not a passport page', () => {
    for (const t of [
      'TAX INVOICE\nBill To: P K INDIRA\nInvoice No: INV-1',
      'PK INDUSTRIES\nTAX INVOICE',
      'PKINDUSTRIES',
      'P K INDANE GAS AGENCY',
      'P K INDIA LLP KOLKATA',
    ]) expect(govt(t)).not.toBe('PASSPORT');
  });

  it('C1: an MRZ with K for < is still a passport page', () => {
    for (const t of ['PKINDSHARMA<<ANIL<<<<<<', 'PKINDSHARMAKKANILKKKKKKK', 'P<lNDSHARMA<<ANIL<<<<'])
      expect(govt(t)).toBe('PASSPORT');
  });

  it('C1: an invoice name yields no PASSPORT_NO identifier', () => {
    const ids = extractIdentifiers('TAX INVOICE\nBill To: P K INDIRA\nReceipt Ref: R1234567');
    expect(ids.filter((i) => i.field === 'PASSPORT_NO')).toEqual([]);
  });

  const sums = (reads: Parameters<typeof checkAadhaarChecksum>[0]) =>
    checkAadhaarChecksum(reads).map((o) => [o.finding.severity, o.finding.data?.aadhaar]);

  it('I1: a loan application number read twice stays INFO', () => {
    const a = 'TWO WHEELER LOAN APPLICATION\nApplication No 202410150001\nKYC documents: Aadhaar card, PAN card';
    const b = 'TWO WHEELER LOAN APPLICATION\nApplication No 202410150001\nResidential Address: 1 MAIN ROAD INDORE';
    expect(verhoeffOk('202410150001')).toBe(false);
    expect(sums([
      { documentId: 'd1', page: 1, text: a, clean: false },
      { documentId: 'd1', page: 2, text: b, clean: false },
    ])).toEqual([['INFO', '202410150001']]);
  });

  it('I1: an account number beside a good Aadhaar is INFO only', () => {
    expect(verhoeffOk('234123412346')).toBe(true);
    expect(verhoeffOk('123456789012')).toBe(false);
    const t = 'Aadhaar No: 2341 2341 2346\nBank Account Number (as per cancelled cheque): 123456789012';
    expect(sums([{ documentId: 'd1', page: 1, text: t, clean: true }])).toEqual([['INFO', '123456789012']]);
  });

  it('I1: a card-shaped failing number read cleanly stays ERROR', () => {
    expect(verhoeffOk('234123412341')).toBe(false);
    const t = 'Unique Identification Authority of India\nMALE\n2341 2341 2341';
    expect(sums([{ documentId: 'd1', page: 1, text: t, clean: true }])).toEqual([['ERROR', '234123412341']]);
  });

  describe('I2: PAN 5th letter after a name change', () => {
    const card = (father: string) =>
      `INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPV1234K\nName\nPRIYA SHARMA\nFather's Name\n${father}\nDate of Birth\n01-01-1990`;
    it('accepts the father surname letter', () => {
      expect(checkPan(card('RAVI VERMA')).map((f) => f.code)).not.toContain('REDFLAG_PAN_NAME_LETTER');
    });
    it('still reds when neither name has the letter', () => {
      expect(checkPan(card('RAVI KUMAR')).map((f) => f.code)).toContain('REDFLAG_PAN_NAME_LETTER');
    });
  });

  it('M5: a landline is not an unlabelled Aadhaar number', () => {
    const t = 'Unique Identification Authority of India\nAddress: 12 MG ROAD INDORE 452001\n0731 2345 678';
    expect(checkAadhaarFormat(t).map((f) => f.code)).toEqual([]);
  });

  it('M6: a blank VID form field is no VID read', () => {
    expect(checkVid('Aadhaar consent form\nVID: ____________ Date: 01/01/2024')).toEqual([]);
  });

  describe('M7: renewed passport back page', () => {
    const p1 = { page: 1, text: 'REPUBLIC OF INDIA\nPassport No. R1234567\nP<INDSHARMA<<ANIL<<<' };
    it('skips the old passport number', () => {
      const p2 = { page: 2, text: 'Name of Father / Legal Guardian\nOld Passport No. with Date and Place of Issue\nJ7654321 01/01/2010 DELHI\nFile No. DL1234567890123' };
      expect(checkPassportPages([p1, p2])).toEqual([]);
    });
    it('still flags a different current number', () => {
      const p2 = { page: 2, text: 'Passport No. J7654321\nFile No. DL1234567890123' };
      expect(checkPassportPages([p1, p2]).map((f) => f.code)).toEqual(['REDFLAG_PASSPORT_MISMATCH']);
    });
    it('skips only the first number after the old-passport label', () => {
      const p2 = { page: 2, text: 'Old Passport No: J7654321 Passport No. K1111111' };
      expect(checkPassportPages([p1, p2])[0]?.data).toEqual({ values: ['R1234567', 'K1111111'] });
    });
  });
});
