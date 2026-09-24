import { extractIdentifiers } from '../dupIdentifiers.js';

const pick = (text: string, field: string) =>
  extractIdentifiers(text)
    .filter((i) => i.field === field)
    .map((i) => i.value);

describe('extractIdentifiers — the Duplicacy sheet numbers', () => {
  it('reads a policy number, and ignores "Previous TP Policy No: NA"', () => {
    expect(pick('Policy No.\n251589936500\nPrevious TP Policy No. : NA', 'POLICY_NO')).toEqual(['251589936500']);
    expect(pick('Policy No.: 3001/KA-20982810/00/000', 'POLICY_NO')).toEqual(['3001/KA-20982810/00/000']);
  });

  it("reads the client's forged pair (MZBEP812LSN709538 / 709192), OCR slip included", () => {
    expect(pick('Policy / Certificate No. 251589936500', 'POLICY_NO')).toEqual(['251589936500']);
    expect(pick('Policy / Certificato No: 251589936500', 'POLICY_NO')).toEqual(['251589936500']);
  });

  it('keeps reading through a hyphen that OCR turned into a full stop', () => {
    expect(pick('Policy No.\n0G-26-1021-1825.00036132 Private Car Policy', 'POLICY_NO')).toEqual(['0G-26-1021-1825.00036132']);
    expect(pick('as per Policy No: 251589936500.', 'POLICY_NO')).toEqual(['251589936500']);
  });

  it('joins a policy number wrapped across two lines instead of keeping the prefix', () => {
    // Every Bajaj policy starts "0G-26-1021-1825-"; the prefix alone matched unrelated claims.
    expect(pick('Policy No.\n0G-26-1021-1825-\n00036132\nPeriod', 'POLICY_NO')).toEqual(['0G-26-1021-1825-00036132']);
    expect(pick('Policy No.\n0G-26-1021-1825-\n', 'POLICY_NO')).toEqual([]);
  });

  it("takes an individual's PAN, never a company's", () => {
    // Customer PAN on an invoice, beside the dealer's and the insurer's company PANs.
    const t = 'Dealer GST / PAN No : 33AAHCK3008N1ZJ/AAHCK3008N  PAN No : ANVPB4685N  Insurer PAN No.: AABCR6747B';
    expect(pick(t, 'PAN')).toEqual(['ANVPB4685N']);
  });

  it('reads Aadhaar only from an Aadhaar page or an explicit Aadhaar label', () => {
    expect(pick('Government of India\nAadhaar\n2345 6789 0123\nVID: 9123 4567 8912 3456', 'AADHAAR')).toEqual(['234567890123']);
    expect(pick('Account No: 1234 5678 9012', 'AADHAAR')).toEqual([]); // 12 digits, not an Aadhaar
    expect(pick('Customer Aadhaar No: 2345 6789 0123', 'AADHAAR')).toEqual(['234567890123']);
  });

  it("reads a GSTIN from a GST certificate or a customer label, never the dealer's", () => {
    expect(pick('Dealer GST / PAN No : 33AAHCK3008N1ZJ/AAHCK3008N', 'GSTIN')).toEqual([]);
    expect(pick('Form GST REG-06\nRegistration Certificate\nGSTIN 24AAGFO2658A1ZM', 'GSTIN')).toEqual(['24AAGFO2658A1ZM']);
    expect(pick('Customer GSTIN : 27ABCDE1234F1Z5', 'GSTIN')).toEqual(['27ABCDE1234F1Z5']);
  });

  it('reads DL, passport and voter numbers from their own card pages', () => {
    expect(pick('Driving Licence\nDL No: MP09 20190012345\nCOV: LMV', 'DL_NO')).toEqual(['MP0920190012345']);
    expect(pick('Republic of India\nPassport\nNationality INDIAN\nPassport No. M1234567', 'PASSPORT_NO')).toEqual(['M1234567']);
    expect(pick('Election Commission of India\nEPIC No: ABC1234567', 'VOTER_ID')).toEqual(['ABC1234567']);
    // The same shapes elsewhere are not identity numbers.
    expect(pick('Invoice ref M1234567 and ABC1234567', 'PASSPORT_NO')).toEqual([]);
    expect(pick('Invoice ref M1234567 and ABC1234567', 'VOTER_ID')).toEqual([]);
  });

  it('reads Udyam, FSSAI, PF, UAN, GPF, PRAN, ESI and pension numbers by their labels', () => {
    expect(pick('Udyam Registration Number: UDYAM-MH-18-0012345', 'UDYAM_NO')).toEqual(['UDYAM-MH-18-0012345']);
    expect(pick('FSSAI Lic. No. 10019022009876', 'FSSAI_NO')).toEqual(['10019022009876']);
    expect(pick('PF No. : DL/CPM/0026293/000/0010160', 'PF_NO')).toEqual(['DL/CPM/0026293/000/0010160']);
    expect(pick('PF No. ESIC No', 'PF_NO')).toEqual([]); // empty PF field on a payslip
    expect(pick('UAN : 101230048751', 'UAN')).toEqual(['101230048751']);
    expect(pick('GPF A/c No: HR/12345', 'GPF_NO')).toEqual(['HR/12345']);
    expect(pick('PRAN : 110012345678', 'PRAN')).toEqual(['110012345678']);
    expect(pick('ESIC No : 3112345678', 'ESI_NO')).toEqual(['3112345678']);
    expect(pick('PF No. ESIC No PAN : AEAPS3424C', 'ESI_NO')).toEqual([]); // empty ESIC field
    expect(pick('PPO No: 123456789012', 'PENSION_NO')).toEqual(['123456789012']);
    expect(pick('Pension No. : DL/1234/567', 'PENSION_NO')).toEqual(['DL/1234/567']);
  });

  it('reads certificate registration numbers only on birth / death / marriage certificates', () => {
    expect(pick('Certificate of Birth\nRegistration No: B-2019/0012345', 'CERT_REG_NO')).toEqual(['B-2019/0012345']);
    // A vehicle's registration number on a policy is not a certificate registration number.
    expect(pick('Vehicle Details\nRegistration No: MH12AB1234', 'CERT_REG_NO')).toEqual([]);
  });

  it('reads ration and family card numbers', () => {
    expect(pick('Ration Card No: 2710567890123', 'RATION_CARD_NO')).toEqual(['2710567890123']);
    expect(pick('Family Card Number: FC/2021/445566', 'RATION_CARD_NO')).toEqual(['FC/2021/445566']);
  });
});
