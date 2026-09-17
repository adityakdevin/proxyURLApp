/**
 * Online verification of a KIA Safety motor policy, from the link its QR code carries.
 *
 * A policy QR embeds https://www.kiasafety.com/VISOF/Policy/Vs_Pol_QRCode.aspx?policyNo=…,
 * which returns the insurer's own record of the policy. Two things on it are evidence a
 * printed policy cannot fake:
 *  - "Invalid Data": KIA Safety has no such policy — the QR was made up or altered.
 *  - the insurer on record is not the insurer printed on the policy page — a schedule pasted
 *    onto another insurer's stationery.
 *
 * Only that one host is ever fetched. The URL comes out of a document, so following any
 * link a QR carries would let an uploaded file make the server request an arbitrary address.
 */

export interface OnlinePolicy {
  valid: boolean;
  insurer: string;
  name: string;
  policyNo: string;
  chassis: string;
  engine: string;
}

export interface OnlineFinding {
  code: 'QR_POLICY_NOT_FOUND_ONLINE' | 'QR_INSURER_MISMATCH' | 'QR_ONLINE_UNVERIFIED';
  severity: 'ERROR' | 'INFO';
  message: string;
  data: Record<string, unknown>;
}

type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; text(): Promise<string> }>;

const KIA_HOSTS = new Set(['www.kiasafety.com', 'kiasafety.com']);
/** The site answers in well under a second; a hung request must not hold up the QR check. */
const FETCH_TIMEOUT_MS = 10_000;

/**
 * The KIA Safety verification link in a QR payload, as https — or null for anything else.
 * The QR prints http://, and kiasafety.com does not answer on http at all.
 */
export function kiaVerificationUrl(qrValue: string): string | null {
  const m = /https?:\/\/[^\s|,]+/i.exec(qrValue);
  if (!m) return null;
  try {
    const u = new URL(m[0]);
    if (!KIA_HOSTS.has(u.hostname.toLowerCase()) || !u.pathname.startsWith('/VISOF/Policy/')) return null;
  } catch {
    return null;
  }
  // Rewrite the scheme on the original string: re-serialising through URL could re-encode
  // the base64 tokens, which the site compares byte for byte.
  return m[0].replace(/^http:\/\//i, 'https://');
}

const span = (html: string, id: string) => {
  const m = new RegExp(`<span id="${id}"[^>]*>([^<]*)</span>`).exec(html);
  return (m?.[1] ?? '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
};

/** The record on a KIA Safety policy page. The page is ASP.NET with stable element ids. */
export function parseKiaPolicyPage(html: string): OnlinePolicy {
  const insurer = span(html, 'lblIC');
  return {
    valid: !/invalid data/i.test(span(html, 'lblmsg')) && insurer !== '',
    insurer,
    name: span(html, 'lblName'),
    policyNo: span(html, 'lblPolNo'),
    chassis: span(html, 'lblChesisNo'),
    engine: span(html, 'lblEngNo'),
  };
}

/** Insurer names printed on a page: the words before "(General) Insurance/Assurance Co". */
export function printedInsurers(pageText: string): string[] {
  const out = new Set<string>();
  const re = /((?:[A-Z][A-Za-z&]*[^\S\n]+){0,2}?[A-Z][A-Za-z&]*)[^\S\n]+(?:General[^\S\n]+)?(?:Insurance|Assurance)[^\S\n]+Co(?:mpany)?\b/g;
  for (const m of pageText.matchAll(re)) out.add(m[1].trim());
  return [...out];
}

/** Words that say "an insurer" rather than WHICH insurer. `india` is here because "New India"
 *  and "United India" are two different companies that would otherwise share it. */
const GENERIC = new Set(['general', 'insurance', 'assurance', 'co', 'company', 'ltd', 'limited', 'the', 'of', 'and', 'india']);

/**
 * Renamed insurers, old brand → current. A policy printed on the old stationery is genuine:
 * MZBGD813MSN273343's schedule says "Reliance General Insurance Co.Ltd." (IRDA Reg No. 103)
 * while KIA Safety's record says "IndusInd General Insurance" — the same company, renamed after
 * IndusInd International Holdings acquired it. Without this every such claim would fail.
 */
const RENAMED: Record<string, string> = {
  reliance: 'indusind',
  edelweiss: 'zuno',
  chola: 'cholamandalam',
};

const brandTokens = (name: string) =>
  new Set(
    name
      .toLowerCase()
      .replace(/[^a-z& ]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && !GENERIC.has(t))
      .map((t) => RENAMED[t] ?? t)
  );

/** Do two insurer names denote the same company? Any shared distinctive word counts, so
 *  "Bajaj Allianz" (old) and "Bajaj General" (new), or "Future Generali" and "Generali
 *  Central", still agree. */
export function sameInsurer(a: string, b: string): boolean {
  const ta = brandTokens(a);
  const tb = brandTokens(b);
  for (const t of ta) if (tb.has(t)) return true;
  return false;
}

/**
 * Verify a QR's policy against KIA Safety's online record.
 *
 * Returns ERROR findings for a policy KIA Safety does not know and for a printed insurer that
 * is not the one on record; nothing when all agrees or when there is no KIA Safety link. An
 * unreachable site is reported as INFO — the policy is unverified, not wrong, and a network
 * problem must never fail a claim.
 */
export async function verifyKiaPolicy(
  qrValue: string,
  pageText: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<OnlineFinding[]> {
  const url = kiaVerificationUrl(qrValue);
  if (!url) return [];

  let record: OnlinePolicy;
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error('non-2xx');
    record = parseKiaPolicyPage(await res.text());
  } catch {
    return [
      {
        code: 'QR_ONLINE_UNVERIFIED',
        severity: 'INFO',
        message: 'KIA Safety could not be reached, so this policy was not verified online. Open the QR link to check it.',
        data: { url },
      },
    ];
  }

  if (!record.valid) {
    return [
      {
        code: 'QR_POLICY_NOT_FOUND_ONLINE',
        severity: 'ERROR',
        message: 'KIA Safety has no record of the policy in this QR code ("Invalid Data") — the QR code may be made up or altered.',
        data: { url },
      },
    ];
  }

  const printed = printedInsurers(pageText);
  if (printed.length > 0 && !printed.some((p) => sameInsurer(record.insurer, p))) {
    return [
      {
        code: 'QR_INSURER_MISMATCH',
        severity: 'ERROR',
        message: `KIA Safety's record says the insurer is "${record.insurer}", but the policy page names ${printed
          .map((p) => `"${p}"`)
          .join(', ')}.`,
        data: { url, onlineInsurer: record.insurer, printedInsurers: printed, online: record },
      },
    ];
  }
  return [];
}
