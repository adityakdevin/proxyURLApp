import { compareQrToFields, parseQrPayload } from '../qrCompare.js';
import { DocField } from '../docFields.js';

// The real QR payload decoded from docs/samples/spelling-checks/MZBB2814LSN010383.pdf.
const POLICY_QR =
  'Name:MR. RAVI  SHANKAR|Pol.No.:OG-26-1021-1825-00036132|Model:SYROS|Reg.No:New|' +
  'ChassisNo.:MZBB2814LSN010383|OD period27 Oct 2025  1:00PM-26 Oct 2026 11:59PM|' +
  'CPA Period:27 Oct 2025  1:00PM-26 Oct 2028 11:59PM|URL:http://x.example/a?b=c==';

// What the OCR actually reads off that same page — note the misread glyphs in the chassis
// (MZBB2SIALSNO10383) and the leading 0-for-O in the policy number.
const PANE: DocField[] = [
  { label: 'Policy No', value: '0G-26-1021-1825-00036132' },
  { label: "Insured's Name", value: 'RAVI SHANKAR' },
  { label: 'Chassis No', value: 'MZBB2SIALSNO10383' },
  { label: 'Engine No', value: 'DAFASM359948' },
  { label: 'Model', value: 'SYROS' },
];

const verdictFor = (cmp: ReturnType<typeof compareQrToFields>, label: string) =>
  cmp.find((c) => c.label === label)?.verdict;

describe('QR payload parsing', () => {
  it('splits pipe-delimited Label:Value pairs without breaking on time colons', () => {
    const p = parseQrPayload(POLICY_QR);
    expect(p.get('name')).toBe('MR. RAVI  SHANKAR');
    expect(p.get('polno')).toBe('OG-26-1021-1825-00036132');
    expect(p.get('chassisno')).toBe('MZBB2814LSN010383');
    expect(p.get('cpaperiod')).toBe('27 Oct 2025  1:00PM-26 Oct 2028 11:59PM');
  });

  it('reads the older Aadhaar XML QR attributes', () => {
    const p = parseQrPayload('<PrintLetterBarcodeData uid="466552210629" name="Ravi Shankar" gender="M"/>');
    expect(p.get('uid')).toBe('466552210629');
    expect(p.get('name')).toBe('Ravi Shankar');
  });

  // Shape taken from a GST e-invoice QR already stored in validation_results: comma
  // delimited, a space before each colon. It parsed correctly all along — the reason the
  // reviewer saw no verdict was that none of its keys had a row in QR_KEY_TO_LABELS.
  it('reads a comma-delimited GST e-invoice QR', () => {
    const GST_QR =
      'Supplier_Gst_No :21AEFFS5576Q1ZD, Invoice_No :OD302K2025000012, ' +
      'Invoice_Date :24/02/2026, Total_Amt :845000.00, Cgst_Amt :0.00, Igst_Amt :0.00';
    const p = parseQrPayload(GST_QR);
    expect(p.get('suppliergstno')).toBe('21AEFFS5576Q1ZD');
    expect(p.get('invoiceno')).toBe('OD302K2025000012');
    expect(p.get('invoicedate')).toBe('24/02/2026');

    // The invoice number now reaches the pane; the date deliberately does not — the pane
    // holds the invoice's own printed format, and a format difference would read as a
    // MISMATCH, which fails the whole check on a correct document.
    const pane: DocField[] = [
      { label: 'Invoice No', value: 'OD302K2025000012' },
      { label: 'Invoice Date', value: '24-Feb-2026' },
    ];
    const cmp = compareQrToFields(GST_QR, pane);
    expect(verdictFor(cmp, 'Invoice No')).toBe('MATCH');
    expect(cmp.some((c) => c.label === 'Invoice Date')).toBe(false);
  });

  // Verbatim from a production claim (S.No 16, MZBEU813LSN749087 p.6). One field per LINE,
  // and the address carries five commas — splitting on ',' produced the keys
  // ["legalname", "360005typeofregistration"] and lost GSTIN and PAN completely.
  const GST_CERT =
    'Legal Name :OM ENTERPRISE\n' +
    'GSTIN :24AAGFO2658A1ZM\n' +
    'PAN :AAGFO2658A\n' +
    'Address of Principal Place of Business :SWATIPARK MAIN ROAD, PLOT NO 15 SHED NO 3, ' +
    'SHREE HARI SOCITEY, NEAR KRISHANA WAYBRIJ KOTHARIYA, RAJKOT, Rajkot, Gujarat, 360005\n' +
    'Type of Registration :Regular\n' +
    'Date of Registration :25/02/2019';

  it('reads a newline-delimited GST registration certificate whose address holds commas', () => {
    const p = parseQrPayload(GST_CERT);
    expect(p.get('legalname')).toBe('OM ENTERPRISE');
    expect(p.get('gstin')).toBe('24AAGFO2658A1ZM');
    expect(p.get('pan')).toBe('AAGFO2658A');
    expect(p.get('typeofregistration')).toBe('Regular');
    // The address keeps its own commas rather than being split into junk keys.
    expect(p.get('addressofprincipalplaceofbusiness')).toContain('Gujarat, 360005');
  });

  it('verifies the PAN printed on a page against its GST certificate QR', () => {
    // `pan` was already mapped to 'PAN Number'; only the delimiter stood in the way.
    const cmp = compareQrToFields(GST_CERT, [{ label: 'PAN Number', value: 'AAGFO2658A' }]);
    expect(verdictFor(cmp, 'PAN Number')).toBe('MATCH');
    const tampered = compareQrToFields(GST_CERT, [{ label: 'PAN Number', value: 'AAGFO9999A' }]);
    expect(verdictFor(tampered, 'PAN Number')).toBe('MISMATCH');
  });

  it('reads a newline-delimited GST tax-invoice QR', () => {
    // Verbatim from S.No 19 (MZBGB814LSN298909 p.11). Note `documentnumber` is deliberately
    // NOT mapped to 'Invoice No': this is the INSURER's tax invoice, whose number differs
    // from the dealer invoice on the pane, and a MISMATCH fails the whole check.
    const p = parseQrPayload(
      'GSTN of Supplier: 06AAFCK7016C1ZX\nGSTN of Buyer:\nDocument Number: 261519042400\n' +
        'Document Type : Tax Invoice\nDate of Creation of Invoice : 31/03/2026\nHSN code: 997134'
    );
    expect(p.get('gstnofsupplier')).toBe('06AAFCK7016C1ZX');
    expect(p.get('documentnumber')).toBe('261519042400');
    expect(p.get('documenttype')).toBe('Tax Invoice');
    expect(p.has('gstnofbuyer')).toBe(false); // empty value carries nothing to compare
  });


  it('verifies a GST certificate PAN against its own QR', () => {
    const pane: DocField[] = [
      { label: 'GSTIN', value: '24AAGFO2658A1ZM' },
      { label: 'PAN Number', value: 'AAGFO2658A' },
    ];
    const cmp = compareQrToFields(GST_CERT, pane);
    expect(verdictFor(cmp, 'PAN Number')).toBe('MATCH');
  });

  // REGRESSION. `gstin` was mapped for comparison and had to be unmapped: on production
  // claim MZBEU813LSN749087 p.6, OCR read the printed GSTIN as 24AAGFO2459A1ZM where the QR
  // says 24AAGFO2658A1ZM — two digit misreads on small print. identifierMatches allows
  // length/8 = 1 edit over 15 characters, so it scored MISMATCH, and a MISMATCH FAILS the
  // whole QR check on a legitimate certificate. It was OCR and not tampering: the QR's own
  // PAN agrees with the QR's GSTIN, which a forger would have altered together.
  it('does NOT fail a claim when OCR misreads the printed GSTIN', () => {
    const cmp = compareQrToFields(GST_CERT, [
      { label: 'GSTIN', value: '24AAGFO2459A1ZM' }, // what OCR actually read
    ]);
    expect(cmp).toEqual([]); // shown to the reviewer, never compared
  });

  it('compares nothing for an encrypted Secure QR blob', () => {
    expect(parseQrPayload('binary:AAECAwQ=').size).toBe(0);
    expect(compareQrToFields('binary:AAECAwQ=', PANE)).toEqual([]);
  });
});

describe('QR vs document comparison', () => {
  it('passes a genuine claim despite OCR glyph noise in the printed values', () => {
    const cmp = compareQrToFields(POLICY_QR, PANE);
    expect(verdictFor(cmp, 'Policy No')).toBe('MATCH'); // 0G vs OG
    expect(verdictFor(cmp, 'Chassis No')).toBe('MATCH'); // MZBB2SIALSNO10383 vs MZBB2814LSN010383
    expect(verdictFor(cmp, "Insured's Name")).toBe('MATCH'); // "MR. RAVI  SHANKAR" vs "RAVI SHANKAR"
    expect(verdictFor(cmp, 'Model')).toBe('MATCH');
    expect(cmp.every((c) => c.verdict === 'MATCH')).toBe(true);
  });

  it('flags a substituted chassis number', () => {
    const tampered = POLICY_QR.replace('MZBB2814LSN010383', 'MZBF9911LSN778821');
    expect(verdictFor(compareQrToFields(tampered, PANE), 'Chassis No')).toBe('MISMATCH');
  });

  it('flags a different insured name', () => {
    const tampered = POLICY_QR.replace('MR. RAVI  SHANKAR', 'SURESH KUMAR');
    expect(verdictFor(compareQrToFields(tampered, PANE), "Insured's Name")).toBe('MISMATCH');
  });

  it('only compares fields present on both sides', () => {
    const labels = compareQrToFields(POLICY_QR, PANE).map((c) => c.label);
    expect(labels).not.toContain('Engine No'); // the QR carries no engine number
    expect(labels).toEqual(expect.arrayContaining(['Policy No', 'Chassis No', 'Model']));
    // A pane row the QR is silent about is never reported as a mismatch.
    expect(compareQrToFields('Model:SYROS', PANE).map((c) => c.label)).toEqual(['Model']);
  });

  it('does not compare a policy QR against another document type', () => {
    const aadhaarPane: DocField[] = [
      { label: 'Aadhaar Number', value: '4665 5221 0629' },
      { label: 'Holder Name', value: 'Ravi Shankar' },
    ];
    // "Name" still lines up, but the policy number has no row here — no false mismatch.
    const labels = compareQrToFields(POLICY_QR, aadhaarPane).map((c) => c.label);
    expect(labels).toEqual(['Holder Name']);
  });
});
