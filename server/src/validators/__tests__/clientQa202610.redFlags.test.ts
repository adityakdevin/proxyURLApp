/** Regressions from the client QA summary report of 2026-10 ("Summary Report - Software
 *  Testing"): Red Flags points 1-6 and Missing Docs points 7-12. */
import { checkGst, checkPan, checkVid, checkDates, checkVoterId, checkAadhaar, aadhaarNumbers } from '../redFlagLogic.js';
import { typePresent } from '../logic.js';
import { classify, ClassifiableType } from '../../services/documentClassifier.js';

describe('client QA 2026-10 — Red Flags', () => {
  it('#1 a VID is not extended by a digit printed on the next line', () => {
    expect(checkVid('VID : 9876 5432 1098 7654\n1 Jan 1990')).toEqual([]);
    expect(checkVid('VID: 9876 5432 1098 7654 12/03/2024')).toEqual([]);
  });
  it('#1 an irregularly grouped VID one digit off is unreadable, not a red flag', () => {
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
  it('#4 a one-digit difference on one card is flagged, worded as a possible misread', () => {
    const [f] = checkAadhaar([{ page: 9, text: '9871 2345 6012 Aadhaar 0871 2345 6012' }]);
    expect(f.severity).toBe('ERROR');
    expect(f.message).toContain('possibly one scan misread');
  });
  it('#2 a GSTIN with a 7 read as T is a misread, not malformed', () => {
    expect(checkGst('GSTIN: 36AAACKT904GIZO', 3)[0].code).toBe('REDFLAG_GST_UNREADABLE');
  });
  it('#6 a money amount is not a date', () => {
    expect(checkDates('LWP 0.00/0.00 Basic 25,000.00')).toEqual([]);
    expect(checkDates('DOB 31/02/1990')[0].code).toBe('REDFLAG_BAD_DATE');
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
});
