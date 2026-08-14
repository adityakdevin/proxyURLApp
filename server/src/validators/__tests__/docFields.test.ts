import { fieldDocType, documentFields, docFieldPane, docFieldGroups } from '../docFields.js';

const valueOf = (fields: { label: string; value: string | null }[], label: string) =>
  fields.find((f) => f.label === label)?.value ?? null;

// Text shaped like the PAN card in the reviewer's sample.
const PAN_TEXT = `INCOME TAX DEPARTMENT GOVT. OF INDIA
Permanent Account Number Card
AZHPY6813H
Name: LOKESH YADAV
Mother's Name: SUNITA YADAV
Date of Birth: 18/07/2000`;

// Text shaped like the KIA vehicle tax invoice.
const INVOICE_TEXT = `Vehicle Tax Invoice
Bill To : JAGJEET SINGH
Customer Id : C2025060410
Invoice No : UK401K202500204
Invoice Date : 26/06/2025
Chassis No : MZBB1811LSN014084
Engine No : G3LCSM372409
Model : SYROS`;

const INSURANCE_TEXT = `CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE
Policy No. D210959291
Period of Insurance
Insured's Name : JAGJEET SINGH
Premium
Chassis No. : MZBB1811LSN014084
Engine No. : G3LCSM372409
Model : SYROS`;

describe('fieldDocType', () => {
  it('recognises the four types that get a pane', () => {
    expect(fieldDocType(PAN_TEXT)).toBe('PAN');
    expect(fieldDocType(INVOICE_TEXT)).toBe('INVOICE');
    expect(fieldDocType(INSURANCE_TEXT)).toBe('INSURANCE');
    expect(fieldDocType('UIDAI Aadhaar 2345 6789 0123')).toBe('AADHAR');
  });

  it('returns null for a document with no pane', () => {
    expect(fieldDocType('Salary slip for the month of June')).toBeNull();
    expect(docFieldPane('Salary slip for the month of June')).toEqual([]);
  });
});

describe('docFieldGroups (bundle PDFs)', () => {
  // The reviewer's real file: invoice, then policy, then Aadhaar, in one PDF. Reading the
  // JOINED text gave the invoice's toll-free number as an Aadhaar number.
  const BUNDLE = [INVOICE_TEXT, INSURANCE_TEXT, 'UIDAI Aadhaar No 2345 6789 0123\nName: JAGJEET SINGH'];

  it('produces one group per document type, each read from its own pages', () => {
    const groups = docFieldGroups(BUNDLE);
    expect(groups.map((g) => g.type).sort()).toEqual(['AADHAR', 'INSURANCE', 'INVOICE']);
    const invoice = groups.find((g) => g.type === 'INVOICE')!;
    expect(invoice.pages).toEqual([1]);
    expect(valueOf(invoice.fields, 'Invoice No')).toBe('UK401K202500204');
    const aadhaar = groups.find((g) => g.type === 'AADHAR')!;
    expect(aadhaar.pages).toEqual([3]);
    expect(valueOf(aadhaar.fields, 'Aadhaar Number')).toBe('2345 6789 0123');
  });

  it('joins consecutive pages of the same type into one group', () => {
    const groups = docFieldGroups([
      'CERTIFICATE OF INSURANCE CUM POLICY SCHEDULE\nPolicy No. D210959291\nPeriod of Insurance\nPremium',
      'Period of Insurance\nPremium\nChassis No. : MZBB1811LSN014084',
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].pages).toEqual([1, 2]);
    // The chassis number is on page 2, the policy number on page 1 — one group carries both.
    expect(valueOf(groups[0].fields, 'Policy No')).toBe('D210959291');
    expect(valueOf(groups[0].fields, 'Chassis No')).toBe('MZBB1811LSN014084');
  });

  it('falls back to whole-document text when page texts were never stored', () => {
    const groups = docFieldPane(PAN_TEXT);
    expect(groups).toHaveLength(1);
    expect(groups[0].pages).toEqual([]);
    expect(valueOf(groups[0].fields, 'PAN Number')).toBe('AZHPY6813H');
  });
});

describe('documentFields', () => {
  it('reads a PAN card', () => {
    const f = documentFields(PAN_TEXT, 'PAN');
    expect(valueOf(f, 'PAN Number')).toBe('AZHPY6813H');
    expect(valueOf(f, 'Holder Name')).toBe('LOKESH YADAV');
    expect(valueOf(f, "Mother's Name")).toBe('SUNITA YADAV');
    expect(valueOf(f, 'Date of Birth')).toBe('18/07/2000');
    // The card prints a mother's name, so father's stays blank rather than borrowing it.
    expect(valueOf(f, "Father's Name")).toBeNull();
  });

  it('reads an invoice', () => {
    const f = documentFields(INVOICE_TEXT, 'INVOICE');
    expect(valueOf(f, 'Invoice No')).toBe('UK401K202500204');
    expect(valueOf(f, 'Invoice Date')).toBe('26/06/2025');
    expect(valueOf(f, 'Customer Id')).toBe('C2025060410');
    expect(valueOf(f, 'Chassis No')).toBe('MZBB1811LSN014084');
    expect(valueOf(f, 'Engine No')).toBe('G3LCSM372409');
    expect(valueOf(f, 'Model')).toBe('SYROS');
  });

  // QA 2026-07-28: the KIA invoice labels the buyer "Bill To", never "Name", so the shared
  // name extractor read nothing and Customer Name showed as absent.
  it('reads the customer name off a "Bill To" invoice', () => {
    const f = documentFields(INVOICE_TEXT, 'INVOICE');
    expect(valueOf(f, 'Customer Name')).toBe('JAGJEET SINGH');
  });

  it('stops the Bill To name at the next label', () => {
    const f = documentFields(
      'Vehicle Tax Invoice\nBill To : RAVI KUMAR Address : 163 KHURBURA MOHALLA',
      'INVOICE'
    );
    expect(valueOf(f, 'Customer Name')).toBe('RAVI KUMAR');
  });

  it('reads an insurance policy', () => {
    const f = documentFields(INSURANCE_TEXT, 'INSURANCE');
    expect(valueOf(f, 'Policy No')).toBe('D210959291');
    expect(valueOf(f, "Insured's Name")).toBe('JAGJEET SINGH');
    expect(valueOf(f, 'Chassis No')).toBe('MZBB1811LSN014084');
  });

  // The reviewer's real e-PAN: a bilingual TABLE, no colons, and the footer carries both
  // "Permanent Account Number (PAN)" prose and a "PAN Services Unit" line. Everything but
  // the PAN itself read as "Not found", and the PAN read as "SERVICES".
  const EPAN_TABLE = `INCOME TAX DEPARTMENT GOVT. OF INDIA
DRUPP1415C
नाम / Name POLU SANKEERTHANA
पिता का नाम / Father's name POLU VEERAIAH
जन्म की तारीख / Date of Birth 08/03/1999
लिंग / Gender Female
हस्ताक्षर / Signature
Digitally signed by Income Tax Deptt. Date: 2024.05.18 05:37:38 GMT+05:30
Permanent Account Number (PAN) facilitate Income Tax Department linking of various documents
For any query contact PAN SERVICES UNIT`;

  it('reads a bilingual e-PAN table with no colons', () => {
    const f = documentFields(EPAN_TABLE, 'PAN');
    expect(valueOf(f, 'PAN Number')).toBe('DRUPP1415C'); // not "SERVICES"
    expect(valueOf(f, 'Holder Name')).toBe('POLU SANKEERTHANA');
    expect(valueOf(f, "Father's Name")).toBe('POLU VEERAIAH');
    expect(valueOf(f, 'Date of Birth')).toBe('08/03/1999');
  });

  // What the reviewer actually saw: the card block is an IMAGE, so only the legal footer
  // reached the text layer. The masthead and the NSDL helpline then filled the pane.
  it('does not report the masthead or a helpline number as card data', () => {
    const footerOnly = `INCOME TAX DEPARTMENT GOVT. OF INDIA
स्थायी लेखा संख्या (पैन) का नाम एक करदाता से संबंधित
Permanent Account Number (PAN) facilitate Income Tax Department linking of documents
PAN SERVICES UNIT Tel: 91-20-2721 8080`;
    const f = documentFields(footerOnly, 'PAN');
    expect(valueOf(f, 'Holder Name')).not.toBe('GOVT');
    expect(valueOf(f, 'PAN Number')).toBeNull();
    expect(valueOf(f, 'Date of Birth')).toBeNull(); // "91-20-2721" is not a date
  });

  it('does not read the holder name off the father label', () => {
    const f = documentFields('पिता का नाम / Father\'s name POLU VEERAIAH', 'PAN');
    expect(valueOf(f, "Father's Name")).toBe('POLU VEERAIAH');
    expect(valueOf(f, 'Holder Name')).toBeNull();
  });

  it('reads an Aadhaar card that never prints the word next to its number', () => {
    const card = `UIDAI
POLU SANKEERTHANA
जन्म तिथि / DOB 08/03/1999
2345 6789 0123
VID : 9876 5432 1098 7654
Help Desk 1800 300 1947`;
    const f = documentFields(card, 'AADHAR');
    expect(valueOf(f, 'Aadhaar Number')).toBe('2345 6789 0123');
    expect(valueOf(f, 'VID')).toBe('9876 5432 1098 7654');
    expect(valueOf(f, 'Date of Birth')).toBe('08/03/1999');
  });

  // A bundle PDF puts an invoice's toll-free number in front of the Aadhaar extractor.
  it('does not read a toll-free or invoice number as an Aadhaar number', () => {
    const f = documentFields('UIDAI page\nToll Free No: 1800 2666 9666', 'AADHAR');
    expect(valueOf(f, 'Aadhaar Number')).toBeNull();
    expect(valueOf(documentFields('Aadhaar No 2345 6789 0123', 'AADHAR'), 'Aadhaar Number')).toBe(
      '2345 6789 0123'
    );
  });

  it('keeps a field the document does not carry, as an empty value', () => {
    const f = documentFields('Permanent Account Number Card\nABCDE1234F', 'PAN');
    expect(f.map((x) => x.label)).toContain('Date of Birth');
    expect(valueOf(f, 'Date of Birth')).toBeNull();
  });
});

// Verbatim from production claim MZBEU813LSN749087 p.6 (S.No 16 of the 2026-08 QA sample).
const GST_CERT_TEXT = `Form GST REG-06
Registration Certificate
Registration Number : 24AAGFO2658A1ZM
Legal Name : OM ENTERPRISE
Trade Name if any : OM ENTERPRISE
PAN : AAGFO2658A
Address of Principal Place of Business : SWATIPARK MAIN ROAD, PLOT NO 15 SHED NO 3, RAJKOT, Gujarat, 360005
Type of Registration : Regular
Date of Registration : 25/02/2019`;

// A dealer's vehicle tax invoice. It prints GST wording too, which is why the field pane
// needs a certificate-specific signal rather than the loose GOVT_TYPE_MARKERS.GST.
const TAX_INVOICE_TEXT = `Savan IB Automotive Private Limited
Vehicle Tax Invoice
Goods and Services Tax
Dealer GST / PAN No : 24ABACS4515J1ZH/ABACS4515J
Invoice No : GJ308K202500942
Invoice Date : 26/01/2026
Customer Id : C2026010724
Chassis No.: MZBEU813LSN749087`;

describe('GST registration certificate', () => {
  it('classifies a certificate as GST', () => {
    expect(fieldDocType(GST_CERT_TEXT)).toBe('GST');
  });

  // The whole reason GST_CERT_RE exists: routing an invoice to the GST pane would strip it
  // of its invoice number, chassis and model.
  it('does NOT reclassify a tax invoice that merely mentions GST', () => {
    expect(fieldDocType(TAX_INVOICE_TEXT)).toBe('INVOICE');
    expect(valueOf(documentFields(TAX_INVOICE_TEXT, 'INVOICE'), 'Invoice No')).toBe('GJ308K202500942');
  });

  it('reads GSTIN and PAN off the certificate', () => {
    const f = documentFields(GST_CERT_TEXT, 'GST');
    expect(valueOf(f, 'GSTIN')).toBe('24AAGFO2658A1ZM');
    // The PAN is ALSO embedded in the GSTIN; word boundaries keep the printed one.
    expect(valueOf(f, 'PAN Number')).toBe('AAGFO2658A');
  });

  // A real REG-06 is a NUMBERED FORM: OCR runs its labels together and puts the values in a
  // separate column. A label-anchored regex captured the FOLLOWING LABELS as the value and
  // showed a reviewer "2. Trade Name, if any 3. Constitution of Business ...". Seen on
  // production claim MZBEU813LSN749087 p.6. The pane now carries only the two fields that
  // are read by shape rather than by label.
  it('shows no name/date rows, which a numbered form cannot yield by label', () => {
    const FORM_OCR = `Form GST REG-06
1. Legal Name 2. Trade Name, if any 3. Constitution of Business 4. Address of Principal Place of Business
Registration Number : 24AAGFO2658A1ZM`;
    const labels = documentFields(FORM_OCR, 'GST').map((x) => x.label);
    expect(labels).toEqual(['GSTIN', 'PAN Number']);
    expect(labels).not.toContain('Legal Name');
  });
});
