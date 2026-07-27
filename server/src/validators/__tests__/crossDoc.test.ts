import {
  classifyDocType,
  nameMatches,
  nameTokens,
  idNorm,
  idMatches,
  modelMatches,
  extractNames,
  extractRelationNames,
  extractVehicleNos,
  crossDocFieldFindings,
  CrossPage,
} from '../crossDocLogic.js';

describe('classifyDocType (priority-scored, margin-gated)', () => {
  it('classifies an invoice by distinctive markers', () => {
    expect(classifyDocType('TAX INVOICE\nInvoice No: 42\nEx-Showroom Price')).toBe('INVOICE');
  });
  it('classifies an insurance policy', () => {
    expect(classifyDocType('Policy No 9\nInsured: X\nPremium 5000\nSum Insured 300000')).toBe('INSURANCE');
  });
  it('classifies RC and payslip and staff id', () => {
    expect(classifyDocType('Certificate of Registration\nRegistering Authority')).toBe('RC');
    expect(classifyDocType('Salary Slip\nNet Pay 40000\nBasic Pay 20000')).toBe('PAYSLIP');
    expect(classifyDocType('Employee ID: E7\nIdentity Card')).toBe('STAFF_ID');
  });
  it('returns null on no markers and on a tie', () => {
    expect(classifyDocType('a plain page with nothing distinctive')).toBeNull();
    // one invoice marker + one RC marker → tie → unclassifiable
    expect(classifyDocType('Invoice No: 1 and Registration Certificate')).toBeNull();
  });
});

describe('nameMatches (token-set, initial-aware)', () => {
  it('drops honorifics in tokenization', () => {
    expect(nameTokens('Mr. Rajesh Kumar')).toEqual(['rajesh', 'kumar']);
  });
  it('matches initials and surname-first ordering', () => {
    expect(nameMatches('Rajesh Kumar', 'Rajesh K')).toBe(true);
    expect(nameMatches('Rajesh Kumar', 'R. Kumar')).toBe(true);
    expect(nameMatches('Rajesh Kumar', 'Kumar Rajesh')).toBe(true);
  });
  it('does NOT match different people who share a surname', () => {
    expect(nameMatches('Rajesh Kumar', 'Suresh Kumar')).toBe(false);
    expect(nameMatches('R. Kumar', 'S. Kumar')).toBe(false);
  });
});

describe('idMatches (OCR-fold + Levenshtein<=1)', () => {
  it('folds OCR-ambiguous glyphs', () => {
    expect(idNorm('O.I-B')).toBe('018'); // O->0, I->1, B->8, separators stripped
    expect(idMatches('CHASSIS0O1', 'CHASSIS001')).toBe(true); // O vs 0
  });
  it('tolerates a single edit but not two', () => {
    expect(idMatches('ABCD1234', 'ABCD1235')).toBe(true);
    expect(idMatches('ABCD1234', 'ABCD9935')).toBe(false);
  });
});

describe('modelMatches (token-subset)', () => {
  it('matches when one is a suffix-extended variant', () => {
    expect(modelMatches('Swift VXI', 'Swift VXI BS6')).toBe(true);
  });
  it('does not match a different model', () => {
    expect(modelMatches('Swift VXI', 'Baleno ZXI')).toBe(false);
  });
});

describe('extractors', () => {
  it('extractNames excludes relation names', () => {
    const t = 'Customer Name: Rajesh Kumar\nFather Name: Mohan Kumar';
    expect(extractNames(t)).toEqual(['Rajesh Kumar']);
    expect(extractRelationNames(t)).toEqual(['Mohan Kumar']);
  });
  it('extractVehicleNos ignores NEW / APPLIED FOR placeholders', () => {
    expect(extractVehicleNos('Regn No: MH12AB1234')).toEqual(['MH12AB1234']);
    expect(extractVehicleNos('Registration No: APPLIED FOR')).toEqual([]);
    expect(extractVehicleNos('Vehicle No: NEW')).toEqual([]);
  });
});

const page = (documentId: string, text: string, over: Partial<CrossPage> = {}): CrossPage => ({
  documentId,
  page: 1,
  text,
  ...over,
});

describe('crossDocFieldFindings (consistency engine)', () => {
  it('flags a customer-name mismatch across two doc types as ERROR', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'Certificate of Registration Registering Authority\nName: Suresh Kumar'),
    ]);
    const mm = f.find((x) => x.code === 'CROSS_NAME_MISMATCH');
    expect(mm).toBeDefined();
    expect(mm!.severity).toBe('ERROR');
  });

  it('is quiet when the name agrees (initials) across docs', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'Certificate of Registration Registering Authority\nName: R. Kumar'),
    ]);
    expect(f.filter((x) => x.code === 'CROSS_NAME_MISMATCH')).toHaveLength(0);
  });

  it('flags chassis mismatch between invoice and insurance', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nChassis No: MAT1234567890'),
      page('d2', 'Policy No 9 Insured X Premium 1 Sum Insured 2\nChassis Number: MAT9999999999'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_CHASSIS_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  it('does not flag a new-car insurance for missing vehicle number', () => {
    const f = crossDocFieldFindings([
      page('d1', 'Certificate of Registration Registering Authority\nRegn No: MH12AB1234'),
      page('d2', 'Policy No 9 Insured X Premium 1 Sum Insured 2\nRegistration No: APPLIED FOR'),
    ]);
    expect(f.filter((x) => x.code === 'CROSS_VEHICLE_NO_MISMATCH')).toHaveLength(0);
  });

  it('downgrades to WARNING and notes unclassified pages', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'a plain scanned page\nName: Suresh Kumar'), // unclassifiable
    ]);
    const mm = f.find((x) => x.code === 'CROSS_NAME_MISMATCH');
    expect(mm!.severity).toBe('WARNING');
    expect(f.some((x) => x.code === 'CROSS_UNCLASSIFIED')).toBe(true);
  });

  it('is silent when a required doc type is simply absent', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
    ]);
    expect(f).toHaveLength(0);
  });

  it('downgrades a KYC-vs-customer name mismatch to WARNING (relation/nominee KYC)', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'KYC self-attested\nName: Mohan Kumar\nFather Name: Hariram Kumar'),
    ]);
    const mm = f.find((x) => x.code === 'CROSS_NAME_MISMATCH');
    expect(mm).toBeDefined();
    expect(mm!.severity).toBe('WARNING'); // not a hard red flag — KYC may be a relation's
  });

  it('keeps a name mismatch between two NON-KYC docs as a hard ERROR', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'Salary Slip Net Pay 1 Basic Pay 1\nEmployee Name: Suresh Kumar'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_NAME_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  it('flags an engine-number mismatch (invoice vs insurance) as ERROR', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nEngine No: ABCDE12345'),
      page('d2', 'Policy No 9 Insured X Premium 1 Sum Insured 2\nEngine Number: ZZZZZ99999'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_ENGINE_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  it('flags a model mismatch (invoice vs RC) as ERROR', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nModel: Swift VXI'),
      page('d2', 'Certificate of Registration Registering Authority\nModel: Baleno ZXI'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_MODEL_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  it('flags an employee-code mismatch (staff id vs payslip) as ERROR', () => {
    const f = crossDocFieldFindings([
      page('d1', 'Staff ID Identity Card\nEmp Code: EMP001'),
      page('d2', 'Salary Slip Net Pay 1 Basic Pay 1\nEmployee Code: EMP999'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_EMP_CODE_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  it('compares across pages that share one documentId (bundled PDF)', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar', { page: 1 }),
      page('d1', 'Certificate of Registration Registering Authority\nName: Suresh Kumar', { page: 2 }),
    ]);
    expect(f.some((x) => x.code === 'CROSS_NAME_MISMATCH' && x.severity === 'ERROR')).toBe(true);
  });

  // ── Regression guards for the false-positive fixes ──────────────────────────────
  it('does NOT treat a non-person "Bank/Company Name" label as the customer name', () => {
    const f = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar\nCompany Name: Maruti Suzuki'),
      page('d2', 'Policy No 9 Insured X Premium 1 Sum Insured 2\nInsured Name: Rajesh Kumar\nBank Name: HDFC Bank'),
    ]);
    expect(f.filter((x) => x.code === 'CROSS_NAME_MISMATCH')).toHaveLength(0);
  });

  it('does NOT flag a name that differs only by OCR drift (dropped char / merged tokens)', () => {
    const dropped = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajesh Kumar'),
      page('d2', 'Salary Slip Net Pay 1 Basic Pay 1\nEmployee Name: Rajesh Kumr'),
    ]);
    expect(dropped.filter((x) => x.code === 'CROSS_NAME_MISMATCH')).toHaveLength(0);
    const merged = crossDocFieldFindings([
      page('d1', 'TAX INVOICE Invoice No 1\nCustomer Name: Rajeshkumar Sharma'),
      page('d2', 'Salary Slip Net Pay 1 Basic Pay 1\nEmployee Name: Rajesh Kumar Sharma'),
    ]);
    expect(merged.filter((x) => x.code === 'CROSS_NAME_MISMATCH')).toHaveLength(0);
  });

  it('does NOT emit chassis/engine flags from a run-on two-column OCR header', () => {
    // No separators between labels and values → cannot safely attribute → extract nothing.
    const f = crossDocFieldFindings([
      page('d1', 'Certificate of Registration Registering Authority\nChassis No Engine No MAT1234567890 ENG987654321'),
      page('d2', 'TAX INVOICE Invoice No 1\nChassis No: MAT1234567890'),
    ]);
    expect(f.some((x) => x.code === 'CROSS_CHASSIS_MISMATCH' || x.code === 'CROSS_ENGINE_MISMATCH')).toBe(false);
  });
});

describe('extractNames / extractRelationNames label handling', () => {
  it('excludes non-person "X Name" labels but keeps person qualifiers', () => {
    expect(extractNames('Bank Name: HDFC Bank')).toEqual([]);
    expect(extractNames('Dealer Name: ABC Motors')).toEqual([]);
    expect(extractNames('Customer Name: Rajesh Kumar')).toEqual(['Rajesh Kumar']);
    expect(extractNames('Name: Rajesh Kumar')).toEqual(['Rajesh Kumar']);
  });

  it('extractRelationNames handles s/o and d/o and w/o forms', () => {
    expect(extractRelationNames('S/O: Mohan Kumar')).toEqual(['Mohan Kumar']);
    expect(extractRelationNames('D/O Hariram Kumar')).toEqual(['Hariram Kumar']);
    expect(extractRelationNames('W/O: Rajesh Kumar')).toEqual(['Rajesh Kumar']);
  });
});

describe('idMatches unequal-length (dropped/extra char)', () => {
  it('matches a single dropped char but not two', () => {
    expect(idMatches('ABCD1234', 'ABC1234')).toBe(true); // one char dropped
    expect(idMatches('ABCD1234', 'ABCD99')).toBe(false); // length differs by 2
  });
});
