import { holderName, holderNameFindings, oldCarNameFindings, rcOwnerName } from '../holderNames.js';
import { classifyDocType, chassisCandidates, extractNames, nameMatches, sameVehicle, oldCarPaperFindings, isNewRegistration, otherNewCarPolicies, newCarPolicyFindings, type CrossPage } from '../crossDocLogic.js';
import { classifyPage } from '../segment.js';

// An OCR-mangled RC title; client sheet 2026-10-31 row 24.
const OLD_RC = [
  'CERTIFICATE GK ReGYTRALON 277',
  'I. Registration Number ~~ TG00XX0001 24, Registered Axle Welght (Kgs)',
  '2. Vehicle Class Motor Cab Front Axle 959',
  'ACME LOGISTICS Rear Ale 1051',
  "3. Registered Ow es. ay'",
  '! net PRIVATE LIMITED Any Other Ale',
  'Ownership Type CMPY 26. Tax valid til 29/03/2037',
  '12. Chassis Number MATBS53007RLH00222',
  '13. Engine Number TZ180XS91AB24000001',
].join('\n');

const pg = (page: number, text: string): CrossPage => ({ documentId: 'doc', page, text });
const CLAIM = 'MZBGD81AUTN000111';
const pgc = (page: number, text: string): CrossPage => ({ documentId: 'doc', page, text, govtCode: classifyPage(text) });
const INVOICE = 'TAX INVOICE\nInvoice No: INV-1\nHypothecation\nCustomer Name: ANIL KUMAR SHARMA\nChassis No: MZBGD81AUTN000111\nTotal Amount 1500000';
const NEW_POLICY_OTHER = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000002\nInsured's Name : MR. RAVI KUMAR\nRegistration No. New Chassis No. MZBGB814LTN310444 Engine No. G4FLTV300001";
const NEW_POLICY_OWN = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000003\nInsured's Name : MR. ANIL KUMAR SHARMA\nRegistration No. New Chassis No. MZBGD81AUTN000111 Engine No. G4FLTV300002";
const OWN_POLICY = 'CERTIFICATE OF INSURANCE\nPolicy No 0221003126P1\nName of the Insured ACME LOGISTICS PRIVATE LIMITED\nParticulars of Vehicle Insured\nChassis No.\nMZBGD81AUTNOO0111F HTX 7 / 42';
const OTHER_TEMP_RC = 'Temporary Certificate of Registration\nName of the Owner : RAVI KUMAR\nChassis No : MZBGB814LTN310444';
const OTHER_POLICY = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000001\nInsured's Name : MR. RAVI KUMAR\nRegistration No, Registration Authority Chassis No. Engine No. COIKW\nNew MEDCHAL MZBGBSI4LTNI0444 G4FLTV300001 1497";
const policyWith = (chassis: string) => `Policy No 1\nInsured Name: X\nChassis No.\n${chassis}`;

describe('client sheet 2026-10-31 - old car papers', () => {
  it('an RC whose title OCR mangled is still an RC by its owner fields', () => {
    expect(classifyDocType(OLD_RC)).toBe('RC');
  });

  it('a policy that mentions the registered owner stays a policy', () => {
    expect(classifyDocType('Policy No: 123\nInsured Name: X\nPremium 100\nThe registered owner of the vehicle shall ...')).toBe('INSURANCE');
  });
  it("an OCR-split chassis on the customer's own policy is not a red flag", () => {
    expect(oldCarPaperFindings([pg(5, 'Policy No 1\nInsured Name: X\nChassis No: MZBGD81AUTN 000111'), pg(10, OLD_RC)], CLAIM)).toEqual([]);
  });

  it("a masked chassis on the old car RC does not flag that car's policy", () => {
    for (const masked of ['MA3EYDB1S00******', 'MA3EYDB1S00XXXXXX']) {
      const rc = `Registration Certificate\nOwnership Type INDIVIDUAL\nChassis No: ${masked}`;
      const pol = 'Policy No 1\nInsured Name: X\nChassis No: MA3EYDB1S00400888';
      expect(oldCarPaperFindings([pg(1, rc), pg(2, pol)], CLAIM)).toEqual([]);
    }
  });

  it('a front-masked chassis on the old car RC is partial, so it cannot raise the flag', () => {
    const rc = 'Registration Certificate\nOwnership Type INDIVIDUAL\nChassis No: XXXXXXXXXXXX00888';
    const pol = 'Policy No 1\nInsured Name: X\nChassis No: MA3EYDB1S00400888';
    expect(oldCarPaperFindings([pg(1, rc), pg(2, pol)], CLAIM)).toEqual([]);
  });

  it('a claim ID that is not VIN-shaped gives nothing to compare against', () => {
    expect(oldCarPaperFindings([pg(5, policyWith('MA3EYDB1S00400888')), pg(10, OLD_RC)], '12345678901234567')).toEqual([]);
  });

  it('a registration number in an empty chassis cell is not a chassis', () => {
    expect(oldCarPaperFindings([pg(5, 'Policy No 1\nInsured Name: X\nChassis No KA01AB1234 Engine No E1'), pg(10, OLD_RC)], CLAIM)).toEqual([]);
  });

  it('row 24: a policy for another car than the old car RC is a red flag', () => {
    const out = oldCarPaperFindings([pg(5, OWN_POLICY), pg(10, OLD_RC), pg(14, OTHER_TEMP_RC), pg(17, OTHER_POLICY)], CLAIM);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      code: 'CROSS_OLD_CAR_CHASSIS_MISMATCH',
      severity: 'ERROR',
      page: 17,
      data: { field: 'CHASSIS', actual: 'MZBGBSI4LTNI0444', expected: 'MATBS53007RLH00222', rcPage: 10 },
    });
  });

  it('a permanent RC for that other car pairs with its policy', () => {
    const permanent = OTHER_TEMP_RC.replace('Temporary Certificate of Registration', 'Certificate of Registration');
    expect(classifyDocType(permanent)).toBe('RC');
    expect(oldCarPaperFindings([pg(5, OWN_POLICY), pg(10, OLD_RC), pg(14, permanent), pg(17, OTHER_POLICY)], CLAIM)).toEqual([]);
  });

  it('the family car in a loyalty claim: RC and policy of one car agree', () => {
    const rc = 'Registration Certificate\nRegistered Owner: SITA DEVI\nOwnership Type INDIVIDUAL\nChassis No: MZBGB813LSN200777';
    expect(oldCarPaperFindings([pg(1, rc), pg(2, policyWith('MZBGBBI3ILSN200777'))], CLAIM)).toEqual([]);
  });

  it("the customer's own policy with a garbled VIN is not an old-car policy", () => {
    const rc = 'Registration Certificate\nOwnership Type INDIVIDUAL\nChassis No: MA3IMTB1SSAC00001';
    const own = OTHER_POLICY.replace('MZBGBSI4LTNI0444', 'MZBEPSI3LSNT00555');
    expect(oldCarPaperFindings([pg(1, rc), pg(2, own)], 'MZBEP813LSN700555')).toEqual([]);
  });

  it('#32: the same old car with differently written registration numbers is not flagged', () => {
    const rc = 'Registration Certificate\nRegn No KA-01-AB-1234\nChassis No: MA3EYDB1S00400888';
    const pol = 'Policy No 1\nInsured Name: X\nRegistration No KA01AB1234\nChassis No: MA3EYDB1S00400888';
    expect(oldCarPaperFindings([pg(1, rc), pg(2, pol)], CLAIM)).toEqual([]);
  });

  it('two old cars, each with its own RC and policy, are not flagged', () => {
    const rc1 = 'Registration Certificate\nOwnership Type INDIVIDUAL\nChassis No: MA3EYDB1S00400888';
    const rc2 = 'Registration Certificate\nOwnership Type INDIVIDUAL\nChassis No: MALBMS1BLLM000999';
    expect(
      oldCarPaperFindings([pg(1, rc1), pg(2, rc2), pg(3, policyWith('MA3EYDB1S00400888')), pg(4, policyWith('MALBMS1BLLM000999'))], CLAIM),
    ).toEqual([]);
  });

  it('a policy with no readable chassis is silent', () => {
    expect(oldCarPaperFindings([pg(1, OLD_RC), pg(2, 'Policy No 1\nInsured Name: X\nPremium 100')], CLAIM)).toEqual([]);
  });

  it('company, policy and receipt numbers are not chassis numbers', () => {
    expect(chassisCandidates('Chassis No.\nCIN 10MH2000PLCI99999 Ref MH000000000202500E 202500PNT0000001')).toEqual([]);
    expect(chassisCandidates('12. Chassis Number MATBS53007RLH00222')).toEqual(['MATBS53007RLH00222']);
  });

  it('two real cars two serial digits apart count as one (accepted)', () => {
    // An old car is never serial-adjacent to the new one, so the loose match costs nothing.
    expect(sameVehicle('MZBGB814LTN100014', 'MZBGB814LTN100026')).toBe(true);
  });
});

describe('client sheet 2026-10-31 - names', () => {
  it('reads the insured, not the broker, and stops at the next column label', () => {
    expect(extractNames('POLICY SCHEDULE\nInmureds Name: MR RAVI TEJA Peri of Insurance 01/01/2026\nBoker Name + XYZ nsisance Brokers Pt. Lid')).toEqual(['RAVI TEJA']);
  });
  it('never reads a Partner Name as the customer', () => {
    expect(extractNames('Partner Name: SUNIL VERMA Car Partner')).toEqual([]);
  });
  it('reads a Sri / Smt payslip holder', () => {
    expect(extractNames('PAY SLIP FOR THE MONTH OF MAY 2026\nSri / Smt: FARHAN .\nQURESHI\nBasic Pay 30000')).toEqual(['FARHAN']);
  });
  it('cuts a caps name at the next column label', () => {
    expect(extractNames('Owner Name: ANIL KUMAR SHARMA Area Office')).toEqual(['ANIL KUMAR SHARMA']);
  });
  it('skips the insurer claim contact in the issuing-office block', () => {
    expect(extractNames('POLICY ISSUING OFFICE: BUSINESS CHANNEL CLAIM CONTACT:\nMG NAGAR DO (100200), NAME:Mr. K. RAMA RAJU - | |\nInsured Name: SITA DEVI')).toEqual(['SITA DEVI']);
  });
  it('never cuts a mixed-case name', () => {
    expect(extractNames('Customer Name: Anil Kumar Sharma')).toEqual(['Anil Kumar Sharma']);
  });
  it('matches -bhai/-kumar forms, -ben, and a split given name', () => {
    expect(nameMatches('HARESHBHAI DESAI', 'HARESHKUMAR D DESAI')).toBe(true);
    expect(nameMatches('MEENABEN SHAH', 'MEENA SHAH')).toBe(true);
    expect(nameMatches('RAVI SAIKIRAN', 'SAI KIRAN RAVI')).toBe(true);
  });
  it('still separates different -bhai given names and different -kumar names', () => {
    expect(nameMatches('DINESHBHAI PATEL', 'MAHESHBHAI PATEL')).toBe(false);
    expect(nameMatches('RAJESH KUMAR', 'MUKESH KUMAR')).toBe(false);
  });
  // Decision 3's accepted side effect: the fold also reads "RAJKUMAR" as "RAJ". Pinned so a
  // change to it is a deliberate one.
  it('folds a 7+ letter -kumar given name to its stem, and leaves a short one alone', () => {
    expect(nameMatches('RAJKUMAR SINGH', 'RAJ SINGH')).toBe(true);
    expect(nameMatches('KUMAR SINGH', 'RAJ SINGH')).toBe(false);
  });
});

describe('client sheet 2026-10-31 - new-car policy', () => {
  const TABLE_POLICY = 'Policy No. D000000005\nInsured Name: RAVI KUMAR\nRegistration Number Chassis no./Engine Number\nNew MZBGB814LTN310444/G4F';

  it('reads "Registration No. New" on the line or under a table header', () => {
    expect(isNewRegistration(NEW_POLICY_OTHER)).toBe(true);
    expect(isNewRegistration(TABLE_POLICY)).toBe(true);
    expect(isNewRegistration('Registration No. TS09AB1234')).toBe(false);
    expect(isNewRegistration('Regn. No. New Delhi 110001')).toBe(false);
    expect(isNewRegistration('Registration No.: TS09AB1234\nNew India Assurance Company Limited')).toBe(false);
    expect(isNewRegistration('Regn. No. WB02AB1234\nNew Town Kolkata 700156')).toBe(false);
  });

  it("flags a new-car policy for a chassis that is neither the claim's nor an RC's", () => {
    const f = newCarPolicyFindings([pgc(1, INVOICE), pgc(2, NEW_POLICY_OWN), pgc(3, NEW_POLICY_OTHER)], CLAIM, new Set());
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      code: 'CROSS_POLICY_OTHER_VEHICLE',
      severity: 'ERROR',
      page: 3,
      message: `Policy on page 3 is for a newly registered vehicle with chassis MZBGB814LTN310444, not this claim's vehicle (${CLAIM}), and no RC in the claim carries that chassis.`,
      data: { field: 'CHASSIS', actual: 'MZBGB814LTN310444', expected: CLAIM },
    });
  });

  it('stays quiet when an RC in the bundle carries that chassis', () => {
    const rc = pgc(4, 'Temporary Certificate of Registration\nName of the Owner : RAVI KUMAR\nChassis No : MZBGB814LTN310444');
    expect(newCarPolicyFindings([pgc(1, INVOICE), pgc(3, NEW_POLICY_OTHER), rc], CLAIM, new Set())).toEqual([]);
  });

  it('skips pages in the skip set', () => {
    expect(newCarPolicyFindings([pgc(3, NEW_POLICY_OTHER)], CLAIM, new Set(['doc:3']))).toEqual([]);
  });

  it('lists a policy with an unreadable chassis but raises nothing for it', () => {
    const t = NEW_POLICY_OTHER.replace('MZBGB814LTN310444', 'joe No. cemw');
    expect(newCarPolicyFindings([pgc(3, t)], CLAIM, new Set())).toEqual([]);
    const o = otherNewCarPolicies([pgc(3, t)], CLAIM);
    expect(o).toHaveLength(1);
    expect(o[0].chassis).toEqual([]);
  });

  it('does not flag the claim\'s own policy when OCR split its VIN', () => {
    const own = pgc(2, NEW_POLICY_OWN.replace('MZBGD81AUTN000111', 'MZBGD81AUTN 000111'));
    expect(chassisCandidates(own.text)).toEqual(['MZBGD81AUTN']);
    expect(newCarPolicyFindings([pgc(1, INVOICE), own], CLAIM, new Set())).toEqual([]);
    expect(otherNewCarPolicies([pgc(1, INVOICE), own], CLAIM)).toEqual([]);
  });

  it('raises nothing when the claim id is not a full VIN', () => {
    const pages = [pgc(1, INVOICE), pgc(3, NEW_POLICY_OTHER)];
    expect(newCarPolicyFindings(pages, 'CLM-2026-001', new Set())).toEqual([]);
    expect(newCarPolicyFindings(pages, '', new Set())).toEqual([]);
    expect(otherNewCarPolicies(pages, '')).toEqual([]);
  });

  it('pairs a masked RC chassis with the policy chassis', () => {
    const rc = pgc(4, 'Certificate of Registration\nOwner Name: RAVI KUMAR\nChassis No : MZBGB814LTN31****');
    expect(classifyDocType(rc.text)).toBe('RC');
    expect(chassisCandidates(rc.text)).toEqual(['MZBGB814LTN31']);
    expect(newCarPolicyFindings([pgc(3, NEW_POLICY_OTHER), rc], CLAIM, new Set())).toEqual([]);
  });

  it('reports the first full chassis, not a junk candidate before it', () => {
    const t = NEW_POLICY_OTHER.replace('Chassis No. MZBGB814LTN310444', 'Chassis No. 12AB34CD56 / MZBGB814LTN310444');
    expect(chassisCandidates(t)[0]).toBe('12AB34CD56');
    const f = newCarPolicyFindings([pgc(3, t)], CLAIM, new Set());
    expect(f).toHaveLength(1);
    expect(f[0].data).toMatchObject({ actual: 'MZBGB814LTN310444' });
  });

  it('lists a policy whose only chassis is a partial but raises nothing', () => {
    const t = NEW_POLICY_OTHER.replace('MZBGB814LTN310444', 'AB12CD34EF');
    expect(otherNewCarPolicies([pgc(3, t)], CLAIM)).toHaveLength(1);
    expect(newCarPolicyFindings([pgc(3, t)], CLAIM, new Set())).toEqual([]);
  });
});

describe('client sheet 2026-10-31 - holder names', () => {
  const DMS = 'ANIL KUMAR SHARMA';
  const STAFF_NAME_P = 'ACME PUBLIC SCHOOL\nIdentity Card\n| Name P KIRAN VARMA\nDesignation TEACHER\nEmployee ID: E1234';
  const STAFF_ABOVE = 'ACME INDUSTRIES LIMITED\nIDENTITY CARD\nKiran Varma\nEmployee ID: E1234\nDesignation Manager';
  const PAYSLIP = 'ACME INDUSTRIES LIMITED\nPAY SLIP FOR THE MONTH OF MAY 2026\nSri / Smt: KIRAN .\nVARMA\nEmployee Code E1234\nBasic Pay 30000\nNet Pay 28000\nGross Earnings 31000';
  const OLD_RC_P = 'Registration Certificate\nOwner Name\nRAVI KUMAR\nOwnership Type INDIVIDUAL\nChassis No: MA3EWDE1S00000777';
  const OLD_POLICY = "CERTIFICATE OF INSURANCE\nPolicy No. D000000004\nInsured's Name : MR. SURESH VERMA\nRegistration No. TS09AB1234 Chassis No. MA3EWDE1S00000777";
  // Synthetic: a voter card whose text also trips the staff-ID markers.
  const VOTER_STAFF = 'Election Commission of India\nIdentity Card\nElector Photo Identity Card\nEPIC No: ABC1234567\nName: MEERA PATEL\nEmployee ID: E1234';

  const one = (text: string, name = DMS) => holderNameFindings(name, [pgc(1, INVOICE), pgc(2, text)], CLAIM);

  it('flags a staff ID read from the "Name P" layout (row 30)', () => {
    const f = one(STAFF_NAME_P);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      code: 'CROSS_HOLDER_NAME_MISMATCH',
      severity: 'ERROR',
      page: 2,
      data: { actual: 'KIRAN VARMA', expected: DMS, expectedType: 'DMS', actualType: 'STAFF_ID' },
    });
  });

  it('flags a staff ID whose name sits above the Employee ID line (row 29)', () => {
    const f = one(STAFF_ABOVE);
    expect(f).toHaveLength(1);
    expect(f[0].data).toMatchObject({ actual: 'Kiran Varma', actualType: 'STAFF_ID' });
  });

  it('flags a payslip holder (row 31)', () => {
    const f = one(PAYSLIP);
    expect(f).toHaveLength(1);
    expect(f[0].data).toMatchObject({ actual: 'KIRAN', actualType: 'PAYSLIP' });
  });

  it("flags another car's new-car policy but not the claim's own (rows 26, 32)", () => {
    const f = holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, NEW_POLICY_OWN), pgc(3, NEW_POLICY_OTHER)], CLAIM);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ page: 3, data: { actual: 'RAVI KUMAR', actualType: 'INSURANCE' } });
  });

  it('stays quiet when the holder is the customer', () => {
    expect(one(STAFF_NAME_P.replace('KIRAN VARMA', 'ANIL K SHARMA'))).toEqual([]);
  });

  it('never compares a voter card, even with a staff marker', () => {
    const p = pgc(2, VOTER_STAFF);
    expect(p.govtCode).toBe('VOTER_ID');
    expect(classifyDocType(p.text)).toBe('STAFF_ID');
    expect(holderName(p, new Set())).toBeNull();
    expect(one(VOTER_STAFF)).toEqual([]);
  });

  it('falls back to the invoice name when there is no DMS name', () => {
    const f = holderNameFindings(null, [pgc(1, INVOICE), pgc(2, PAYSLIP)], CLAIM);
    expect(f).toHaveLength(1);
    expect(f[0].data).toMatchObject({ expectedType: 'INVOICE', expected: 'ANIL KUMAR SHARMA' });
  });

  it('has nothing to compare against without a DMS name or an invoice name', () => {
    expect(holderNameFindings(null, [pgc(2, PAYSLIP)], CLAIM)).toEqual([]);
  });

  it('leaves a labelled invoice to dmsNameFindings', () => {
    expect(holderNameFindings('SURESH VERMA', [pgc(1, INVOICE)], CLAIM)).toEqual([]);
  });

  describe('staff ID "Name" reader (I3, M1)', () => {
    it.each([
      ["a father's-name row", "ACME PUBLIC SCHOOL\nIdentity Card\nANIL KUMAR SHARMA\nFather's Name RAMESH SHARMA\nEmployee ID: E1234"],
      ['an organisation-name row', 'ACME PUBLIC SCHOOL\nIdentity Card\nOrganisation Name: ACME PUBLIC SCHOOL\nName ANIL KUMAR SHARMA\nEmployee ID: E1234'],
    ])('does not read %s as the holder', (_n, text) => {
      expect(one(text)).toEqual([]);
    });

    it('reads "| Name P KIRAN VARMA" as KIRAN VARMA', () => {
      expect(holderName(pgc(2, STAFF_NAME_P), new Set())?.name).toBe('KIRAN VARMA');
    });

    it('keeps a middle initial between longer words', () => {
      expect(holderName(pgc(2, 'Identity Card\nName ANIL K SHARMA\nEmployee ID: E1234'), new Set())?.name).toBe('ANIL K SHARMA');
    });

    it('does not take a trailing single capital from the next column', () => {
      expect(one('Identity Card\nName ANIL SHARMA D.O.B 01/01/1990\nEmployee ID: E1234')).toEqual([]);
      expect(holderName(pgc(2, 'Identity Card\nName ANIL SHARMA M 35\nEmployee ID: E1234'), new Set())?.name).toBe('ANIL SHARMA');
    });

    it('cuts the name at the next ALL-CAPS label', () => {
      expect(holderName(pgc(2, 'Identity Card\nName ANIL SHARMA DESIGNATION TEACHER\nEmployee ID: E1234'), new Set())?.name).toBe('ANIL SHARMA');
    });
  });

  describe('staff ID layout fallback and the customer on the card (I4)', () => {
    const P = 'ACME INDUSTRIES LIMITED\nIDENTITY CARD\nANIL KUMAR SHARMA\n';
    it.each([
      ['a bare designation', `${P}Senior Manager\nEmp Code: E1234`],
      ['a department line', `${P}SALES DEPARTMENT\nEmp Code: E1234`],
      ['a label-less designation row', `${P}Designation TEACHER\nEmployee ID: E1234`],
      ['a "Designation:" row', `${P}Designation: Senior Teacher\nEmployee ID: E1234`],
      ['a blood group row', `${P.replace('ANIL KUMAR SHARMA', 'Anil Kumar Sharma')}Blood Group B Positive\nEmployee ID: E1234`],
      ['a validity row', `${P}Valid Upto Dec 2027\nEmployee ID: E1234`],
      ['a signature caption', `${P}Holder Signature\nEmployee ID: E1234`],
      ['the masthead only', 'ACME INDUSTRIES LIMITED\nIDENTITY CARD\n~~ ..\nEmployee ID: E1234'],
      ['the employer above the id', 'IDENTITY CARD\nACME INDUSTRIES LIMITED\nEmployee ID: E1234'],
      ['a mixed-case Name row', 'ACME INDUSTRIES LIMITED\nIDENTITY CARD\nName Anil Sharma\nEmployee ID: E1234'],
      ['an employment letter', 'ACME INDUSTRIES LIMITED\nTo Whom It May Concern\nEmployee ID: E1234\nThis is to certify that the above is employed with us.'],
      ['a designation under a name with an initial', `ACME INDUSTRIES LIMITED\nIDENTITY CARD\nANIL K SHARMA\nSALES EXECUTIVE\nEmp Code: E1234`],
      ['a combined KYC photocopy', 'Government of India\nUnique Identification Authority of India\nANIL KUMAR SHARMA\nDOB: 01/01/1990\nACME LTD Identity Card\nEmployee ID: E1234'],
    ])('gives no finding for %s', (_n, text) => {
      expect(one(text)).toEqual([]);
    });

    it('keeps the customer\'s own initial-led name from raising a finding', () => {
      const card = 'ACME INDUSTRIES LIMITED\nIDENTITY CARD\nK. RAMESH\nJunior Engineer\nEmp Code: E1234';
      expect(one(card, 'K RAMESH')).toEqual([]);
      expect(one(card.replace('K. RAMESH', 'A. K. Sharma').replace('Junior Engineer', 'Assistant Professor'), 'A K SHARMA')).toEqual([]);
    });

    it('still flags a different person whose name has an initial', () => {
      expect(one('ACME INDUSTRIES LIMITED\nIDENTITY CARD\nK VARMA\nName KIRAN K VARMA\nEmployee ID: E1234')).toHaveLength(1);
    });

    it('still flags another person when the customer is not on the card', () => {
      expect(one(STAFF_ABOVE)).toHaveLength(1);
      expect(one(PAYSLIP)).toHaveLength(1);
    });
  });

  describe('label-less invoice holder (I1)', () => {
    const PRE = 'TAX INVOICE\nInvoice No: INV-1\n';
    it.each([
      ['a canteen buyer', 'Bill To: THE AREA MANAGER CANTEEN STORES DEPARTMENT'],
      ['an address under the label', 'Sold To: Anil Kumar Sharma\nGANDHI NAGAR HYDERABAD'],
      ['a GSTIN line under Tally\'s label', 'Buyer (Bill to)\nGSTIN UNREGISTERED\nANIL KUMAR SHARMA'],
      ['a company with the customer on Ship To', 'Bill To: ACME MOTORS PVT LTD\nShip To: ANIL KUMAR SHARMA'],
      ["the next column's caps header", 'Bill To Ship To CONSIGNEE DETAILS\nChassis No: MZBGD81AUTN000111'],
      ['a delivery unit, not a person', 'Bill To Address Ship To INDIAN ARMY UNIT'],
    ])('gives no finding for %s', (_n, body) => {
      expect(holderNameFindings(DMS, [pgc(1, PRE + body)], CLAIM)).toEqual([]);
    });

    it("still reads Tally's Buyer (Bill to) with the value on the next line", () => {
      const f = holderNameFindings(DMS, [pgc(1, `${PRE}Buyer (Bill to)\nRAVI KUMAR\nChassis No: MZBGD81AUTN000111`)], CLAIM);
      expect(f).toHaveLength(1);
      expect(f[0].data).toMatchObject({ actual: 'RAVI KUMAR', actualType: 'INVOICE' });
    });

    // Real invoices put only OCR noise or the next column's header between the label and the
    // name: "Bill To (c) NAME" (row 26) and "Bill To Address Ship To NAME" (row 19).
    it.each([
      ['an OCR mark after the label', 'Bill To ~ RAVI KUMAR'],
      ["the next column's header after the label", 'Bill To Address Ship To RAVI KUMAR'],
    ])('reads the buyer through %s', (_n, body) => {
      const f = holderNameFindings(DMS, [pgc(1, PRE + body)], CLAIM);
      expect(f.map((x) => x.data)).toMatchObject([{ actual: 'RAVI KUMAR', actualType: 'INVOICE' }]);
    });
  });

  // Row 32: the insured field reader stops at a middle initial, so the finding showed one word
  // where the CROSS_NAME_MISMATCH it replaces had shown the whole name.
  it('reports the whole insured name when it has a middle initial', () => {
    const pol = NEW_POLICY_OTHER.replace('MR. RAVI KUMAR', 'MR. RAVI K VERMA');
    const f = holderNameFindings(DMS, [pgc(1, INVOICE), pgc(3, pol)], CLAIM);
    expect(f.map((x) => x.data)).toMatchObject([{ actual: 'RAVI K VERMA', actualType: 'INSURANCE' }]);
  });

  it("does not take another line's name that shares the insured's first word", () => {
    const pol = NEW_POLICY_OTHER.replace('Policy No.', 'Name: RAVI SHANKAR\nPolicy No.').replace('MR. RAVI KUMAR', 'MR. RAVI');
    const f = holderNameFindings(DMS, [pgc(1, INVOICE), pgc(3, pol)], CLAIM);
    expect(f.map((x) => x.data?.actual)).not.toContain('RAVI SHANKAR');
  });

  describe('holder readers stop at the next field (I1)', () => {
    const PRE = 'TAX INVOICE\nInvoice No: INV-1\n';
    it.each(['HOUSE NO 4-5 KPHB COLONY', 'FLAT NO 101 KPHB COLONY'])('cuts a label-less buyer before the address "%s"', (addr) => {
      expect(holderNameFindings(DMS, [pgc(1, `${PRE}Bill To ANIL SHARMA ${addr}\nChassis No: MZBGD81AUTN000111`), pgc(2, NEW_POLICY_OWN)], CLAIM).filter((f) => f.data?.actualType === 'INVOICE')).toEqual([]);
    });

    it('does not fail the customer\'s own payslip when the invoice is the reference', () => {
      const inv = `${PRE}Bill To ANIL SHARMA HOUSE NO 4-5 KPHB COLONY\nChassis No: MZBGD81AUTN000111`;
      const pay = 'ACME INDUSTRIES LIMITED\nPAY SLIP FOR THE MONTH OF MAY 2026\nEmployee Name: ANIL KUMAR SHARMA\nEmployee Code E1234\nBasic Pay 30000\nNet Pay 28000\nGross Earnings 31000';
      expect(holderNameFindings(null, [pgc(1, inv), pgc(2, pay)], CLAIM)).toEqual([]);
      expect(holderNameFindings(null, [pgc(1, inv), pgc(2, pay.replace('Employee Name: ANIL KUMAR SHARMA', 'Employee Name: ANIL K SHARMA'))], CLAIM)).toEqual([]);
    });

    it('cuts the insured at a column label the old stop list lacked', () => {
      const pol = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000009\nInsured's Name : MR. ANIL SHARMA CUSTOMER ID 99812\nRegistration No. New Chassis No. AB12CD34EF";
      expect(holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, pol)], CLAIM)).toEqual([]);
    });

    it('cuts the RC owner at the next label', () => {
      expect(rcOwnerName('Registration Certificate\nRegd. Owner RAMESH SHARMA ADDRESS H NO 12 KPHB\nChassis No: MA3EWDE1S00000777')).toBe('RAMESH SHARMA');
      const rc = 'Registration Certificate\nRegd. Owner RAMESH SHARMA ADDRESS H NO 12 KPHB\nChassis No: MA3EWDE1S00000777';
      const pol = OLD_POLICY.replace('SURESH VERMA', 'RAMESH CHAND SHARMA');
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, rc), pg(3, pol)], CLAIM)).toEqual([]);
    });
  });

  describe('staff ID of a government KYC type is never compared (M6)', () => {
    it.each([
      ['PAN', 'INCOME TAX DEPARTMENT\nPermanent Account Number Card\nABCDE1234F\nName MEERA PATEL\nEmployee ID: E1234', 'PAN'],
      ['DL', 'Driving Licence\nUnion of India\nDL No: TS0920200001234\nName: MEERA PATEL\nEmployee ID: E1234', 'DL'],
      ['PASSPORT', 'Republic of India\nPassport\nPassport No: A1234567\nName: MEERA PATEL\nEmployee ID: E1234', 'PASSPORT'],
    ])('skips a %s page that also trips the staff markers', (_n, text, code) => {
      expect(classifyPage(text)).toBe(code);
      expect(holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, text)], CLAIM)).toEqual([]);
    });
  });

  describe('reference name without a DMS name (I2)', () => {
    it('does not take an address as the reference', () => {
      const inv = 'TAX INVOICE\nInvoice No: INV-1\nBill To: PLOT NO 12 MG ROAD\nChassis No: MZBGD81AUTN000111';
      expect(holderNameFindings(null, [pgc(1, inv), pgc(2, 'PAYSLIP\nEmployee Name: ANIL KUMAR SHARMA\nBasic Pay 30000\nNet Pay 28000\nGross Earnings 31000')], CLAIM)).toEqual([]);
    });

    it("prefers the claim car's invoice over an earlier proforma", () => {
      const proforma = 'PROFORMA INVOICE\nCustomer Name: RAVI KUMAR';
      const f = holderNameFindings(null, [pgc(1, proforma), pgc(2, INVOICE), pgc(3, PAYSLIP)], CLAIM);
      expect(f).toHaveLength(1);
      expect(f[0].data).toMatchObject({ expected: 'ANIL KUMAR SHARMA', expectedType: 'INVOICE', actualType: 'PAYSLIP' });
    });
  });

  describe('listed new-car policy without a full chassis (I5)', () => {
    it("stays quiet for a family car whose RC is in the bundle but whose policy chassis is unreadable", () => {
      const rc = 'Certificate of Registration\nOwner Name: RAVI KUMAR\nChassis No: MZBGB814LTN310444';
      const pol = NEW_POLICY_OTHER.replace('MZBGB814LTN310444', 'joe No. cemw');
      expect(holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, rc), pgc(3, pol)], CLAIM)).toEqual([]);
    });

    it('cuts the insured at the next column label, so the claim\'s own policy with a junk chassis is quiet', () => {
      const pol = "CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D000000009\nInsured's Name : MR. ANIL SHARMA PERIOD OF INSURANCE 01/01/2026\nRegistration No. New Chassis No. AB12CD34EF";
      expect(holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, pol)], CLAIM)).toEqual([]);
    });

    it('still flags another car\'s full-chassis policy with no RC (rows 26, 32)', () => {
      const f = holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, NEW_POLICY_OTHER)], CLAIM);
      expect(f).toHaveLength(1);
      expect(f[0].data).toMatchObject({ actual: 'RAVI KUMAR' });
    });
  });

  describe('rcOwnerName rejects a label as the owner (I6)', () => {
    it('returns null when the next line is a label row', () => {
      expect(rcOwnerName('Owner Name\nOWNERSHIP TYPE INDIVIDUAL')).toBeNull();
      expect(rcOwnerName('Registered Owner\nPERMANENT ADDRESS')).toBeNull();
    });

    it('skips a bare label line and reads the owner under it', () => {
      expect(rcOwnerName('Owner Name\nADDRESS\nRAVI KUMAR')).toBe('RAVI KUMAR');
    });

    it('still reads the plain layout', () => {
      expect(rcOwnerName(OLD_RC_P)).toBe('RAVI KUMAR');
    });
  });

  describe('guards a wrong implementation would fail (M2, M3)', () => {
    it('never compares old-car papers with the customer', () => {
      expect(holderNameFindings(DMS, [pgc(1, INVOICE), pgc(2, OLD_POLICY)], CLAIM)).toEqual([]);
    });

    it('skips every invoice as a holder when the reference is the invoice itself', () => {
      const second = 'TAX INVOICE\nInvoice No: INV-2\nBill To: RAVI KUMAR';
      expect(holderNameFindings(null, [pgc(1, INVOICE), pgc(2, second)], CLAIM)).toEqual([]);
    });

    it('words the holder finding for a reviewer', () => {
      expect(one(STAFF_NAME_P)[0].message).toBe('Name "KIRAN VARMA" on the staff ID does not match the customer "ANIL KUMAR SHARMA" (DMS upload).');
      expect(holderNameFindings(null, [pgc(1, INVOICE), pgc(2, PAYSLIP)], CLAIM)[0].message).toBe(
        'Name "KIRAN" on the payslip does not match the customer "ANIL KUMAR SHARMA" (invoice).',
      );
    });

    it('words the old-car finding for a reviewer', () => {
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, OLD_RC_P), pg(3, OLD_POLICY)], CLAIM)[0].message).toBe(
        'The old car policy on page 3 is insured to "SURESH VERMA", but the old car RC on page 2 (same chassis) is registered to "RAVI KUMAR".',
      );
    });
  });

  describe('oldCarNameFindings guards (M4, M5)', () => {
    it('has no claim car to exclude when the claim id is not a full VIN', () => {
      expect(oldCarNameFindings([pg(2, OLD_RC_P), pg(3, OLD_POLICY)], '')).toEqual([]);
      expect(oldCarNameFindings([pg(2, OLD_RC_P), pg(3, OLD_POLICY)], 'CLM-1')).toEqual([]);
    });

    it("treats an OCR-split own VIN as the claim's car, not the old car", () => {
      const rc = 'Registration Certificate\nOwner Name\nRAVI KUMAR\nOwnership Type INDIVIDUAL\nChassis No: MZBGD81AUTN';
      const pol = "CERTIFICATE OF INSURANCE\nPolicy No. D000000004\nInsured's Name : MR. SURESH VERMA\nChassis No. MZBGD81AUTN";
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, rc), pg(3, pol)], CLAIM)).toEqual([]);
    });

    it('does not call a temporary registration the old car', () => {
      const pol = OLD_POLICY.replace('MA3EWDE1S00000777', 'MZBGB814LTN310444');
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, OTHER_TEMP_RC), pg(3, pol)], CLAIM)).toEqual([]);
    });
  });

  it('reads the RC owner from a label, same line or next', () => {
    expect(rcOwnerName(OLD_RC_P)).toBe('RAVI KUMAR');
    expect(rcOwnerName('Owner Name: SITA DEVI\nSon/Wife/Daughter of RAM LAL')).toBe('SITA DEVI');
  });

  describe('old RC owner vs old policy insured (Rule #3)', () => {
    it('flags a different insured on the same chassis', () => {
      const f = oldCarNameFindings([pg(1, INVOICE), pg(2, OLD_RC_P), pg(3, OLD_POLICY)], CLAIM);
      expect(f).toHaveLength(1);
      expect(f[0]).toMatchObject({
        code: 'CROSS_OLD_CAR_NAME_MISMATCH',
        severity: 'ERROR',
        page: 3,
        data: { actual: 'SURESH VERMA', expected: 'RAVI KUMAR', rcPage: 2 },
      });
    });

    it('stays quiet when the insured is the owner', () => {
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, OLD_RC_P), pg(3, OLD_POLICY.replace('SURESH VERMA', 'RAVI KUMAR'))], CLAIM)).toEqual([]);
    });

    it('leaves an unpaired policy to the chassis rule', () => {
      const other = OLD_POLICY.replace('MA3EWDE1S00000777', 'MA3EWDE1S00000999');
      expect(oldCarNameFindings([pg(1, INVOICE), pg(2, OLD_RC_P), pg(3, other)], CLAIM)).toEqual([]);
    });
  });
});
