// Client feedback sheet of 2026-11 (Data Compare, Duplicacy, Red Flags). Fixtures follow the
// layout of the reported claims' OCR text; every name and number in them is made up.
import { checkDates, checkPassportFileNo, checkUdyam } from '../redFlagLogic';
import {
  canonicalPlate,
  classifyDocType,
  cleanPersonName,
  crossDocFieldFindings,
  dmsNameFindings,
  extractField,
  extractNames,
  invoiceRcNameResult,
  nameMatches,
  platesOnPage,
  type CrossPage,
} from '../crossDocLogic';
import { extractIdentifiers } from '../dupIdentifiers';
import { dupValidator, normValue } from '../dupValidator';
import { holderName, holderNameFindings, rcOwnerName, relationKycFindings } from '../holderNames';
import { compareValidator } from '../compareValidator.js';

const page = (n: number, text: string, govtCode: string | null = null): CrossPage => ({ documentId: 'd', page: n, text, govtCode });

describe('client sheet 2026-11 - Red Flags', () => {
  it('reads the Udyam number, not the certificate title, and says its length', () => {
    const text = 'UDYAM REGISTRATION CERTIFICATE\nUDYAM REGISTRATION NUMBER UDYAM-KR-03-01234567\nNAME OF ENTERPRISE';
    expect(checkUdyam(text, 11)).toEqual([
      expect.objectContaining({ code: 'REDFLAG_UDYAM_FORMAT', message: 'Udyam number "UDYAM-KR-03-01234567" is 20 characters, not 19 (UDYAM-SS-DD-NNNNNNN)' }),
    ]);
    expect(checkUdyam('UDYAM REGISTRATION NUMBER UDYAM-CG-15-000123')[0].message).toContain('is 18 characters');
    expect(checkUdyam('UDYAM REGISTRATION CERTIFICATE\nUDYAM-MH-12-1234567')).toEqual([]);
    expect(checkUdyam('UDYAM REGISTRATION CERTIFICATE')).toEqual([]);
  });

  it('reads a passport file number after "File No." and skips an old passport number there', () => {
    expect(checkPassportFileNo('/File No.\nDLHA0012345', 22)[0].message).toBe('Passport file no. "DLHA0012345" is 11 chars, not 12-15');
    expect(checkPassportFileNo('File No. K1234567 /Old Passport No. with Date')).toEqual([]);
  });

  it('flags a five-digit-year date even with an impossible day, and skips times and junk', () => {
    expect(checkDates('Joining Date: 32-13-20000 Bank Name', 4)[0]?.data).toEqual({ date: '32-13-20000' });
    expect(checkDates('Issued at 17-57-00 IST')).toEqual([]);
    expect(checkDates('Ref 88/80/97')).toEqual([]);
    expect(checkDates('+91-20-20012')).toEqual([]);
  });
});

describe('client sheet 2026-11 - names', () => {
  it('does not read "IRN" from "Bill To IRN No.:" as the customer', () => {
    expect(extractNames('Dealer GST/PAN No: Bill To IRN No.: ABC MOTORS LLP Main Road')).toEqual([]);
  });

  it('rejects OCR debris and a relation label as a name', () => {
    expect(cleanPersonName('A pay')).toBeNull();
    expect(cleanPersonName('WID OF')).toBeNull();
    expect(extractNames('Mode Name: S Eon')).toEqual([]);
    expect(cleanPersonName('Ravi Kumar')).toBe('Ravi Kumar');
  });

  it('does not take a father in the middle of a name for the person, but keeps the rest', () => {
    expect(nameMatches('RAMESHKUMAR', 'SURESH RAMESH GUPTA')).toBe(false);
    expect(nameMatches('KUNAL', 'SHAH KUNAL NITINBHAI')).toBe(true);
    expect(nameMatches('RAJESH', 'RAJESH KUMAR SHARMA')).toBe(true);
    expect(nameMatches('ORBIT GLOBAL SE', 'ORBIT GLOBAL SERVICES LLP')).toBe(true);
    expect(nameMatches('Ram Das', 'Rama Das')).toBe(false);
  });

  it('reads a payslip "Emp Name" with no separator', () => {
    const p = page(8, 'Payslip for the month of MAY 2026 Net Pay Earnings Emp Code 0112345_IN Emp Name RAVI SHARMA Location IN-PNQ');
    expect(holderName(p, new Set())).toEqual({ name: 'RAVI SHARMA', type: 'PAYSLIP', loose: true });
  });
});

describe('client sheet 2026-11 - document types', () => {
  it('reads a staff card by its staff or employee number, and a voter card as no staff ID', () => {
    expect(classifyDocType('Amit Kumar\nYIP 4./staff No. 601234\nBlood Group:')).toBe('STAFF_ID');
    expect(classifyDocType('Neha Singh\nEmployee No. : 161234\nIssuing Authority')).toBe('STAFF_ID');
    expect(classifyDocType('ELECTION COMMISSION OF INDIA ELECTOR PHOTO IDENTITY CARD ABC1234567')).toBeNull();
  });

  it('reads an RC whose model is a "PREMIUM" variant as an RC', () => {
    const rc = 'Vehicle Registration Certificate\nRegnio Date of Regn. Regn. Validity Owner Serial\nModel Name: CARENS PREMIUM';
    expect(classifyDocType(rc)).toBe('RC');
  });
});

describe('client sheet 2026-11 - duplicate data points', () => {
  it('reads the employee number labels of the Duplicacy sheet', () => {
    const codes = (t: string) => extractField('EMP_CODE', t);
    expect(codes('Payslip Feb 2026\nEmplID 5012345 Name A B')).toEqual(['5012345']);
    expect(codes('UNIQUE ID No: 123456789')).toEqual(['123456789']);
    expect(codes('Police Officer | PEN: 612345')).toEqual(['612345']);
    expect(codes('Card No 400001\nAssociate No 2612345')).toEqual(['2612345']);
    expect(codes('Personnel No. 13012345 Name')).toEqual(['13012345']);
    expect(codes('Employee ID | 11012345 | Name')).toEqual(['11012345']);
    expect(codes('PF Employee Cont. 1,800.00')).toEqual([]);
  });

  it('reads a GPF/PRAN account and an EPS account number', () => {
    const ids = (t: string) => extractIdentifiers(t).map((i) => `${i.field}=${i.value}`);
    expect(ids('GPF/PRAN Ac No: 110123456789 For the month')).toContain('PRAN=110123456789');
    expect(ids('GPF/PRANAc No: 110123456789')).toContain('PRAN=110123456789');
    expect(ids('EPS A/cNo.  DLCPMO00011100000222333 |Next')).toContain('PENSION_NO=DLCPMO00011100000222333');
    expect(ids('EPSA/lcNo.  DLCPMO00011100000222333 |')).toContain('PENSION_NO=DLCPMO00011100000222333');
  });

  it('matches one plate through OCR slips in the RTO code, and reads a plate under a table header', () => {
    expect(canonicalPlate('JH O1XY 4321')).toBe('JH01XY4321');
    expect(normValue('VEHICLE_NO', 'JHo01Xy 4321')).toBe(normValue('VEHICLE_NO', 'JH01XY4321'));
    const rc = 'Indian Union Vehicle Registration Certificate\nRegn. Number Date of Regn. Regn. Validity\nMH12AB3456 03-12-2020\nOwner Serial 1\nPIN GJ 364001';
    expect(platesOnPage(rc)).toEqual(['MH12AB3456']);
    expect(platesOnPage('Registration No. JH O1XY 4321Unladen Weight 988 Registration Certificate Owner Serial')).toEqual(['JH O1XY 4321']);
    expect(platesOnPage('TAX INVOICE Invoice No 1 MH12AB3456')).toEqual([]);
  });
});

describe('client sheet 2026-11 - old car papers and KYC', () => {
  const CLAIM = 'MZBTEST12ABC34567';
  const oldRc = page(
    7,
    'Indian Union Vehicle Registration Certificate\nRegn. Number Date of Regn. Regn. Validity\nGJ05XY9876 03-12-2020\nChassis No\nMAKOLD99ZXY12345\nOwner Name\nRAMESH PRASAD VERMA\nSon/Daughter/Wife of\nMOHAN LAL VERMA'
  );
  const ownRc = page(2, `CERTIFICATE OF REGISTRATION Registering Authority\nChassis No: ${CLAIM}\nOwner Name: Sunil Kumar Sharma`);
  const invoice = page(1, `TAX INVOICE Invoice No 1\nCustomer Name: Sunil Kumar Sharma\nChassis No: ${CLAIM}`);
  const pan = (name: string) => page(5, `INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPV1234D\nName\n${name}\nFather's Name\nOM PRAKASH`, 'PAN');

  it('compares the invoice with the old car RC owner, not with the new car RC', () => {
    expect(rcOwnerName(oldRc.text)).toBe('RAMESH PRASAD VERMA');
    const [r] = invoiceRcNameResult([invoice, ownRc, oldRc], { claimVin: CLAIM, ownerOf: rcOwnerName });
    expect(r).toMatchObject({ code: 'CROSS_INVOICE_RC_DIFF_NAME', page: 7, data: { invoice: 'Sunil Kumar Sharma', rc: 'RAMESH PRASAD VERMA' } });
  });

  it('flags an old car paper whose holder is neither the customer nor on any KYC', () => {
    const f = relationKycFindings('SUNIL KUMAR SHARMA', [invoice, oldRc, pan('SUNIL KUMAR SHARMA')], CLAIM);
    expect(f.map((x) => [x.code, x.page])).toEqual([['CROSS_RELATION_KYC_MISMATCH', 7]]);
    // The relative's KYC is in the claim: nothing to flag.
    const ok = relationKycFindings('SUNIL KUMAR SHARMA', [invoice, oldRc, pan('SUNIL KUMAR SHARMA'), { ...pan('RAMESH PRASAD VERMA'), page: 6 }], CLAIM);
    expect(ok).toEqual([]);
    // No KYC page at all: silent.
    expect(relationKycFindings('SUNIL KUMAR SHARMA', [invoice, oldRc], CLAIM)).toEqual([]);
  });

  it("flags the claim's own new-car policy insured to someone else", () => {
    const policy = page(
      3,
      `Policy No. 123 Premium Sum Insured\nInsured's Name : MR. ANIL KUMAR MEHTA Period of Insurance\nRegistration No. New\nChassis No.\n${CLAIM}`
    );
    const f = holderNameFindings('SUNIL KUMAR SHARMA', [invoice, policy], CLAIM);
    expect(f.map((x) => [x.code, x.page])).toEqual([['CROSS_HOLDER_NAME_MISMATCH', 3]]);
  });
});

describe('client sheet 2026-11 - audit follow-ups', () => {
  const CLAIM = 'MZBTEST12ABC34567';
  const oldRc = page(4, 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: Mohan Lal Verma');

  // Value: protects=DMS name stands in for a missing invoice and a temp RC is never the old RC; fails_when=fallback or TEMP_RC skip dropped; why_new=only the invoice-page path is tested; seam=none; no_claim=compareValidator wiring
  it('uses the DMS name without an invoice page and skips a temporary RC', () => {
    const tempRc = page(2, 'TEMPORARY CERTIFICATE OF REGISTRATION Registering Authority\nOwner Name: Anil Mehta');
    const [r] = invoiceRcNameResult([tempRc, oldRc], { claimVin: CLAIM, dmsName: 'Sunil Kumar Sharma' });
    expect(r).toMatchObject({ code: 'CROSS_INVOICE_RC_DIFF_NAME', page: 4, data: { invoice: 'Sunil Kumar Sharma', rc: 'Mohan Lal Verma' } });
    expect(invoiceRcNameResult([oldRc], { claimVin: CLAIM })).toEqual([]);
  });

  // Value: protects=an old car paper in the customer's own name is not flagged; fails_when=nameMatches(ref, holder) skip removed; why_new=tests cover relative and no-KYC only; seam=none; no_claim=policy holder path
  it('stays silent when the old car paper is in the customer name', () => {
    const pan = page(5, 'INCOME TAX DEPARTMENT\nName\nSUNIL KUMAR SHARMA', 'PAN');
    const own = page(4, 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: Sunil Kumar Sharma');
    expect(relationKycFindings('SUNIL KUMAR SHARMA', [own, pan], CLAIM)).toEqual([]);
  });

  // Value: protects=two-digit-year skip only for non day/month pairs; fails_when=skip widened to every 2-digit year; why_new=only time/junk skips tested; seam=none; no_claim=5-digit path
  it('still flags an impossible two-digit-year date whose day and month are in range', () => {
    expect(checkDates('Date: 31-02-21', 1).map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
  });

  // Value: protects=non-plate text keeps plain normalisation; fails_when=canonicalPlate accepts any 2 letters; why_new=only valid plates tested; seam=none; no_claim=dup matching
  it('does not canonicalise a value whose state code is not real', () => {
    expect(canonicalPlate('ZZ01XY4321')).toBeNull();
    expect(normValue('VEHICLE_NO', 'zz-01 xy 4321')).toBe('ZZ01XY4321');
  });
});

describe('client sheet 2026-11 - review fixes', () => {
  // Value: protects=distinct plates stay distinct; fails_when=series letters fold into the RTO code; why_new=no test had an L/I series; seam=none; no_claim=none beyond protects
  it('keeps plates with an L series apart from a different RTO code', () => {
    expect(canonicalPlate('MH02LA1234')).toBe('MH02LA1234');
    expect(canonicalPlate('MH02LA1234')).not.toBe(canonicalPlate('MH21A1234'));
  });

  // Value: protects=a buyer followed by a door number is still read; fails_when=the "No" label skip crosses a line; why_new=only the same-line IRN case was tested; seam=none; no_claim=none beyond protects
  it('keeps a Bill To buyer whose address line starts with No.', () => {
    expect(extractNames('Bill To RAVI SHARMA\nNo. 12 MG Road')).toEqual(['RAVI SHARMA']);
  });

  // Value: protects=a cut name matches only as a 3+ word prefix; fails_when=any 2-letter prefix matches; why_new=only the true case was tested; seam=none; no_claim=qrCompare callers
  it('does not match a two-word name to a longer different name', () => {
    expect(nameMatches('MOHAN LAL', 'MOHAN LALIT SHARMA')).toBe(false);
  });

  // Value: protects=in-range impossible dates with a 2-digit year still flag; fails_when=the junk skip widens; why_new=month-13 and day-32 rows missing; seam=none; no_claim=none beyond protects
  it('still flags month 13 and day 32 with a two-digit year', () => {
    expect(checkDates('Date: 15/13/21')).toHaveLength(1);
    expect(checkDates('Date: 32/01/21')).toHaveLength(1);
  });

  // Value: protects=the own RC name mismatch survives an old RC Diff Name; fails_when=rcDiff drops every invoice/RC mismatch; why_new=compareValidator dedupe untested; seam=none; no_claim=no database, wordBoxes empty
  it("keeps the claim's own RC name mismatch when the old RC is a Diff Name", async () => {
    const CLAIM = 'MZBTEST12ABC34567';
    const pages = [
      `TAX INVOICE Invoice No 1\nCustomer Name: Sunil Kumar Sharma\nChassis No: ${CLAIM}`,
      `CERTIFICATE OF REGISTRATION Registering Authority\nChassis No: ${CLAIM}\nOwner Name: Anil Mehta`,
      'Indian Union Vehicle Registration Certificate\nRegn. Number Date of Regn. Regn. Validity\nChassis No\nMAKOLD99ZXY12345\nOwner Name\nRAMESH PRASAD VERMA',
    ];
    const ctx = {
      claim: { id: 'c', claimId: CLAIM, subCategoryId: 's', customerName: 'SUNIL KUMAR SHARMA' },
      documents: [{ id: 'd1', fileName: 'claim.pdf', storagePath: 'x', readablePath: 'x', mimeType: 'application/pdf', source: 'UPLOADED' as const, documentTypeId: null }],
      prisma: null as never, ocr: { extractImageText: async () => '' }, shared: new Map(), wordBoxes: new Map(), pageTexts: new Map([['d1', pages]]),
    };
    const codes = ((await compareValidator.run(ctx)).findings ?? []).filter((f) => f.severity === 'ERROR').map((f) => f.code);
    expect(codes).toContain('CROSS_INVOICE_RC_DIFF_NAME');
    expect(codes).toContain('CROSS_NAME_MISMATCH');
  });

  // Value: protects=a financial-year document number is no date; fails_when=the five-digit-year rule loses its FY guard; why_new=only real bad dates were tested; seam=none; no_claim=none beyond protects
  it('does not read a financial-year invoice number as an impossible date', () => {
    expect(checkDates('Invoice No: INV/24-25/20012')).toEqual([]);
    expect(checkDates('Joining Date: 32-13-20000')).toHaveLength(1);
  });

  // Value: protects=plates without series letters keep the plain norm; fails_when=padding merges series-less plates; why_new=only plates with series were tested; seam=none; no_claim=none beyond protects
  it('does not canonicalise a plate without series letters', () => {
    expect(canonicalPlate('MH1234')).toBeNull();
    expect(normValue('VEHICLE_NO', 'MH 12 34')).not.toBe(normValue('VEHICLE_NO', 'MH 12 304'));
  });
});

describe('client sheet 2026-11 — adversarial review fixes', () => {
  const VIN = 'MA3NEW11ZAB123456';
  const familyRc = (owner: string) =>
    `Certificate of Registration\nRegistration No: DL3CAB1234\nChassis No: MAKOLD99ZXY98765\nOwner Name: ${owner}\nRegn. Validity 2030`;

  // Value: protects=a policy number or policy period never becomes a hard vehicle duplicate; fails_when=the unlabelled plate scan reads any plate-shaped run; why_new=only real plates were tested; seam=none; no_claim=none beyond protects
  it('reads no plate from a policy number or a policy period', () => {
    const policy =
      'Motor Policy Schedule\nPremium Rs 12000\nPolicy No: MH12AB3456A\nPolicy Number: MH12AB3456\nOD 01-Apr-2024 to 31-Mar-2025\nRegistration No: KA05MN7788';
    expect(platesOnPage(policy)).toEqual(['KA05MN7788']);
    expect(platesOnPage('Certificate of Registration\nRegn. Validity\nJH O1XY 4321Unladen Weight')).toEqual(['JH O1XY 4321']);
  });

  // Value: protects=a family car's first policy is not held to the customer's name; fails_when=the own-policy rule takes every new-registration policy; why_new=only the own car's policy was tested; seam=none; no_claim=none beyond protects
  it("does not compare a family car's new-registration policy with the customer", () => {
    const policy = (insured: string) => `Motor Insurance Policy Schedule\nPremium Rs 9000\nInsured Name: ${insured}\nRegistration No. New\nChassis No: MAKOLD99ZXY98765`;
    expect(holderNameFindings('SUNIL KUMAR SHARMA', [page(1, familyRc('RAMESH PRASAD VERMA')), page(2, policy('RAMESH PRASAD VERMA'))], VIN)).toEqual([]);
    // Insured to neither the customer nor the RC owner: still a red line (C1).
    expect(holderNameFindings('SUNIL KUMAR SHARMA', [page(1, familyRc('RAMESH PRASAD VERMA')), page(2, policy('ANIL KUMAR MEHTA'))], VIN).map((f) => f.code)).toEqual([
      'CROSS_HOLDER_NAME_MISMATCH',
    ]);
  });

  // Value: protects=a relative's KYC with the name wrapped over two lines counts; fails_when=the KYC name search is line-bound; why_new=only one-line KYC names were tested; seam=none; no_claim=none beyond protects
  it("finds a relative's KYC whose name OCR wrapped over two lines", () => {
    const pan = "INCOME TAX DEPARTMENT\nPermanent Account Number\nName\nRAMESH\nVERMA\nFather's Name\nSURESH VERMA";
    expect(relationKycFindings('SUNIL KUMAR SHARMA', [page(1, familyRc('RAMESH VERMA')), page(2, pan, 'PAN')], VIN)).toEqual([]);
  });

  // Value: protects=a payslip printing a second id beside the employee id is no mismatch; fails_when=EMP_CODE skips the settled-page pruning; why_new=the new labels read two values on one page; seam=none; no_claim=none beyond protects
  it('does not report a payslip second id once its employee id agrees with the staff card', () => {
    const staff = page(1, 'EMPLOYEE IDENTITY CARD\nEmployee ID: 5012345\nName: RAVI SHARMA');
    const slip = page(2, 'Salary Slip for the month\nNet Pay 45000\nEarnings Basic 30000\nEmployee ID: 5012345\nKGID No: 1234567');
    expect(classifyDocType(slip.text)).toBe('PAYSLIP');
    expect(crossDocFieldFindings([staff, slip], VIN).filter((f) => f.code === 'CROSS_EMP_CODE_MISMATCH')).toEqual([]);
  });

  // Value: protects=a passport back page's next label is not a file number and a bad file number still flags; fails_when=the value may be a word or any passport-shaped value is skipped; why_new=only the old-passport layout was tested; seam=none; no_claim=none beyond protects
  it('reads a passport file number only when it has a digit, and skips an old passport number only on that layout', () => {
    expect(checkPassportFileNo('File No.\nOld Passport No. with Date')).toEqual([]);
    expect(checkPassportFileNo('File No: K1234567')).toHaveLength(1);
    expect(checkPassportFileNo('File No.\nK1234567\nOld Passport No. with Date')).toEqual([]);
  });

  // Value: protects=a real day with a five-digit year flags even when month = day + 1; fails_when=the FY guard skips consecutive day/month pairs; why_new=fix-check finding; seam=none; no_claim=none beyond protects
  it('still flags a real day with a five-digit year next to the financial-year guard', () => {
    expect(checkDates('DOB: 11.12.20000')).toHaveLength(1);
    expect(checkDates('Date of Birth: 01-02-19850')).toHaveLength(1);
    expect(checkDates('Invoice No: INV/24-25/20012')).toEqual([]);
  });

  // Value: protects=a different surname is not a clipped name, in either order; fails_when=the prefix rule allows equal word counts; why_new=order dependence untested; seam=none; no_claim=none beyond protects
  it('does not treat a longer surname as a clipped one', () => {
    expect(nameMatches('RAVI KUMAR DAS', 'RAVI KUMAR DASGUPTA')).toBe(false);
    expect(nameMatches('RAVI KUMAR DASGUPTA', 'RAVI KUMAR DAS')).toBe(false);
    expect(nameMatches('ORBIT GLOBAL SE', 'ORBIT GLOBAL SERVICES LLP')).toBe(true);
  });

  // Value: protects=a separator-less payslip name stops at the next column; fails_when=the capitals run takes DEPT/PF words; why_new=only a clean line was tested; seam=none; no_claim=none beyond protects
  it('cuts a payslip name at the next column word', () => {
    const slip = (line: string) => page(1, `Salary Slip for the month\nNet Pay 45000\nEarnings Basic 30000\n${line}`);
    expect(holderName(slip('EMP NAME RAVI SHARMA DEPT ACCOUNTS'), new Set())?.name).toBe('RAVI SHARMA');
    expect(holderNameFindings('RAVI KUMAR SHARMA', [slip('Emp Name RAVI SHARMA PF NO RJ1234')], VIN)).toEqual([]);
  });

  // Value: protects=a plate indexed before canonicalPlate still matches the same printed plate; fails_when=the lookup asks only for the new norm; why_new=no pre-change row was tested; seam=none; no_claim=no database (ctx.prisma is stubbed)
  it('matches a vehicle number stored with the earlier norm', async () => {
    const asked: string[] = [];
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) => {
          if (where.field === 'VEHICLE_NO') asked.push(...where.norm.in);
          return where.field === 'VEHICLE_NO' && where.norm.in.includes('MH1AB1234') ? [{ norm: 'MH1AB1234', claim: { claimId: 'OLDCLAIM1' } }] : [];
        },
      },
    };
    const text = 'Certificate of Registration\nRegistration No: MH1AB1234\nRegn. Validity 2030';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: VIN, subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(asked).toEqual(expect.arrayContaining(['MH01AB1234', 'MH1AB1234']));
    expect(outcome.findings?.map((f) => f.code)).toContain('DUP_VEHICLE_NO');
  });
});

describe('client sheet 2026-11 - coverage audit follow-ups', () => {
  const CLAIM = 'MZBTEST12ABC34567';
  const invoice = `TAX INVOICE Invoice No 1\nCustomer Name: Sunil Kumar Sharma\nChassis No: ${CLAIM}`;
  const oldRc = 'Indian Union Vehicle Registration Certificate\nRegn. Number Date of Regn. Regn. Validity\nChassis No\nMAKOLD99ZXY12345\nOwner Name\nRAMESH PRASAD VERMA';
  const panText = 'INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCPS1234D\nName\nSUNIL KUMAR SHARMA\nFather\'s Name\nOM PRAKASH';
  const compareCtx = (pages: string[]) => ({
    claim: { id: 'c', claimId: CLAIM, subCategoryId: 's', customerName: 'SUNIL KUMAR SHARMA' },
    documents: [{ id: 'd1', fileName: 'claim.pdf', storagePath: 'x', readablePath: 'x', mimeType: 'application/pdf', source: 'UPLOADED' as const, documentTypeId: null }],
    prisma: null as never, ocr: { extractImageText: async () => '' }, shared: new Map(), wordBoxes: new Map(), pageTexts: new Map([['d1', pages]]),
  });

  // Value: protects=an old car policy insured to a stranger with no KYC is flagged; fails_when=relationKycFindings reads only RC holders; why_new=only RC pages were tested; seam=none; no_claim=compareValidator wiring
  it('flags an old car policy insured to someone with no KYC in the claim', () => {
    const policy = page(3, "Motor Policy Schedule\nPolicy No. 991 Premium Sum Insured\nInsured's Name : ANIL KUMAR MEHTA\nChassis No.\nMAKOLD99ZXY12345");
    const f = relationKycFindings('SUNIL KUMAR SHARMA', [page(1, invoice), policy, page(5, panText, 'PAN')], CLAIM);
    expect(f).toEqual([expect.objectContaining({ code: 'CROSS_RELATION_KYC_MISMATCH', page: 3, data: expect.objectContaining({ actualType: 'INSURANCE', actual: 'ANIL KUMAR MEHTA' }) })]);
  });

  // Value: protects=Data Compare reports the relation KYC line; fails_when=compareValidator stops calling relationKycFindings; why_new=only the helper was tested; seam=none; no_claim=no database
  it('reports the relation KYC mismatch through the Data Compare run', async () => {
    const codes = ((await compareValidator.run(compareCtx([invoice, oldRc, panText]))).findings ?? []).map((f) => f.code);
    expect(codes).toContain('CROSS_RELATION_KYC_MISMATCH');
  });

  // Value: protects=an old RC Diff Name is reported once, not again as a name mismatch; fails_when=the rcDiff dedupe stops dropping the same RC line; why_new=only the keep side was tested; seam=none; no_claim=no database
  it('drops the claim-wide invoice/RC name line for the same old RC', async () => {
    // A labelled owner, so the claim-wide check reads it too.
    const pages = [invoice, 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: Ramesh Prasad Verma'];
    // Precondition: without the dedupe the claim-wide check does report this pair.
    const raw = crossDocFieldFindings(pages.map((t, i) => page(i + 1, t)), CLAIM).filter((f) => f.code === 'CROSS_NAME_MISMATCH');
    expect(raw.length).toBeGreaterThan(0);
    const codes = ((await compareValidator.run(compareCtx(pages))).findings ?? []).map((f) => f.code);
    expect(codes).toContain('CROSS_INVOICE_RC_DIFF_NAME');
    expect(codes).not.toContain('CROSS_NAME_MISMATCH');
  });

  // Value: protects=an unlabelled plate under a table header reaches the duplicate index; fails_when=extractAll stops adding platesOnPage values; why_new=the dup test used a labelled plate; seam=none; no_claim=no database (ctx.prisma is stubbed)
  it('indexes a plate printed under a table header as a vehicle number duplicate', async () => {
    const asked: string[] = [];
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) => {
          if (where.field === 'VEHICLE_NO') asked.push(...where.norm.in);
          return where.field === 'VEHICLE_NO' && where.norm.in.includes('JH01XY4321') ? [{ norm: 'JH01XY4321', claim: { claimId: 'OLDCLAIM2' } }] : [];
        },
      },
    };
    const text = 'Certificate of Registration\nRegn. Number Date of Regn. Regn. Validity\nJH O1XY 4321Unladen Weight 1200';
    expect(extractField('VEHICLE_NO', text)).not.toContain('JH O1XY 4321');
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: CLAIM, subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(asked).toContain('JH01XY4321');
    expect(outcome.findings?.map((f) => f.code)).toContain('DUP_VEHICLE_NO');
  });
});

describe('client sheet 2026-11 - pre-landing review fixes', () => {
  const VIN = 'MZBTEST12ABC34567';

  // Value: protects=the town Pen's PIN on an address is no employee code; fails_when=PEN is read without its ':' or '|'; why_new=only the labelled PEN was tested; seam=none; no_claim=dupValidator wiring
  it('reads PEN only with its separator, not a Pen address PIN', () => {
    expect(extractField('EMP_CODE', 'Dealer: Main Road, PEN-402107 Raigad')).toEqual([]);
    expect(extractField('EMP_CODE', 'PEN: 612345')).toEqual(['612345']);
    expect(extractField('EMP_CODE', 'PEN No.: 612345')).toEqual(['612345']);
  });

  // Value: protects=a trailing table header on a separator-less payslip name raises no false red; fails_when=the loose name is compared whole; why_new=only a cut at a listed column word was tested; seam=none; no_claim=other payslip layouts
  it('matches the customer against the leading words of a loose payslip name', () => {
    const slip = (name: string) => page(2, `SALARY SLIP Net Pay Gross Salary Earnings\nEMP NAME ${name} PAYABLE DAYS 30`);
    expect(holderNameFindings('RAVI KUMAR SHARMA', [slip('RAVI SHARMA')], VIN)).toEqual([]);
    expect(holderNameFindings('RAVI KUMAR SHARMA', [slip('ANIL MEHTA')], VIN).map((f) => f.code)).toEqual(['CROSS_HOLDER_NAME_MISMATCH']);
  });

  // Value: protects=the Udyam reason never contradicts itself and a glued word is no length error; fails_when=the length text is used for 19 chars or digits run into a word; why_new=only 18 and 20 char numbers were tested; seam=none; no_claim=none beyond protects
  it('words the Udyam reason by length and stops digits at a glued word', () => {
    expect(checkUdyam('Udyam No: UDYAM-MH-1A-1234567')[0].message).toBe('Udyam number "UDYAM-MH-1A-1234567" is not UDYAM-SS-DD-NNNNNNN');
    expect(checkUdyam('UDYAM-MH-12-1234567TYPE OF ENTERPRISE')).toEqual([]);
    expect(checkUdyam('UDYAM-MH-12-12345678 TYPE')[0].message).toContain('is 20 characters');
  });

  // Value: protects=a PAN's "Father's Name" line is not read as an initial S; fails_when=joinWrapped keeps the possessive; why_new=wrapped names were tested without a possessive label; seam=none; no_claim=father's name on the customer's own PAN (open client decision)
  it("flags an old RC owner whose only match was the 's of \"Father's Name\"", () => {
    const oldRc = page(4, 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: Suresh Patel');
    const pan = page(5, "INCOME TAX DEPARTMENT\nName\nANIL MOHAN PATEL\nFather's Name\nMOHAN PATEL", 'PAN');
    expect(relationKycFindings('ANIL MOHAN PATEL', [oldRc, pan], VIN).map((f) => f.code)).toEqual(['CROSS_RELATION_KYC_MISMATCH']);
  });
});

describe('client sheet 2026-11 - pre-landing review pass 2 fixes', () => {
  const VIN = 'MZBTEST12ABC34567';

  // Value: protects=a capitals name followed later by OF is cut, not dropped, and "WID OF" stays rejected; fails_when=the prose check rejects any-case words anywhere; why_new=only the WID OF label was tested; seam=none; no_claim=other prose words
  it('cuts a capitals name at a later prose word and still rejects a label', () => {
    expect(cleanPersonName('RAJESH GUPTA PLACE OF SUPPLY')).toBe('RAJESH GUPTA PLACE');
    expect(cleanPersonName('WID OF RAM GUPTA')).toBeNull();
    const inv = page(1, 'TAX INVOICE INVOICE NO: 123\nCUSTOMER NAME: RAJESH GUPTA PLACE OF SUPPLY: MAHARASHTRA');
    expect(dmsNameFindings('SUNIL KUMAR SHARMA', [inv]).map((f) => f.code)).toEqual(['CROSS_DMS_NAME_MISMATCH']);
  });

  // Value: protects=the claim's own new-car policy keeps its chassis mismatch beside the holder line; fails_when=every INSURANCE holder page counts as another car's; why_new=the dedupe was tested on other cars only; seam=none; no_claim=no database
  it("keeps the chassis mismatch on the claim's own policy insured to someone else", async () => {
    const invoice = `TAX INVOICE Invoice No 1\nCustomer Name: Sunil Kumar Sharma\nChassis No: ${VIN}`;
    const policy = "Private Car Package Policy\nPolicy No: 3001/123456\nInsured's Name: RAJESH KUMAR GUPTA\nRegistration No: NEW\nChassis No: MZBTEST12ABC34599\nPremium 12000";
    const ctx = {
      claim: { id: 'c', claimId: VIN, subCategoryId: 's', customerName: 'SUNIL KUMAR SHARMA' },
      documents: [{ id: 'd1', fileName: 'claim.pdf', storagePath: 'x', readablePath: 'x', mimeType: 'application/pdf', source: 'UPLOADED' as const, documentTypeId: null }],
      prisma: null as never, ocr: { extractImageText: async () => '' }, shared: new Map(), wordBoxes: new Map(), pageTexts: new Map([['d1', [invoice, policy]]]),
    };
    const codes = ((await compareValidator.run(ctx as never)).findings ?? []).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['CROSS_HOLDER_NAME_MISMATCH', 'CROSS_CHASSIS_MISMATCH']));
  });
});

describe('client sheet 2026-11 - Step 11 review fixes', () => {
  const VIN = 'MZBTEST12ABC34567';
  const POLICY = 'Motor Policy Schedule\nPolicy No. 991 Premium Sum Insured\n';

  // Value: protects=a different surname plus an extra word is no cut name; fails_when=any 3+ letter prefix counts as a clip; why_new=only same word counts were tested; seam=none; no_claim=QR caller
  it('keeps the cut-name rule to a clip of one or two letters', () => {
    expect(nameMatches('RAVI KUMAR DAS', 'RAVI KUMAR DASGUPTA SINGH')).toBe(false);
    expect(nameMatches('ORBIT GLOBAL SE', 'ORBIT GLOBAL SERVICES PVT')).toBe(true);
  });

  // Value: protects=policy ids, terms and units never enter the hard plate index; fails_when=a filter is dropped; why_new=only same-line labels and month dates were tested; seam=none; no_claim=real policy layouts
  it('reads no plate from a wrapped policy number, an id fragment or a policy term', () => {
    expect(platesOnPage(`${POLICY}Policy No:\nMH12AB3456\nRegistration No: KA05MN7788`)).toEqual(['KA05MN7788']);
    expect(platesOnPage(`${POLICY}Ref: 3001/MH12AB3456/2026`)).toEqual([]);
    expect(platesOnPage(`${POLICY}Ref: OG-MH12AB3456-00`)).toEqual([]);
    expect(platesOnPage(`${POLICY}Basic OD 1 Yr 5432.00\nOD 1 YR 2024 TP 3 YR 2027\nHP 88 BHP 1197\nAS 12 OF 2023\nTN 5 PM 2024`)).toEqual([]);
    expect(platesOnPage(`${POLICY}Regn No:-MH12AB3456`)).toEqual(['MH12AB3456']);
  });

  // Value: protects=a KGID number is its own identifier, never compared with an employee ID; fails_when=KGID is read as EMP_CODE again; why_new=only a page with both ids was tested; seam=none; no_claim=dupValidator wiring
  it('reads KGID as its own identifier, not an employee code', () => {
    expect(extractField('EMP_CODE', 'KGID No: 1234567')).toEqual([]);
    expect(extractIdentifiers('KGID No: 1234567')).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'KGID_NO', value: '1234567' })]));
    const staff = page(1, 'Identity Card\nName ANIL SHARMA\nEmployee ID: 5012345');
    const slip = page(2, 'Salary Slip\nNet Pay 50000\nKGID No: 1234567');
    expect(crossDocFieldFindings([staff, slip], VIN).map((f) => f.code)).not.toContain('CROSS_EMP_CODE_MISMATCH');
  });

  // Value: protects=reference numbers are no five-digit-year dates and a labelled bad date still flags; fails_when=the date label or real-day rule is dropped; why_new=the earlier rule flagged any 1-39 pair; seam=none; no_claim=other labels
  it('flags a five-digit year only on a real day or after a date label', () => {
    expect(checkDates('Policy No: 20/20/20012')).toEqual([]);
    expect(checkDates('INV/09-10/20012')).toEqual([]);
    expect(checkDates('Joining Date: 32-13-20000').map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
    expect(checkDates('DOB: 11.12.20000').map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
    expect(checkDates('DOB: 99/02/24').map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
    expect(checkDates('Printed 17-57-00')).toEqual([]);
  });

  // Value: protects=an OCR space inside the Udyam digits is no format error; fails_when=the split digits are not joined; why_new=only glued words were tested; seam=none; no_claim=line breaks inside the number
  it('joins an OCR-split Udyam number', () => {
    expect(checkUdyam('Udyam No: UDYAM-MH-12-123 4567')).toEqual([]);
    expect(checkUdyam('Udyam No: UDYAM-MH-12-1234567 2024')).toEqual([]);
  });

  // Value: protects=a health policy needs no relative's KYC; fails_when=any chassis-less policy counts as an old car paper; why_new=only motor papers were tested; seam=none; no_claim=motor policies whose chassis OCR lost
  it('skips a policy with no chassis in the relation KYC check', () => {
    const pan = page(5, 'INCOME TAX DEPARTMENT\nName\nSUNIL KUMAR SHARMA', 'PAN');
    const health = page(3, 'Group Health Insurance\nPolicy No: 12345\nSum Insured: 500000\nInsured Name: RAMESH VERMA');
    expect(relationKycFindings('SUNIL KUMAR SHARMA', [health, pan], VIN)).toEqual([]);
  });

  // Value: protects=an employee photo card is a staff card and a one-marker payslip stays a payslip; fails_when=the elector-only exclusion or the payslip tiebreak is dropped; why_new=only the elector card and multi-marker payslips were tested; seam=none; no_claim=other ties
  it('classifies an employee photo card and a payslip printing its employee number', () => {
    expect(classifyDocType('EMPLOYEE PHOTO IDENTITY CARD\nName: RAVI SHARMA')).toBe('STAFF_ID');
    expect(classifyDocType('PAY SLIP FOR MAY 2026\nEmployee No: 161234\nName: RAVI SHARMA\nTotal Deductions 1200')).toBe('PAYSLIP');
  });

  // Value: protects=a label with extra spacing and a company with a later OF stay rejected; fails_when=the cut splits on one space or skips the company veto; why_new=only single-spaced person names were tested; seam=none; no_claim=other company words
  it('rejects a widely spaced label and a company name cut at OF', () => {
    expect(cleanPersonName('WID  OF RAM GUPTA')).toBeNull();
    expect(cleanPersonName('STEEL AUTHORITY OF INDIA LIMITED')).toBeNull();
    expect(cleanPersonName('RAM KRISHNA AND SONS PVT LTD')).toBeNull();
  });

  // Value: protects=every printed form of one plate is looked up under its earlier norm; fails_when=only the first spelling's legacy norm is asked; why_new=one spelling was tested; seam=none; no_claim=no database (ctx.prisma is stubbed)
  it('asks the earlier norm of every spelling of one plate', async () => {
    const asked: string[] = [];
    const prisma = {
      claimFieldValue: {
        deleteMany: async () => ({}),
        createMany: async () => ({}),
        findMany: async ({ where }: { where: { field: string; norm: { in: string[] } } }) => {
          if (where.field === 'VEHICLE_NO') asked.push(...where.norm.in);
          return where.field === 'VEHICLE_NO' && where.norm.in.includes('MH1AB1234') ? [{ norm: 'MH1AB1234', claim: { claimId: 'OLDCLAIM1' } }] : [];
        },
      },
    };
    const text = 'Certificate of Registration\nRegistration No: MH01AB1234\nRegn. Validity 2030\nVehicle No: MH1AB1234';
    const outcome = await dupValidator.run({
      claim: { id: 'c1', claimId: VIN, subCategoryId: 's1' },
      documents: [],
      prisma: prisma as never,
      ocr: {} as never,
      shared: new Map([['d1', text]]),
      pageTexts: new Map([['d1', [text]]]),
      wordBoxes: new Map(),
    });
    expect(asked).toContain('MH1AB1234');
    expect(outcome.findings?.map((f) => f.code)).toContain('DUP_VEHICLE_NO');
  });

  // Value: protects=a strict holder name is compared whole, never by its leading words; fails_when=the h.loose guard on leadingWordsMatch is dropped; why_new=only loose payslip names were tested; seam=none; no_claim=other strict types
  it('does not give a labelled policy holder the leading-words match', () => {
    const policy = page(3, `Private Car Package Policy\nInsured's Name: RAVI SHARMA PATIL\nRegistration No: NEW\nChassis No: ${VIN}\nPremium 12000`);
    expect(holderNameFindings('RAVI KUMAR SHARMA', [policy], VIN).map((f) => f.code)).toEqual(['CROSS_HOLDER_NAME_MISMATCH']);
  });
});

describe('client sheet 2026-11 - ship run 3 review fixes', () => {
  const VIN = 'MZBTEST12ABC34567';

  // Value: protects=a malformed Udyam number after a two-letter label is still read; fails_when=a skipped title candidate resumes past the number; why_new=only colon labels were tested; seam=none; no_claim=other label words
  it('reads a malformed Udyam number after a short label', () => {
    expect(checkUdyam('Udyam No UDYAM-MH-1A-1234567').map((f) => f.code)).toEqual(['REDFLAG_UDYAM_FORMAT']);
    expect(checkUdyam('UDYAM ID UDYAM-MH-1A-1234567').map((f) => f.code)).toEqual(['REDFLAG_UDYAM_FORMAT']);
    expect(checkUdyam('UDYAM REGISTRATION CERTIFICATE\nUDYAM-MH-12-1234567')).toEqual([]);
  });

  // Value: protects=the claim's own RC in another person's name keeps its red line when the old RC shares that owner; fails_when=the dedupe drops the claim-wide line by name alone; why_new=own and old RC were tested with different owners; seam=none; no_claim=no database
  it("keeps the own RC's name line when the old RC has the same owner", async () => {
    const invoice = `TAX INVOICE Invoice No 1\nCustomer Name: Sunil Kumar Sharma\nChassis No: ${VIN}`;
    const own = `CERTIFICATE OF REGISTRATION Registering Authority\nChassis No: ${VIN}\nOwner Name: Ramesh Prasad Verma`;
    const old = 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: Ramesh Prasad Verma';
    const ctx = {
      claim: { id: 'c', claimId: VIN, subCategoryId: 's', customerName: 'SUNIL KUMAR SHARMA' },
      documents: [{ id: 'd1', fileName: 'claim.pdf', storagePath: 'x', readablePath: 'x', mimeType: 'application/pdf', source: 'UPLOADED' as const, documentTypeId: null }],
      prisma: null as never, ocr: { extractImageText: async () => '' }, shared: new Map(), wordBoxes: new Map(), pageTexts: new Map([['d1', [invoice, own, old]]]),
    };
    const codes = ((await compareValidator.run(ctx as never)).findings ?? []).map((f) => f.code);
    expect(codes).toEqual(expect.arrayContaining(['CROSS_NAME_MISMATCH', 'CROSS_INVOICE_RC_DIFF_NAME']));
  });
});

describe('client sheet 2026-11 - ship run 3 pass 2 fixes', () => {
  const VIN = 'MA3EWDE1S00123456';

  // Value: protects=a date label only marks the value right after it; fails_when=a label anywhere earlier on the line counts; why_new=labelled values were tested alone on a line; seam=none; no_claim=labels more than 20 characters away
  it('lets a date label mark only the value right after it', () => {
    expect(checkDates('Invoice Date: 01-04-2024 Invoice No: INV/24-25/20012')).toEqual([]);
    expect(checkDates('Policy Date 01/04/2024 Policy No: 20/20/20012')).toEqual([]);
    expect(checkDates('Txn Date: 12/03/2024 Time: 17-57-00')).toEqual([]);
    expect(checkDates('Joining Date: 32-13-20000').map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
  });

  // Value: protects=an old car policy holder read on into the next column is still the customer; fails_when=the holder is compared whole only; why_new=only clean holder lines were tested; seam=none; no_claim=a relative sharing the first two words
  it('reads a run-on old policy holder as the customer, but not a stranger', () => {
    const pan = page(2, 'INCOME TAX DEPARTMENT\nName\nRAVI KUMAR SHARMA', 'PAN');
    const policy = (holder: string) =>
      page(5, `PRIVATE CAR PACKAGE POLICY\nPolicy No: 3001/12/00\nPremium 9000\nChassis No: MA3FJEB1S00987654\nINSURED NAME : ${holder} CONTACT NO : 9876543210`);
    expect(relationKycFindings('RAVI KUMAR SHARMA', [pan, policy('RAVI SHARMA')], VIN)).toEqual([]);
    expect(relationKycFindings('RAVI KUMAR SHARMA', [pan, policy('SURESH VERMA')], VIN).map((f) => f.code)).toEqual(['CROSS_RELATION_KYC_MISMATCH']);
  });
});

describe('client sheet 2026-11 - ship run 3 fix-check fixes', () => {
  const VIN = 'MA3EWDE1S00123456';

  // Value: protects=a value after a slash is a document number even under a combined label; fails_when=the slash guard is skipped for labelled values; why_new=only plain "Invoice No:" lines were tested; seam=none; no_claim=a combined label without a slash
  it('reads no date in a document number under a combined number-and-date label', () => {
    expect(checkDates('Invoice No. & Date : INV/24-25/20012 Dt. 01/04/2024')).toEqual([]);
    expect(checkDates('Bill No & Dt: INV/09-10/20012')).toEqual([]);
    expect(checkDates('Joining Date: 32-13-20000').map((f) => f.code)).toEqual(['REDFLAG_BAD_DATE']);
  });

  // Value: protects=a father's old RC in a surname-first name still needs his KYC; fails_when=the holder is matched by a looser word subset; why_new=only given-name-first names were tested; seam=none; no_claim=column words outside the list
  it("flags a surname-first father's old RC and cuts a holder at a column word", () => {
    const pan = page(2, 'INCOME TAX DEPARTMENT\nName\nSHINDE RAHUL SURESH', 'PAN');
    const rc = page(4, 'Registration Certificate Registering Authority\nChassis No: MAKOLD99ZXY12345\nOwner Name: SHINDE SURESH VITTHAL');
    expect(relationKycFindings('SHINDE RAHUL SURESH', [pan, rc], VIN).map((f) => f.code)).toEqual(['CROSS_RELATION_KYC_MISMATCH']);
    const rcPan = page(2, 'INCOME TAX DEPARTMENT\nName\nRAVI KUMAR SHARMA', 'PAN');
    const policy = page(5, 'PRIVATE CAR PACKAGE POLICY\nPolicy No: 3001/12/00\nPremium 9000\nChassis No: MA3FJEB1S00987654\nINSURED NAME : RAVI KUMAR SHARMA HYPOTHECATED TO : HDFC BANK');
    expect(relationKycFindings('RAVI KUMAR SHARMA', [rcPan, policy], VIN)).toEqual([]);
  });
});
