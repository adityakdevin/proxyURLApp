import { documentFields } from '../docFields.js';

// Verbatim OCR output from docs/samples/spelling-checks/MZBB2814LSN010383.pdf — the claim a
// reviewer reported as reading nothing off its PAN and Aadhaar pages. Line breaks matter:
// the holder-name readers anchor on them.
const AADHAAR = `bh Cammmentnrings cc sare
fT gi
° ~~) Ravi Shankar
g wi fafy/DOB: 20/07/1994
= -e
o MALE
Poe
wy
__ 4665 5221 0629
VID :9150645722608544
AIT ATEN, AHN ger
Address: Sieg ade es
C/O: Jay Singh, Ward No 12, Durjanpur(143), Bal i
Haryana - 125052 Par Ei ey`;

const PAN = `* INCOMETAXDEPARTMENT ~~ <# GOVT. OF INDIA
~~ wl} dE §& 1 FE —
ow' Permanent Account Number Card SE 3 RET 3

kJ HOQPS6933P Ts
od ® Shia 5
Te PAT A CAI a NE
SE pes rs Sd Xs
RAVI SHANKAR ATA
57 %7 ATH | Father's Name _ - oo
JAY SINGH
w= wr wri Date ABT
20/07/1994 «© y J
4 PAN Apoiication Digitatly Signed, Card Not Valid ales Physically Signed §`;

const valueOf = (text: string, type: 'PAN' | 'AADHAR', label: string) =>
  documentFields(text, type).find((f) => f.label === label)?.value ?? null;

describe('ID card field extraction', () => {
  it('reads every Aadhaar field off a sideways-scanned card', () => {
    expect(valueOf(AADHAAR, 'AADHAR', 'Aadhaar Number')).toBe('4665 5221 0629');
    expect(valueOf(AADHAAR, 'AADHAR', 'Holder Name')).toBe('Ravi Shankar');
    expect(valueOf(AADHAAR, 'AADHAR', 'Gender')).toBe('MALE');
    expect(valueOf(AADHAAR, 'AADHAR', "Father's Name")).toBe('Jay Singh');
    expect(valueOf(AADHAAR, 'AADHAR', 'Date of Birth')).toBe('20/07/1994');
  });

  it('reads the PAN holder name from the line above the father label', () => {
    expect(valueOf(PAN, 'PAN', 'PAN Number')).toBe('HOQPS6933P');
    expect(valueOf(PAN, 'PAN', 'Holder Name')).toBe('RAVI SHANKAR');
    expect(valueOf(PAN, 'PAN', "Father's Name")).toBe('JAY SINGH');
    expect(valueOf(PAN, 'PAN', 'Date of Birth')).toBe('20/07/1994');
  });

  it('shows the ONE parent row the card carries, not an empty pair', () => {
    const labels = documentFields(PAN, 'PAN').map((f) => f.label);
    expect(labels).toContain("Father's Name");
    expect(labels).not.toContain("Mother's Name");

    const motherCard = PAN.replace("Father's Name", "Mother's Name");
    const motherLabels = documentFields(motherCard, 'PAN').map((f) => f.label);
    expect(motherLabels).toContain("Mother's Name");
    expect(motherLabels).not.toContain("Father's Name");
  });

  it('never reports a spouse as the father (W/O is not a parent)', () => {
    const wife = AADHAAR.replace('C/O: Jay Singh', 'W/O: Jay Singh');
    expect(valueOf(wife, 'AADHAR', "Father's Name")).toBeNull();
  });

  // 2026-09-03 reviewer sheet, claim MZBEP813LSN725251: "The name on the Aadhaar card is
  // mentioned as 'Mr. Lalit Mohan' ... the software is incorrectly considering 'Mr.' as
  // part of the name." With the dot intact the caps run ENDS at it, so the name read as
  // the bare salutation; without it the salutation rode along inside the name.
  it('drops a salutation from a card name, with or without its dot', () => {
    const dotted = PAN.replace('RAVI SHANKAR ATA', 'MR. RAVI SHANKAR');
    expect(valueOf(dotted, 'PAN', 'Holder Name')).toBe('RAVI SHANKAR');

    const bare = PAN.replace('RAVI SHANKAR ATA', 'MR RAVI SHANKAR');
    expect(valueOf(bare, 'PAN', 'Holder Name')).toBe('RAVI SHANKAR');
  });
});
