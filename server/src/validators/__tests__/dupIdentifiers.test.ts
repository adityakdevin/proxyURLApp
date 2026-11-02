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

describe('extractIdentifiers - client sheet 2026-10-31 - certificate numbers', () => {
  it('recognises a civil certificate by its body, not only its title', () => {
    expect(
      pick(
        'This is to certify that the following is an extract from the registration of the marriage record with Municipal Corporation Testpur. Bride Name: TEST BRIDE Registration No.: 318 Registration Date: Jan 21, 2025 Issued by: Marriage Registrar, Testpur',
        'CERT_REG_NO'
      )
    ).toEqual(['318 (marriage certificate)']);
    expect(
      pick(
        'Issued under section 7 of the Registration of Births and Deaths Act, 1969\nRegistration No: D-2019/0012345',
        'CERT_REG_NO'
      )
    ).toEqual(['D-2019/0012345']);
  });

  it('reads an OCR-misspelt label', () => {
    expect(
      pick('MARRIAGE REGISTRATION CERTIFICATE\nRegistation No: 318 rer\nDate of Registration : 18/01/2024', 'CERT_REG_NO')
    ).toEqual(['318 (marriage certificate)']);
  });

  it('counts a 2-3 character number only with one certificate kind and a registration date', () => {
    expect(
      pick('Issued under section 7 of the Registration of Births and Deaths Act, 1969\nRegistration No: 318\nDate of Registration: 18/01/2024', 'CERT_REG_NO')
    ).toEqual([]);
    expect(pick('MARRIAGE REGISTRATION CERTIFICATE\nRegistration No: 7\nDate of Registration: 18/01/2024', 'CERT_REG_NO')).toEqual([]);
    expect(
      pick('PROOF ATTACHED : AADHAR , PAN CARD MARRIAGE CERTIFICATE\nRegistration No: 12', 'CERT_REG_NO')
    ).toEqual([]);
  });

  it('skips an other-script label after the slash, but never into a date', () => {
    expect(
      pick(
        'BIRTH CERTIFICATE\nRegistration No. / Xyz abcd : 4821/2016\nDate of Registration / Pqr : 09-JAN-2017',
        'CERT_REG_NO'
      )
    ).toEqual(['4821/2016']);
    expect(pick('BIRTH CERTIFICATE\nRegistration No / Date of Registration : 09/01/2017', 'CERT_REG_NO')).toEqual([]);
  });

  it('reads the value off the next line under a two-column label row', () => {
    expect(
      pick('DEATH CERTIFICATE\nREGISTRATION NO: abc / DATE OF REGISTRATION:\nABCD-0101-000123456 12-08-2021', 'CERT_REG_NO')
    ).toEqual(['ABCD-0101-000123456']);
    expect(
      pick(
        'BIRTH CERTIFICATE\n"4&5 79 / REGISTRATION NUMBER: "4&5 SI | DATE OF REGISTRATION:\n4312019 31-12-2019',
        'CERT_REG_NO'
      )
    ).toEqual(['4312019']);
    expect(
      pick('BIRTH CERTIFICATE\nDATE OF REGISTRATION: | REGISTRATION NO:\n31-12-2019 4312019', 'CERT_REG_NO')
    ).toEqual(['4312019']);
    expect(
      pick(
        'BIRTH CERTIFICATE\nRegistration No: 4821/2016 Date of Registration: 09/01/2017\n14/121 Some Nagar',
        'CERT_REG_NO'
      )
    ).toEqual(['4821/2016']);
  });

  it('reads the value off the line above a bilingual label row', () => {
    expect(
      pick(
        'BIRTH CERTIFICATE\nqwe rty/ : 4821/2016 uio pas 57/04/2016\nRegistration No Date of Registration <\nDate of issue : 22/04/2016',
        'CERT_REG_NO'
      )
    ).toEqual(['4821/2016']);
  });

  it('joins a value OCR split around its slash', () => {
    expect(
      pick('BIRTH CERTIFICATE\nRegistration No: 583 / 2019\nDate of Registration: 31-12-2019', 'CERT_REG_NO')
    ).toEqual(['583/2019']);
  });

  it('takes a short number only from the label line', () => {
    const c = (t: string) => pick(t, 'CERT_REG_NO');
    expect(c('BIRTH CERTIFICATE\nREGISTRATION NO: | DATE OF REGISTRATION:\n583 / 2019 31-12-2019')).toEqual(['583/2019']);
    expect(c('BIRTH CERTIFICATE\n11. Registration No.:\n12. Date of Registration: 31-12-2019')).toEqual([]);
    expect(c('BIRTH CERTIFICATE\nS.No Registration No: Name\n12 4312019 TEST\nDate of Registration: 31-12-2019')).toEqual([]);
    expect(c('BIRTH CERTIFICATE\nAddress: Ward 12\nRegistration No ____\nDate of Registration: 31-12-2019')).toEqual([]);
  });

  it('reads a label OCR wrapped across two lines', () => {
    expect(pick('BIRTH CERTIFICATE\nRegistration\nNo: 4312019', 'CERT_REG_NO')).toEqual(['4312019']);
  });

  it('skips a date-first value line in other date shapes', () => {
    expect(
      pick('BIRTH CERTIFICATE\nDATE OF REGISTRATION: | REGISTRATION NO:\n09-JAN-2017 4312019', 'CERT_REG_NO')
    ).toEqual(['4312019']);
    expect(
      pick('BIRTH CERTIFICATE\nDATE OF REGISTRATION: | REGISTRATION NO:\n2019-12-31 4312019', 'CERT_REG_NO')
    ).toEqual(['4312019']);
  });

  it('does not read the next line when the value slot holds a word', () => {
    expect(pick('BIRTH CERTIFICATE\nRegistration No: NA\n14/121 Some Nagar', 'CERT_REG_NO')).toEqual([]);
  });

  it('reads a value OCR glued to the label', () => {
    expect(
      pick('BIRTH CERTIFICATE\nRegistration No4312019\nDate of Registration: 31-12-2019', 'CERT_REG_NO')
    ).toEqual(['4312019']);
    expect(pick('BIRTH CERTIFICATE\nRegistration Nominee: TEST', 'CERT_REG_NO')).toEqual([]);
  });

  it('reads a Kerala certificate key number only on a civil certificate', () => {
    expect(
      pick('CERTIFICATE OF MARRIAGE\nKey No. K12345678901234567890\nThe Key Number is unique to each event.', 'KEY_NO')
    ).toEqual(['K12345678901234567890']);
    expect(pick('TAX INVOICE\nKey No. K12345678901234567890', 'KEY_NO')).toEqual([]);
  });

  it('reads a ration card number printed under the title with no label', () => {
    expect(pick('RATION CARD / xyz\nabc def\nghi\njkl\nLo A ew 271000123456 - | 14', 'RATION_CARD_NO')).toEqual([
      '271000123456',
    ]);
  });

  it('reads the (Card Number) label of a bilingual ration card, OCR slip included', () => {
    expect(
      pick('RATION CARD\n(Card Type)\n(Card Mumier) 2140000001 (Head of Family)', 'RATION_CARD_NO')
    ).toEqual(['2140000001']);
  });

  it('never takes a phone number or a grouped number as the card number', () => {
    expect(pick('RATION CARD\n(Taluk Supply Officer) 9876543210', 'RATION_CARD_NO')).toEqual([]);
    expect(pick('RATION CARD\nMember 1234 5678 9012', 'RATION_CARD_NO')).toEqual([]);
  });

  it('reads a label-less number only under a real ration card title', () => {
    expect(
      pick('CLAIM FORM\nID proof: [ ] Aadhaar [ ] PAN [ ] Ration Card [ ] Voter ID\nForm No 271000123456', 'RATION_CARD_NO')
    ).toEqual([]);
  });

  it('reads a label-less number under a title line carrying OCR noise', () => {
    expect(
      pick('RATION CARD / xyz 99% ab cde fgh\nabc def\nghi\njkl\nLo A ew 271000123456 - | 14', 'RATION_CARD_NO')
    ).toEqual(['271000123456']);
  });

  it('never takes a toll-free, country-code or other labelled number as the card number', () => {
    for (const body of [
      '18004251550',
      '+919876543210',
      'Ph: 4842345678',
      'FPS ID 123456789012',
      'LPG Consumer No 1234567890',
      'Member Aadhaar 234567890123',
      '(Card Holder) 9876543210',
    ]) {
      expect(pick(`RATION CARD\n${body}`, 'RATION_CARD_NO')).toEqual([]);
    }
  });

  it('reads an 8-digit card number from the (Card Number) label', () => {
    expect(pick('RATION CARD\n(Card Number) 21400001', 'RATION_CARD_NO')).toEqual(['21400001']);
  });

  it('bounds the label-less reading', () => {
    expect(pick('RATION CARD\na\nb\nc\nd\ne\n2710001234567', 'RATION_CARD_NO')).toEqual([]);
    expect(pick('RATION CARD\n04842345678', 'RATION_CARD_NO')).toEqual([]);
    expect(pick('RATION CARD\nRation Card No: 1234567890\n2710001234567', 'RATION_CARD_NO')).toEqual(['1234567890']);
  });

  it('keeps the year of an N of YYYY registration number', () => {
    expect(pick('MARRIAGE CERTIFICATE\nRegistration No. 318 of 2024\nDate of Registration: 12/02/2024', 'CERT_REG_NO')).toEqual(['318/2024']);
    expect(pick('MARRIAGE CERTIFICATE\nRegistration No: 318 2024\nDate of Registration: 12/02/2024', 'CERT_REG_NO')).toEqual(['318/2024']);
  });

  it('reads the line above only under a two-column label row', () => {
    expect(
      pick('CERTIFICATE OF MARRIAGE\nRegistration No: 318/2024\nHelpline: 0471 2525300\nThe Registration Number can be verified at the portal', 'CERT_REG_NO')
    ).toEqual(['318/2024']);
    expect(
      pick('BIRTH CERTIFICATE\nIssuing office: Municipal Office, Testpur 682001\nPlease quote the Registration Number in all correspondence', 'CERT_REG_NO')
    ).toEqual([]);
  });

  it('never takes a number that follows another label as the card number', () => {
    for (const text of [
      'DOCUMENT CHECKLIST\n1. Copy of Aadhaar Card\n2. Copy of Ration Card\n3. Bank Passbook\n4. Dealer Invoice\nDealer Code 1002003004',
      'RELATIONSHIP PROOF\nRation Card No: ________\nDealer Bank Account 50200012345678',
      'Relationship proof: Ration Card\nEmployee Code 1000234567',
      'RATION CARD\nCIN 1234567890123',
    ]) {
      expect(pick(text, 'RATION_CARD_NO')).toEqual([]);
    }
  });

  it('takes the card number, not the depot number, under the title', () => {
    expect(pick('RATION CARD\nARD No 1416043210\nCard No 2140000001', 'RATION_CARD_NO')).toEqual(['2140000001']);
    expect(pick('RATION CARD\nNo: 2140000001', 'RATION_CARD_NO')).toEqual(['2140000001']);
    // "A/c" is a label only as a word of its own, not the end of a name such as "Zac".
    expect(pick('RATION CARD\nZac 2710001234567', 'RATION_CARD_NO')).toEqual(['2710001234567']);
  });

  it('skips an organisation registration number', () => {
    for (const text of [
      'MOTOR POLICY SCHEDULE\nDocuments: Death Certificate\nIRDAI Registration No. 121\nDate of Issue: 12/03/2025',
      'CERTIFICATE OF MARRIAGE\nArya Samaj Mandir Trust Registration No. 123\nDate of Registration: 01/02/2024',
      'MEDICAL CERTIFICATE OF CAUSE OF DEATH\n(See Rule 7 of the Registration of Births and Deaths Rules)\nMedical Council Registration No: 45678',
      'CLAIM FORM\nregistration of the death claim\nVehicle Registration No: MH12AB1234',
    ]) {
      expect(pick(text, 'CERT_REG_NO')).toEqual([]);
    }
    expect(pick('BIRTH CERTIFICATE\nPlace of Birth: City Hospital Registration No: 4312019', 'CERT_REG_NO')).toEqual(['4312019']);
  });

  it('keeps an office-coded registration number', () => {
    expect(pick('BIRTH CERTIFICATE\nRegistration No: 45/KMC/2020', 'CERT_REG_NO')).toEqual(['45/KMC/2020']);
    expect(pick('BIRTH CERTIFICATE\nRegistration No: 7-GHMC-19', 'CERT_REG_NO')).toEqual(['7-GHMC-19']);
  });

  it('does not take a form item number as a short registration number', () => {
    expect(pick('MARRIAGE REGISTRATION CERTIFICATE\n11. Registration No.: 12. Date of Registration: 18/01/2024', 'CERT_REG_NO')).toEqual([]);
  });
});
