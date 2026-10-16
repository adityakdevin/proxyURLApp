/** Regressions from the client QA summary report of 2026-10 ("Summary Report - Software
 *  Testing"): Red Flags points 1-6 and Missing Docs points 7-12. */
import { checkGst, checkPan, checkVid, checkDates, checkVoterId, checkAadhaar, aadhaarNumbers, gstCheckChar } from '../redFlagLogic.js';
import { typePresent } from '../logic.js';
import { classify, ClassifiableType } from '../../services/documentClassifier.js';

describe('client QA 2026-10 — Red Flags', () => {
  it('#1 a VID is not extended by a digit printed on the next line', () => {
    expect(checkVid('VID : 9876 5432 1098 7654\n1 Jan 1990')).toEqual([]);
    expect(checkVid('VID: 9876 5432 1098 7654 12/03/2024')).toEqual([]);
  });
  it('#1 an irregularly grouped VID one digit off with 16 digits is accepted', () => {
    const [f] = checkVid('VID : 9876 5432 109 87654 3');
    expect(f?.severity ?? 'none').not.toBe('ERROR');
  });
  it('#1 a stray 1-2 digit tail after a 16-digit VID is card-edge noise', () => {
    expect(checkVid('© VID: 9123456789012345 1')).toEqual([]);
    expect(checkVid('© VID:91234567 89012345 4')).toEqual([]);
    // A digit run JOINED to the last group is not a stray tail: still not passed.
    expect(checkVid('VID : 9111 2222 3333 44441')).not.toEqual([]);
  });
  it('#1 one clean VID line on the page settles it', () => {
    // OCR garbled the first VID line and read the second cleanly.
    expect(checkVid('VID; 11122223333 4444 H security\n7000 1111 2222 3] VID : 9111 2222 3333 4444')).toEqual([]);
  });
  it('#1 a 15- or 17-digit VID with odd grouping is a visible possible misread', () => {
    const [f] = checkVid('VID : 9876 5432 109 8765');
    expect(f).toMatchObject({ code: 'REDFLAG_VID_UNREADABLE', severity: 'ERROR' });
    expect(f.message).toContain('possibly a scan misread');
  });
  it('#1 a genuinely short, regularly grouped VID is still flagged', () => {
    expect(checkVid('VID : 9876 5432 1098')[0].code).toBe('REDFLAG_VID_FORMAT');
  });
  it('#4 two people\'s Aadhaar cards on separate pages are not a mismatch', () => {
    expect(checkAadhaar([
      { page: 7, text: 'DOB: 15/06/1985 Male 5678 1234 9012' },
      { page: 11, text: 'DOB 20/03/1987 Male 6789 2345 0123' },
    ])).toEqual([]);
  });
  it('#4 front and back of one card that disagree are still a red flag', () => {
    expect(checkAadhaar([
      { page: 7, text: 'DOB: 15/06/1985 Male 5678 1234 9012' },
      { page: 8, text: 'Address UIDAI 6789 2345 0123' },
    ])[0].code).toBe('REDFLAG_AADHAAR_MISMATCH');
  });
  it('#4 one person\'s cards far apart with different numbers are still a red flag', () => {
    expect(checkAadhaar([
      { page: 3, text: 'DOB: 15/06/1985 Male 5678 1234 9012' },
      { page: 12, text: 'DOB: 15/06/1985 Male 6789 2345 0123' },
    ])[0].code).toBe('REDFLAG_AADHAAR_MISMATCH');
  });
  it('#4 a back side far from its front is still compared with it', () => {
    expect(checkAadhaar([
      { page: 2, text: 'DOB: 15/06/1985 Male 5678 1234 9012' },
      { page: 6, text: 'Address UIDAI 6789 2345 0123' },
    ])[0]?.code).toBe('REDFLAG_AADHAAR_MISMATCH');
    // Two people's fronts, each with its own birth date, are still not paired.
    expect(checkAadhaar([
      { page: 2, text: 'DOB: 15/06/1985 Male 5678 1234 9012' },
      { page: 6, text: 'DOB: 20/03/1987 Male 6789 2345 0123' },
    ])).toEqual([]);
  });
  it('#4 a one-digit difference on one card is flagged, worded as a possible misread', () => {
    const [f] = checkAadhaar([{ page: 9, text: '9871 2345 6012 Aadhaar 0871 2345 6012' }]);
    expect(f.severity).toBe('ERROR');
    expect(f.message).toContain('possibly one scan misread');
  });
  it('#2 a GSTIN with a 7 read as T is a misread, not malformed', () => {
    expect(checkGst('GSTIN: 36AAACKT904GIZO', 3)[0].code).toBe('REDFLAG_GST_UNREADABLE');
    // Shown as a red flag worded as a possible misread: hidden warnings would let it pass.
    expect(checkGst('GSTIN: 36AAACKT904GIZO', 3)[0].severity).toBe('ERROR');
  });
  it('#6 a money amount is not a date', () => {
    expect(checkDates('LWP 0.00/0.00 Basic 25,000.00')).toEqual([]);
    expect(checkDates('DOB 31/02/1990')[0].code).toBe('REDFLAG_BAD_DATE');
    // A dot after a label is not inside a number: the date is still checked.
    expect(checkDates('Dt.31/02/2024')[0]?.code).toBe('REDFLAG_BAD_DATE');
  });
  it('#3 two EPIC reads one digit apart are flagged, worded as a possible misread', () => {
    const [f] = checkVoterId([
      { page: 15, text: 'ELECTION COMMISSION OF INDIA ABX1234565' },
      { page: 16, text: 'Elector address ABX1234569' },
    ]);
    expect(f.severity).toBe('ERROR');
    expect(f.message).toContain('possibly one scan misread');
  });
  it('#3 Voter ID sides that agree do not mismatch', () => {
    expect(checkVoterId([
      { page: 1, text: 'ELECTION COMMISSION OF INDIA ABC1234567' },
      { page: 2, text: 'ABC1234567 Address' },
    ]).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });
  it('#4 a UAN, policy or invoice number is not read as an Aadhaar number', () => {
    expect(aadhaarNumbers('Date of Birth 01/01/1990 UAN : 1012 3456 7890')).toEqual([]);
    expect(aadhaarNumbers('Invoice No. 2024 0000 1234')).toEqual([]);
    expect(aadhaarNumbers('Emp Code 2024 2025 0123')).toEqual([]);
    expect(aadhaarNumbers('Aadhaar 2345 6789 0123')).toEqual(['234567890123']);
  });
  it('#5 "PAN Services Unit" is not read as a PAN number', () => {
    expect(checkPan('Income Tax PAN Services Unit, NSDL ABCPD1234E')[0].code).toBe('REDFLAG_PAN_OK');
    expect(checkPan('Income Tax PAN Services Unit, NSDL')).toEqual([]);
    expect(checkPan('PAN: ABCP1234E')[0].code).toBe('REDFLAG_PAN_FORMAT');
  });
  it('#6 a five-digit year is an impossible date, on its page', () => {
    const [f] = checkDates('DOB 19.10.20000', 2);
    expect(f.code).toBe('REDFLAG_BAD_DATE');
    expect(f.page).toBe(2);
  });
  it('#6 a phone number is still not read as a date', () => {
    expect(checkDates('+91-20-2721 8080 or 011-23-45678')).toEqual([]);
  });
});

// Value: protects=a valid GSTIN misread by OCR passes once its check char agrees, a wrong one stays red and boxable, Voter "Back side NA" only when no back, no date from a digit chain; fails_when=the checksum is skipped or alternatives are tried (a forged GSTIN passes), the EPIC/back wording on one page is ignored, a chain fragment is read as a date; why_new=client QA rows 2-3 and 004536 p1 reported these on real claims; seam=none; no_claim=OCR quality
describe('client QA 2026-10 — GSTIN misreads, Voter back side, date fragments', () => {
  it('computes the GSTIN check char (CBIC mod-36)', () => {
    for (const g of ['36AAACI7904G1ZO', '24AABCB5730G1Z3', '37AABCT3518Q1ZV', '29AAACN4165C2ZM']) expect(gstCheckChar(g)).toBe(g[14]);
  });
  it('#2 a valid GSTIN misread by OCR is accepted (313242, 650930, 004536, 648914)', () => {
    for (const read of ['36AAACITH04GIZO', '36AAACIT904GIZO', '36AABCBST30GIZY', '24AABCBS730G1Z3', '27AACCOA128Q1Z0']) {
      expect(checkGst(`Servicing Branch GSTIN No. : ${read} PAN No.:`, 3)).toEqual([]);
    }
  });
  it('#2 a misread whose check char disagrees stays red and carries the value to box', () => {
    // I read as K: a letter for a letter, which no fold can undo, so the check char cannot agree.
    expect(checkGst('GSTIN: 36AAACKT904GIZO', 3)).toEqual([
      expect.objectContaining({ code: 'REDFLAG_GST_UNREADABLE', severity: 'ERROR', data: { gst: '36AAACKT904GIZO' } }),
    ]);
  });
  it('#2 a wrong GSTIN garbled the same way is still red', () => {
    // 36AAACI7904G1ZO with the 9 changed to 8, then OCR'd like the real one.
    expect(checkGst('GSTIN: 36AAACIT804GIZO', 3)[0]?.severity).toBe('ERROR');
    expect(checkGst('GSTIN: 35AAACIT904GIZO', 3)[0]?.severity).toBe('ERROR');
  });
  it('#3 both sides of a Voter ID on one page are not "Back side NA" (648914 p8)', () => {
    expect(checkVoterId([{ page: 8, text: 'ELECTION COMMISSION OF INDIA XYZ7654320 Address: 5-34 Station Road XYZ7654320' }])).toEqual([]);
    // The back's EPIC unread, its wording still there.
    expect(checkVoterId([{ page: 8, text: 'ELECTION COMMISSION OF INDIA XYZ7654320 For 169-Bardoli Constituency Facsiflk Signatur' }])).toEqual([]);
  });
  it('#3 a front alone is still "Back side NA"', () => {
    expect(checkVoterId([{ page: 8, text: "ELECTION COMMISSION OF INDIA XYZ7654320 Elector's Name Patel" }])[0]?.code).toBe('REDFLAG_VOTER_BACK_NA');
  });
  it('a two-digit "year" with more digits chained on is not a date (004536 p1)', () => {
    expect(checkDates('To. Date. 41/30/04/2020')).toEqual([]);
    expect(checkDates('SIMHA MOTORS, 48/10/12/1, SERVICE ROAD')).toEqual([]);
    expect(checkDates('Subject to IMT Endt. Nos.& Memorandum: 16.17.22.28')).toEqual([]);
    expect(checkDates('TPPD 1 Sum Insured - 7.50.000/-')).toEqual([]);
  });
  // Value: protects=an impossible date opening a hyphenated range, or sitting behind stray
  // digits, is still red; fails_when=the fragment skip swallows a range or does not resume at
  // the second number; why_new=only four-digit ranges and pure fragments were tested (ship
  // review 2026-10-16); seam=none; no_claim=OCR fragment shapes beyond these
  it('a two-digit-year range, and a date behind stray digits, are still checked', () => {
    expect(checkDates('Period 31/02/24-01/03/25')[0]?.data).toEqual({ date: '31/02/24' });
    expect(checkDates('Period 01/04/24-31/03/25')).toEqual([]);
    expect(checkDates('To. Date. 41/31/02/2024')[0]?.data).toEqual({ date: '31/02/2024' });
    // ...but a two-digit piece read out of the same chain is still the chain (673493 p1).
    expect(checkDates('H NO 4-6-90/19 X')).toEqual([]);
    // A day and month that could be one are a date whatever is joined on; a dotted date behind
    // stray digits is checked like a slashed one.
    expect(checkDates('Date 31/02/24-10:30')[0]?.data).toEqual({ date: '31/02/24' });
    expect(checkDates('Period 31-02-24-01-03-25')[0]?.data).toEqual({ date: '31-02-24' });
    expect(checkDates('Dt 41.31.02.2024')[0]?.data).toEqual({ date: '31.02.2024' });
  });
  // Value: protects=an impossible date with a time, serial or digit joined on is red, as on main;
  // fails_when=the fragment rule goes back to "anything after a two-digit year" (each of these
  // passed silently); why_new=only a colon time and a dash date were covered (ship review r3,
  // 2026-10-17); seam=none; no_claim=OCR fragment shapes beyond these
  it('an impossible date with anything joined on is still checked', () => {
    for (const [text, date] of [
      ['Date: 31/02/24-10.30 AM', '31/02/24'],
      ['Date: 31/02/24-1030Hrs', '31/02/24'],
      ['Date 31.02.24.10.30', '31.02.24'],
      ['Receipt 29/02/23-5PM', '29/02/23'],
      ['Inv Dt 31/02/24/0012', '31/02/24'],
      ['Dt.31/02/24-1', '31/02/24'],
      ['41/31/02/24', '31/02/24'],
    ]) {
      expect(checkDates(text).map((f) => f.data?.date)).toEqual([date]);
    }
    // ...while a real day and month read out of a longer number stays quiet, as on main.
    expect(checkDates('Section 5.31.11.2024')).toEqual([]);
    expect(checkDates('Amt 1.30.02.2024')).toEqual([]);
  });
  it('real impossible dates are still flagged', () => {
    expect(checkDates('Date 31/02/24')[0]?.code).toBe('REDFLAG_BAD_DATE');
    expect(checkDates('DOB 19.10.20000')[0]?.code).toBe('REDFLAG_BAD_DATE');
    // The second date of a range is not a chain fragment.
    expect(checkDates('Period 01/04/2024-31/04/2025')[0]?.data).toEqual({ date: '31/04/2025' });
  });
});

describe('client QA 2026-10 — Missing Docs', () => {
  it('#7-12 a payslip that mentions Aadhaar / UAN is not an Aadhaar card', () => {
    const payslip = ['SALARY SLIP Earnings Deductions Net Pay Date of Birth 01/01/1990 Male UAN 1012 3456 7890 Aadhaar No 2345 6789 0123'];
    expect(typePresent('Aadhar Card', 'AADHAR', payslip)).toBe(false);
  });
  it('#7-12 a dealer invoice printing "Permanent Account Number" is not a PAN card', () => {
    expect(typePresent('PAN Card', 'PAN', ['TAX INVOICE Invoice No 123 Permanent Account Number AAACP1234Q'])).toBe(false);
  });
  it('#7-12 a blurry PAN card without its header still counts', () => {
    expect(typePresent('PAN Card', 'PAN', ["RAM KUMAR Father's Name SHYAM KUMAR 01/01/1990 ABCPK1234E"])).toBe(true);
  });
  it('#7-12 a real Aadhaar card still counts', () => {
    expect(typePresent('Aadhar Card', 'AADHAR', ['Ram Kumar DOB: 01/01/1990 Male 2345 6789 0123'])).toBe(true);
    expect(typePresent('Aadhar Card', 'AADHAR', ['Government of India Aadhaar 2345 6789 0123'])).toBe(true);
  });

  const types: ClassifiableType[] = [
    { id: 'pan', name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', displayOrder: 3 },
    { id: 'aadhar', name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', displayOrder: 2 },
  ];
  it.each(['Insurance Company.pdf', 'Pankaj_salary.pdf', 'Japan.pdf'])('filename %s is not a PAN card', (f) => {
    expect(classify(f, types)).toBeNull();
  });
  it.each(['PAN.pdf', 'PANCARD.pdf', 'pan_front.jpg', 'Ram PAN Card.pdf', 'customerPan.pdf'])('filename %s is a PAN card', (f) => {
    expect(classify(f, types)).toBe('pan');
  });
  it('filename aadhaar_card.pdf is still an Aadhaar card', () => {
    expect(classify('aadhar_card.pdf', types)).toBe('aadhar');
  });
  // Review 2026-10-13: run-together lower-case names still classify by a long type name.
  const more: ClassifiableType[] = [
    ...types,
    { id: 'inv', name: 'Invoice', category: 'CUSTOM', govtCode: null, displayOrder: 5 },
    { id: 'rc', name: 'Registration Certificate', category: 'GOVT', govtCode: 'RC', displayOrder: 4 },
  ];
  it.each([['taxinvoice.pdf', 'inv'], ['customerinvoice.pdf', 'inv'], ['RCBook.pdf', 'rc']])('filename %s is classified', (f, id) => {
    expect(classify(f, more)).toBe(id);
  });
  it('a short code at the end of another word still does not classify', () => {
    expect(classify('Japan.pdf', more)).toBeNull();
  });
});
