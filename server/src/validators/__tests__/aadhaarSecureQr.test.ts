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
