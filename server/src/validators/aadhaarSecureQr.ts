/**
 * Aadhaar Secure QR payloads.
 *
 * The Secure QR on a modern Aadhaar letter is NOT encrypted, despite what our reviewer
 * guidance used to say. UIDAI publishes the format precisely so verifying agencies can read
 * it offline (spec §1.1: "targeted at agencies who wanted to use the aadhaar secure QR code
 * to validate the resident"). The pipeline is, verbatim from §3.2:
 *
 *     base-10 digit string -> BigInteger -> byte array -> GZIP decompress
 *       -> fields delimited by the byte 0xFF -> ISO-8859-1 text
 *
 * No key is needed for the DEMOGRAPHIC fields. The trailing photo (JPEG2000) and the RSA
 * signature are what would need UIDAI's public certificate, and only to prove the data has
 * not been tampered with — which we do not attempt here.
 *
 * This matters because the payload is a pure digit string, so it looks like ordinary
 * printable text to a decoder. It sailed through every branch we had: not flagged opaque,
 * not parsed into fields, and finally rendered to the reviewer as a ~3,000-digit number.
 *
 * Pure (no I/O) so it unit-tests against a round-tripped payload.
 */
import zlib from 'zlib';

/** Field order for the unversioned format, UIDAI spec §3.1. The trailing photo, optional
 *  email/mobile hashes and signature are binary and deliberately not mapped. */
const FIELDS = [
  'emailMobilePresent',
  'referenceId',
  'name',
  'dob',
  'gender',
  'careOf',
  'district',
  'landmark',
  'house',
  'location',
  'pincode',
  'postOffice',
  'state',
  'street',
  'subDistrict',
  'vtc',
] as const;

/**
 * Is this the digit string an Aadhaar/PAN-style secure QR decodes to?
 *
 * The floor is deliberately high: a short run of digits is a policy number or a phone
 * number, and treating those as an encoded payload would hide real values from the pane.
 */
export const isNumericQrPayload = (text: string): boolean => /^\d{200,}$/.test(text);

/** BigInt -> bytes, as the spec's step 2 requires. */
function toBytes(payload: string): Buffer | null {
  try {
    let hex = BigInt(payload).toString(16);
    if (hex.length % 2 === 1) hex = `0${hex}`;
    return Buffer.from(hex, 'hex');
  } catch {
    return null;
  }
}

/**
 * The demographic fields of an Aadhaar Secure QR, or null if this payload is not one.
 *
 * Returns null rather than throwing on every failure mode — a PAN enhanced QR is also a
 * long digit string, but it is bit-packed rather than gzipped, so it lands here, fails the
 * gzip magic check, and is correctly reported as "not an Aadhaar Secure QR".
 */
export function decodeAadhaarSecureQr(payload: string): Record<string, string> | null {
  if (!isNumericQrPayload(payload)) return null;
  const bytes = toBytes(payload);
  // gzip magic. Without this check a non-Aadhaar numeric payload would reach gunzipSync and
  // rely on it throwing, which it does — but the magic check says WHY, and is free.
  if (!bytes || bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return null;

  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(bytes);
  } catch {
    return null;
  }

  // Fields are delimited by 0xFF. Everything past the last text field is the photo, so stop
  // as soon as the mapped names run out rather than trying to read binary as text.
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length && parts.length <= FIELDS.length; i++) {
    if (raw[i] === 0xff) {
      parts.push(raw.subarray(start, i).toString('latin1'));
      start = i + 1;
    }
  }
  if (parts.length < 5) return null;

  // Newer cards prepend a version marker ("V2".."V5"); when present every field shifts by
  // one. Detected rather than assumed, because both shapes are in the field.
  const versioned = /^V\d$/.test(parts[0]);
  const version = versioned ? parts[0] : null;
  const body = versioned ? parts.slice(1) : parts;

  const out: Record<string, string> = {};
  if (version) out.version = version;
  FIELDS.forEach((name, i) => {
    const v = (body[i] ?? '').trim();
    if (v) out[name] = v;
  });
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Build a Secure QR payload from demographic fields. Exists so the decoder can be tested
 * against a payload assembled to the spec, rather than only against whatever a scan happens
 * to produce.
 */
export function encodeAadhaarSecureQr(fields: string[]): string {
  const body = Buffer.from(fields.join('\xff'), 'latin1');
  const gz = zlib.gzipSync(body);
  return BigInt(`0x${gz.toString('hex')}`).toString(10);
}
