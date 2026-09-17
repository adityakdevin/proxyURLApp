import {
  kiaVerificationUrl,
  parseKiaPolicyPage,
  printedInsurers,
  sameInsurer,
  verifyKiaPolicy,
} from '../policyOnline.js';

const PAGE = (ic: string, chassis: string) =>
  `<h1><span id="lblInsurnaceComapny">${ic}</span></h1>` +
  `<td><span id="lblName">MR. KANNAPIRAN BABURAJ </span></td>` +
  `<td><span id="lblPolNo">993292623740000247</span></td>` +
  `<td><span id="lblIC">${ic}</span></td>` +
  `<td><span id="lblChesisNo">${chassis}</span></td>` +
  `<td><span id="lblEngNo">D4FASM495292</span></td>` +
  `<span id="lblmsg"></span>`;
const INVALID = `<span id="lblIC"></span><span id="lblChesisNo"></span><span id="lblmsg">Invalid Data</span>`;
const QR =
  'Name:MR. KANNAPIRAN BABURAJ|Pol.No.:993292623740000247|ChassisNo.:MZBGD813MSN273343|' +
  'URL:http://www.kiasafety.com/VISOF/Policy/Vs_Pol_QRCode.aspx?policyNo=jaRJ+tb&proposalNo=vvHL/ovc=';

describe('kiaVerificationUrl', () => {
  it('takes the KIA Safety link out of a policy QR, as https', () => {
    expect(kiaVerificationUrl(QR)).toBe(
      'https://www.kiasafety.com/VISOF/Policy/Vs_Pol_QRCode.aspx?policyNo=jaRJ+tb&proposalNo=vvHL/ovc='
    );
  });
  it('never returns a link to any other host', () => {
    expect(kiaVerificationUrl('URL:http://evil.example/VISOF/Policy/x.aspx?a=1')).toBeNull();
    expect(kiaVerificationUrl('URL:http://www.kiasafety.com.evil.example/VISOF/Policy/x')).toBeNull();
    expect(kiaVerificationUrl('Name:A|Pol.No.:1')).toBeNull();
  });
});

describe('parseKiaPolicyPage', () => {
  it('reads the record', () => {
    const r = parseKiaPolicyPage(PAGE('IndusInd General Insurance Co. Ltd.', 'MZBGD813MSN273343'));
    expect(r).toEqual({
      valid: true,
      insurer: 'IndusInd General Insurance Co. Ltd.',
      name: 'MR. KANNAPIRAN BABURAJ',
      policyNo: '993292623740000247',
      chassis: 'MZBGD813MSN273343',
      engine: 'D4FASM495292',
    });
  });
  it('recognises "Invalid Data" as no record', () => {
    expect(parseKiaPolicyPage(INVALID).valid).toBe(false);
  });
});

describe('printed insurer vs online insurer', () => {
  it('reads the insurer named on a policy page', () => {
    expect(printedInsurers('Reliance General Insurance Co.Ltd.\n2ND FLOOR')).toEqual(['Reliance']);
    expect(printedInsurers('The New India Assurance Co. Ltd.')).toEqual(['The New India']);
    expect(printedInsurers('ICICI Lombard General Insurance Co. Ltd. Plot No 10')).toEqual(['ICICI Lombard']);
  });
  it('treats a renamed insurer as the same company', () => {
    expect(sameInsurer('IndusInd General Insurance Co. Ltd.', 'Reliance')).toBe(true);
    expect(sameInsurer('Bajaj General Insurance Ltd.', 'Bajaj Allianz')).toBe(true);
  });
  it('tells genuinely different insurers apart', () => {
    expect(sameInsurer('ICICI Lombard General Insurance Co. Ltd.', 'Reliance')).toBe(false);
    expect(sameInsurer('The New India Assurance Co. Ltd.', 'United India')).toBe(false);
  });
});

describe('verifyKiaPolicy', () => {
  const fetchOf = (html: string) => (async () => ({ ok: true, text: async () => html })) as never;

  it('flags a policy KIA Safety has no record of', async () => {
    const r = await verifyKiaPolicy(QR, 'Reliance General Insurance Co.Ltd.', fetchOf(INVALID));
    expect(r.map((f) => f.code)).toEqual(['QR_POLICY_NOT_FOUND_ONLINE']);
    expect(r[0].severity).toBe('ERROR');
  });
  it('flags a printed insurer that is not the one on record', async () => {
    const r = await verifyKiaPolicy(QR, 'ICICI Lombard General Insurance Co. Ltd.', fetchOf(PAGE('IndusInd General Insurance Co. Ltd.', 'X')));
    expect(r.map((f) => f.code)).toEqual(['QR_INSURER_MISMATCH']);
    expect(r[0].severity).toBe('ERROR');
  });
  it('passes MZBGD813MSN273343: printed Reliance, on record IndusInd (the same company, renamed)', async () => {
    const r = await verifyKiaPolicy(QR, 'Reliance General Insurance Co.Ltd.', fetchOf(PAGE('IndusInd General Insurance Co. Ltd.', 'X')));
    expect(r).toEqual([]);
  });
  it('says nothing is wrong when the page names no insurer it can read', async () => {
    expect(await verifyKiaPolicy(QR, 'CERTIFICATE OF INSURANCE', fetchOf(PAGE('IndusInd General Insurance Co. Ltd.', 'X')))).toEqual([]);
  });
  it('reports, without failing the claim, when KIA Safety cannot be reached', async () => {
    const down = (async () => { throw new Error('ETIMEDOUT'); }) as never;
    const r = await verifyKiaPolicy(QR, 'Reliance General Insurance Co.Ltd.', down);
    expect(r.map((f) => [f.code, f.severity])).toEqual([['QR_ONLINE_UNVERIFIED', 'INFO']]);
  });
  it('does nothing for a QR without a KIA Safety link', async () => {
    expect(await verifyKiaPolicy('Name:A|Pol.No.:1', 'text', fetchOf(INVALID))).toEqual([]);
  });
});
