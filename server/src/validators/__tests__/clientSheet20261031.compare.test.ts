import { classifyDocType, chassisCandidates, sameVehicle, oldCarPaperFindings, type CrossPage } from '../crossDocLogic.js';

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
