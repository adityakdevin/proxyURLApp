/** Regressions from the client QA summary report of 2026-10 ("Summary Report - Software
 *  Testing"): Red Flags points 1-6 and Missing Docs points 7-12. */
import { checkPan, checkVid, checkDates, checkVoterId, aadhaarNumbers } from '../redFlagLogic.js';
import { typePresent } from '../logic.js';
import { classify, ClassifiableType } from '../../services/documentClassifier.js';

describe('client QA 2026-10 — Red Flags', () => {
  it('#1 a VID is not extended by a digit printed on the next line', () => {
    expect(checkVid('VID : 9150 6457 2260 8544\n1 Jan 1990')).toEqual([]);
    expect(checkVid('VID: 9150 6457 2260 8544 12/03/2024')).toEqual([]);
  });
  it('#1 an irregularly grouped VID one digit off is unreadable, not a red flag', () => {
    const [f] = checkVid('VID : 9150 6457 226 08544 3');
    expect(f?.severity ?? 'none').not.toBe('ERROR');
  });
  it('#1 a genuinely short, regularly grouped VID is still flagged', () => {
    expect(checkVid('VID : 9150 6457 2260')[0].code).toBe('REDFLAG_VID_FORMAT');
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
