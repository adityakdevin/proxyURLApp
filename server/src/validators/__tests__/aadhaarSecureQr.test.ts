import { decodeAadhaarSecureQr, encodeAadhaarSecureQr, isNumericQrPayload } from '../aadhaarSecureQr.js';

// Field order per UIDAI Secure QR spec §3.1.
const DEMO = [
  '2', // email/mobile present indicator
  '890820190305150137123', // referenceId (last 4 of Aadhaar + timestamp)
  'Ravi Shankar',
  '20-07-1994',
  'M',
  'Jay Singh',
  'Hisar',
  'Near Bus Stand',
  'Ward No 12',
  'Durjanpur',
  '125052',
  'Durjanpur',
  'Haryana',
  'Main Road',
  'Hisar',
  'Durjanpur',
];

describe('Aadhaar Secure QR', () => {
  it('reads the demographic fields out of a spec-shaped payload', () => {
    const d = decodeAadhaarSecureQr(encodeAadhaarSecureQr([...DEMO, '']));
    expect(d).not.toBeNull();
    expect(d!.name).toBe('Ravi Shankar');
    expect(d!.dob).toBe('20-07-1994');
    expect(d!.gender).toBe('M');
    expect(d!.careOf).toBe('Jay Singh');
    expect(d!.pincode).toBe('125052');
    expect(d!.referenceId).toBe('890820190305150137123');
  });

  it('handles the newer version-marked cards, where every field shifts by one', () => {
    const d = decodeAadhaarSecureQr(encodeAadhaarSecureQr(['V2', ...DEMO, '']));
    expect(d!.version).toBe('V2');
    expect(d!.name).toBe('Ravi Shankar');
    expect(d!.gender).toBe('M');
  });

  it('is not fooled by other long digit strings', () => {
    // A PAN enhanced QR is also a long digit run, but bit-packed rather than gzipped.
    expect(decodeAadhaarSecureQr('9'.repeat(4500))).toBeNull();
    expect(decodeAadhaarSecureQr('12345678901234567890')).toBeNull();
  });

  it('leaves ordinary values alone — a policy or phone number is not an encoded payload', () => {
    expect(isNumericQrPayload('251589936500')).toBe(false);
    expect(isNumericQrPayload('1800 266 4545')).toBe(false);
    expect(isNumericQrPayload('4665522106291')).toBe(false);
    expect(isNumericQrPayload('7'.repeat(200))).toBe(true);
  });

  it('never throws on rubbish', () => {
    for (const junk of ['', 'abc', '0', '-1', '9'.repeat(199)]) {
      expect(decodeAadhaarSecureQr(junk)).toBeNull();
    }
  });
});

// The gap that let the decoder sit imported-but-never-called: every test exercised the
// decoder in isolation, so nothing noticed the validator never invoked it. These pin the
// END-TO-END behaviour instead.
import { isOpaqueQrValue } from '../qrValidator.js';
import { compareQrToFields, parseQrPayload } from '../qrCompare.js';
import { aadhaarQrAsFields, isUnreadableQrPayload } from '../aadhaarSecureQr.js';

const REAL_SHAPE = encodeAadhaarSecureQr([
  'V2', '2', '062920220320134721426', 'Ravi Shankar', '20-07-1994', 'M',
  'C/O: Jay Singh', 'Hisar', '', 'Ward No 12', 'Durjanpur', '125052',
  'Durjanpur', 'Haryana', 'Main Road', 'Hisar', 'Durjanpur', '',
]);

describe('Aadhaar Secure QR, end to end', () => {
  it('renders as the shared Label:Value shape the rest of the system parses', () => {
    const rendered = aadhaarQrAsFields(REAL_SHAPE)!;
    expect(rendered).toContain('Name:Ravi Shankar');
    expect(rendered).toContain('DOB:20-07-1994');
    // "M" on the card vs "MALE" read off the printed face would read as a mismatch.
    expect(rendered).toContain('Gender:MALE');

    const parsed = parseQrPayload(rendered);
    expect(parsed.get('name')).toBe('Ravi Shankar');
    expect(parsed.get('gender')).toBe('MALE');
  });

  it('cross-checks a decoded card against the printed pane', () => {
    const cmp = compareQrToFields(aadhaarQrAsFields(REAL_SHAPE)!, [
      { label: 'Holder Name', value: 'Ravi Shankar' },
      { label: 'Gender', value: 'MALE' },
      { label: 'Date of Birth', value: '20-07-1994' },
    ]);
    expect(cmp.length).toBeGreaterThan(0);
    expect(cmp.every((c) => c.verdict === 'MATCH')).toBe(true);

    // And it still catches a forged card.
    const forged = compareQrToFields(aadhaarQrAsFields(REAL_SHAPE)!, [
      { label: 'Holder Name', value: 'Suresh Kumar' },
    ]);
    expect(forged[0].verdict).toBe('MISMATCH');
  });

  it('treats an unexpandable payload as opaque so it is never shown raw', () => {
    const panLike = '9'.repeat(3600); // enhanced PAN QR: digits, but bit-packed not gzipped
    expect(isUnreadableQrPayload(panLike)).toBe(true);
    expect(isOpaqueQrValue(panLike)).toBe(true);
    expect(parseQrPayload(panLike).size).toBe(0);
    // A decodable Aadhaar payload is NOT opaque — it has real fields to show.
    expect(isOpaqueQrValue(aadhaarQrAsFields(REAL_SHAPE)!)).toBe(false);
    // Ordinary payloads are untouched.
    expect(isOpaqueQrValue('Name:MR. RAVI SHANKAR|Pol.No.:OG-26-1021')).toBe(false);
  });
});
