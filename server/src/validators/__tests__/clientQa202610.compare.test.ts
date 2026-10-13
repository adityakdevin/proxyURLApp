/** Regressions from the client QA summary report of 2026-10: Duplicate (#13-19) and Data
 *  Compare (#20-32) extraction gaps. */
import { crossDocFieldFindings, extractField, extractNames, extractVehicleNos, nameMatches } from '../crossDocLogic.js';
import { extractIdentifiers } from '../dupIdentifiers.js';

const uans = (t: string) => extractIdentifiers(t).filter((i) => i.field === 'UAN').map((i) => i.value);

describe('client QA 2026-10 — Duplicate', () => {
  it('#13 a grouped UAN is read', () => {
    expect(uans('UAN No. : 1012 3456 7890')).toEqual(['101234567890']);
    expect(uans('UAN: 101234567890')).toEqual(['101234567890']);
  });
  it('#13 account numbers with "No." or no separator are read', () => {
    expect(extractField('ACCOUNT_NO', 'A/c No. : 1234 5678 9012')).toEqual(['1234 5678 9012']);
    expect(extractField('ACCOUNT_NO', 'Account No 50100234567890')).toEqual(['50100234567890']);
    expect(extractField('ACCOUNT_NO', 'Contact No: 9000000001')).toEqual([]);
  });
  it('#16 the next table column is not part of the account number', () => {
    expect(extractField('ACCOUNT_NO', 'Bank A/C No 09876543210987 31.00 31.00 0.00')).toEqual(['09876543210987']);
  });
  it('#16 an employee code after "Employee No." is read', () => {
    expect(extractField('EMP_CODE', 'Employee No. : E1234')).toEqual(['E1234']);
  });
  it('#18/19 dealer and payer names are not customers', () => {
    expect(extractNames('MISP Name : PARASAVNATH AUTOWHEELS')).toEqual([]);
    expect(extractNames('M1SP Name : PARASAVNATH AUTOWHEELS')).toEqual([]);
    expect(extractNames('Payer Name : DRIVE N RIDE')).toEqual([]);
    // As OCR actually printed the MISP label.
    expect(extractNames('| MIS Name : PARASAVNATI AUTOWIEELS Tor & On Behalf of')).toEqual([]);
    expect(extractNames('| MSP Name : PARASAVNATH AUTOWHEELS Tor & On Behalf of')).toEqual([]);
    expect(extractNames('Insured Name : AMAN SINGH')).toEqual(['AMAN SINGH']);
  });
});

describe('client QA 2026-10 — Data Compare', () => {
  it('#20 an insured name after an OCR "+" separator, and a misread "Bill To", are read', () => {
    expect(extractNames("Insured's Name + MR. PREM Period of Third Party")).toEqual(['PREM']);
    expect(extractNames('Bil 10 PREM Customer 1d L')).toEqual(['PREM']);
  });
  it('#23/#25 OCR and naming variants of one person match', () => {
    expect(nameMatches('Raiesh Kumar Son', 'RAJESH KUMAR SONI')).toBe(true);
    expect(nameMatches('Lt. Harisunder', 'Shri Hari Sunder Mishra')).toBe(true);
    expect(nameMatches('MAHESH V G', 'MAHEESHV G')).toBe(true);
    expect(nameMatches('Harisunder', 'Ram Sunder Mishra')).toBe(false);
    // The clipped-letter rule is for a surname: a given name one letter longer is another person.
    expect(nameMatches('Ram Das', 'Rama Das')).toBe(false);
  });
  it('570-claim re-run: name spellings and labels that are not a different customer', () => {
    expect(nameMatches('MOHD SALEEM', 'MD SALEEM')).toBe(true);
    expect(nameMatches('SURENTHS P', 'SUREJNITHS P')).toBe(true);
    expect(nameMatches('VENKATAREDDY H GOPARADDI', 'VENKATAREDDY H. GOPAREDDY')).toBe(true);
    expect(nameMatches('NAVIN RAMESHBHAI PATEL', 'KIRAN NAVIN PATEL')).toBe(false);
    expect(extractNames('Channel Name : DIRECT BUSINESS')).toEqual([]);
  });
  it('#26 a garbled father beside the real one on the same page is dropped', () => {
    const f = crossDocFieldFindings([
      { documentId: 'd', page: 3, text: 'CERTIFICATE OF INSURANCE Policy No: X premium\nInsured Name : HARPREET SINGH S/O GURDEEP SINGH R/O WARD 7' },
      { documentId: 'd', page: 8, text: 'Unique Identification Authority of India\nS/O FAL fig\nAddress: S/O Gurdeep Singh, 23' },
    ]);
    expect(f.filter((x) => /RELATION/.test(x.code))).toEqual([]);
  });
  it('#30 a family member\'s KYC father is not compared', () => {
    const inv = { documentId: 'd', page: 1, text: 'TAX INVOICE Invoice No 1\nBill To : ANKIT JAIN' };
    const ins = { documentId: 'd', page: 3, text: "CERTIFICATE OF INSURANCE Policy No: X premium\nInsured's Name : MR. ANKIT JAIN\nInsured's Address: S/O PRADIP JAYN H NO.20" };
    const relative = { documentId: 'd', page: 8, text: 'To\nPradeep Jain\nS/O Mohanlal Jain' };
    expect(crossDocFieldFindings([inv, ins, relative]).filter((x) => /RELATION/.test(x.code))).toEqual([]);
    const own = { documentId: 'd', page: 8, text: 'To\nAnkit Jain\nS/O Suresh Jain' };
    expect(crossDocFieldFindings([inv, ins, own]).filter((x) => /RELATION/.test(x.code))).toHaveLength(1);
  });
  it('#32 the old car\'s policy is not compared with the new car\'s registration', () => {
    const rc = { documentId: 'd', page: 7, text: 'CERTIFICATE OF REGISTRATION REGISTRATION NO : CG04QZ1234 Chassis No: MZBGB814LTN100001' };
    const old = { documentId: 'd', page: 8, text: 'Policy No: 1 premium Regn. Number CG-04-NS-5678 Chassis Number MZBGDB13LNN200002' };
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nVin No. MZBGB814LTN100001' };
    expect(crossDocFieldFindings([inv, rc, old]).filter((x) => /VEHICLE_NO/.test(x.code))).toEqual([]);
  });
  it('a family member\'s car in a loyalty claim is not the customer\'s (loyalty claim)', () => {
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nBill To : IMRAN KHAN\nVin No. MZBEA813LTN100003' };
    const spouse = { documentId: 'd', page: 4, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : MR. SALMA BEGUM\nChassis No. MZBET813MSN200004' };
    const ownPolicy = { documentId: 'd', page: 2, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : MR. IMRAN KHAN\nChassis No. MZBEA813LTN100003' };
    const f = crossDocFieldFindings([inv, ownPolicy, spouse], 'MZBEA813LTN100003');
    expect(f.filter((x) => /NAME/.test(x.code))).toEqual([]);
    // Shown, not silent: the reviewer sees the page was another vehicle's.
    expect(f.find((x) => x.code === 'CROSS_OTHER_VEHICLE')).toMatchObject({ page: 4, severity: 'INFO' });
    // The next car of the batch (serial one digit off) is not set aside: its owner is compared
    // and fails. Same for the customer's own policy with one serial digit misread.
    const sibling = { ...spouse, page: 5, text: spouse.text.replace('MZBET813MSN200004', 'MZBEA813LTN100004') };
    const fs = crossDocFieldFindings([inv, ownPolicy, sibling], 'MZBEA813LTN100003');
    expect(fs.find((x) => x.code === 'CROSS_OTHER_VEHICLE')).toBeUndefined();
    expect(fs.filter((x) => /NAME/.test(x.code) && x.page === 5)).toHaveLength(1);
    // Without the customer's own RC or policy, another car's policy is the fraud: compared.
    expect(crossDocFieldFindings([inv, spouse], 'MZBEA813LTN100003').filter((x) => /NAME/.test(x.code) && x.page === 4)).toHaveLength(1);
    // No chassis on the page: still compared (an annexure for another employee).
    const annex = { documentId: 'd', page: 6, text: 'Salary Slip Pay Slip for the month\nEmployee Name : Vivek Kumar Tiwari' };
    expect(crossDocFieldFindings([inv, annex]).filter((x) => /NAME/.test(x.code))).toHaveLength(1);
    // A chassis-like string on a payslip does not take it out of the comparison.
    const planted = { ...annex, text: annex.text + '\nRef MZBET813MSN200004' };
    expect(crossDocFieldFindings([inv, planted]).filter((x) => /NAME/.test(x.code))).toHaveLength(1);
    // The customer's own policy is compared however many family-car pages outvote it.
    const own = { documentId: 'd', page: 2, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : MR. RAVI KUMAR\nChassis No. MZBEA813LTN100003' };
    const spouse2 = { ...spouse, page: 5 };
    expect(crossDocFieldFindings([inv, own, spouse, spouse2]).filter((x) => /NAME/.test(x.code) && x.page === 2)).toHaveLength(1);
  });
  // Value: protects=an own policy whose serial OCR misread by one digit still counts as the
  // customer's own paper, so the family car's policy is set aside; fails_when=own-car papers
  // need an exact serial (the dd164f4 rule, which failed a real claim)
  it('a family car\'s page too poorly scanned to classify is still set aside by its VIN', () => {
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nBill To : IMRAN KHAN\nVin No. MZBEA813LTN100003' };
    const own = { documentId: 'd', page: 2, text: "CERTIFICATE OF INSURANCE premium\nInsured's Name : MR. IMRAN KHAN\nChassis No. MZBEA813LTN100003" };
    const blurred = { documentId: 'd', page: 5, text: 'Owner Name : SALMA BEGUM\nChassis No. MZBET813MSN200004' };
    const f = crossDocFieldFindings([inv, own, blurred], 'MZBEA813LTN100003');
    expect(f.filter((x) => x.page === 5 && /MISMATCH/.test(x.code))).toEqual([]);
    expect(f.find((x) => x.code === 'CROSS_OTHER_VEHICLE')).toMatchObject({ page: 5 });
    // An unlabelled 17-character code (a policy number) does not set a page aside.
    const unlabelled = { documentId: 'd', page: 6, text: 'Owner Name : SALMA BEGUM\nRef 3005A202600012345' };
    const g = crossDocFieldFindings([inv, own, unlabelled], 'MZBEA813LTN100003');
    expect(g.find((x) => x.code === 'CROSS_OTHER_VEHICLE')).toBeUndefined();
    expect(g.find((x) => x.page === 6 && x.code === 'CROSS_NAME_MISMATCH')).toBeDefined();
  });
  it('an own policy with one serial digit misread still holds the bundle\'s own-car papers', () => {
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nBill To : IMRAN KHAN\nVin No. MZBEA813LTN100003' };
    const ownMisread = { documentId: 'd', page: 2, text: "CERTIFICATE OF INSURANCE premium\nInsured's Name : MR. IMRAN KHAN\nChassis No. MZBEA813LTN100008" };
    const spouse = { documentId: 'd', page: 4, text: "CERTIFICATE OF INSURANCE premium\nInsured's Name : MR. SALMA BEGUM\nChassis No. MZBET813MSN200004" };
    const f = crossDocFieldFindings([inv, ownMisread, spouse], 'MZBEA813LTN100003');
    expect(f.filter((x) => /NAME/.test(x.code))).toEqual([]);
    expect(f.find((x) => x.code === 'CROSS_OTHER_VEHICLE')).toMatchObject({ page: 4 });
  });
  it('a scan-misread invoice VIN still identifies the claim\'s own car (OCR-read VIN)', () => {
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nBill To : MEHTA NEHA RAJESH\nMZBEB8I2TTN100005 MZBEB8I12TTN100005' };
    const brother = { documentId: 'd', page: 8, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : MR. SHAH ROHAN KIRIT\nGJ 03 MR 1111 RAJKOT MZBET813MPN200006' };
    const own = { documentId: 'd', page: 9, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : MRS. MEHTA NEHA RAJESH\nChassis No. MZBEB812TTN100005' };
    expect(crossDocFieldFindings([inv, own, brother], 'MZBEB812TTN100005').filter((x) => /NAME/.test(x.code))).toEqual([]);
    expect(crossDocFieldFindings([inv, own, brother]).filter((x) => /NAME/.test(x.code))).toEqual([]);
  });
  it('the customer\'s own policy with a misread VIN is still compared (misread own VIN)', () => {
    const inv = { documentId: 'd', page: 1, text: 'Vehicle Tax Invoice\nBill To : PREM KUMAR\nVin No. MZBB1811LSN100007' };
    const own = { documentId: 'd', page: 9, text: 'CERTIFICATE OF INSURANCE premium\nInsured\'s Name : RAVI SHANKAR\nMZBBISHILSN100007 GILCSMa11111' };
    expect(crossDocFieldFindings([inv, own], 'MZBB1811LSN100007').filter((x) => /NAME/.test(x.code))).toHaveLength(1);
  });
  it('#25 the authorised signatory is not the employee', () => {
    expect(extractNames('Employee Name : ANIL VERMA\nAuthorised Signatory\nName : Deepak')).toEqual(['ANIL VERMA']);
    // A salary certificate: the heading is five lines above the name.
    expect(
      extractNames(
        'Authorized Signatory, =\nCopp\nFor. iffonised Sineter\nCity Public Education Trust,\n' +
          '(Managing Dr. A B Sharma Memorial College, Indore,)\nName: Deepak Rao :'
      )
    ).toEqual([]);
  });
  it('#24 a staff ID card\'s "F.Name" is the father, not the holder', () => {
    expect(extractNames('Name : KAVITASINGH\nF.Name : MOHAN KUMAR SINGH')).toEqual(['KAVITASINGH']);
  });
  it('#27 the nominee under a heading is not the customer', () => {
    expect(extractNames('Insured Name : RAM KUMAR\nNominee Details\nName : SUNITA DEVI')).toEqual(['RAM KUMAR']);
  });
  it('a bare "Name :" with no heading above is still read', () => {
    expect(extractNames('GOVERNMENT OF INDIA\nName : RAM KUMAR')).toEqual(['RAM KUMAR']);
  });
  it('#29 a premium line is not a vehicle number', () => {
    expect(extractVehicleNos('BASIC PREMIUM - Vehicle\nTP 5114')).toEqual([]);
    expect(extractVehicleNos('Basic Premium - Vehicle 5,114')).toEqual([]);
  });
  it('#32 registration numbers with "No." and en-dashes are read whole', () => {
    expect(extractVehicleNos('Regn. No. : MH 12 AB-1234')).toEqual(['MH 12 AB-1234']);
    expect(extractVehicleNos('Registration No.: MH12–AB1234')).toEqual(['MH12-AB1234']);
    expect(extractVehicleNos('Vehicle No : UP32 KQ 5678')).toEqual(['UP32 KQ 5678']);
    expect(extractVehicleNos('Vehicle Registration No. HR 26 DK 4321')).toEqual(['HR 26 DK 4321']);
  });
  it('#31 a multi-line Aadhaar address is read through the PIN, without the S/O prefix', () => {
    const [a] = extractField('ADDRESS', 'Address: S/O Ram Kumar,\nH No 12, Gandhi Nagar,\nLucknow, Uttar Pradesh - 226001');
    expect(a).toMatch(/Gandhi Nagar/);
    expect(a).toMatch(/226001/);
    expect(a).not.toMatch(/Ram Kumar/);
  });
});
