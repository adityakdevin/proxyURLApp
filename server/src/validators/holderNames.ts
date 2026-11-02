import { TEMP_RC_RE, classifyDocType, chassisCandidates, chassisMatch, cleanPersonName, isFullChassis, isLabelValue, extractNames, nameMatches, nameTokens, otherNewCarPolicies, sameVehicle, type CrossPage } from './crossDocLogic.js';
import { BILL_TO_RE, CAPS_NAME_RE, billToName, documentFields, nameAboveLine } from './docFields.js';
import type { FindingInput } from './types.js';

export type Holder = { name: string; type: 'INVOICE' | 'STAFF_ID' | 'PAYSLIP' | 'INSURANCE' };

const LABEL: Record<Holder['type'], string> = {
  INVOICE: 'invoice',
  STAFF_ID: 'staff ID',
  PAYSLIP: 'payslip',
  INSURANCE: 'new-car policy',
};

// Identity cards other than the employer's: a staff marker on them is incidental.
const KYC_GOVT = new Set(['VOTER_ID', 'PAN', 'DL', 'PASSPORT']);
// "Name" must open its line (after Emp/Staff and a little table debris), so "Father's Name" and
// "Organisation Name" never match. Initials are allowed only between longer words, so a stray
// capital from the next column ("... D.O.B") is not swallowed into the name.
const STAFF_NAME_RE = /(?:^|\n)[^A-Za-z\n]{0,3}(?:(?:[Ee]mp(?:loyee)?|[Ss]taff)\.?\s+)?[Nn]ame\b\s*[:\-]?\s*(?:[A-Z]\s+)?([A-Z]{2,}(?:(?:[ \t]+[A-Z])*[ \t]+[A-Z]{2,})+)/;
// A raw line above the Emp ID line that cannot be the holder: a label row, a colon row (the value
// side of "Designation: Senior Teacher"), or the employer's own name. A bare designation
// ("Senior Manager") has no such marker; holderNameFindings covers it by checking the customer.
const CARD_LABEL_FIRST_RE = /^[^A-Za-z]*(?:designation|desig|department|dept|grade|division|branch|location|blood|valid|dob|date|issued|holder|signature|authori[sz]ed|identity|emergency|contact|phone|mobile|address|father|mother|name|to)\b/i;
const EMPLOYER_LAST_RE = /\b(?:limited|ltd|pvt|private|industries|school|college|university|hospital|bank|corporation|company|department|services|solutions|technologies)[^A-Za-z]*$/i;
const notAHolderLine = (raw: string) => raw.includes(':') || CARD_LABEL_FIRST_RE.test(raw) || EMPLOYER_LAST_RE.test(raw);
const STAFF_ANCHOR_RE = /\bemp(?:loyee)?\.?\s*(?:id|code|no)\b|\bstaff\s*(?:id|code|no)\b/i;

const twoWords = (v: string | null | undefined): v is string => !!v && v.split(/\s+/).filter((t) => /[A-Za-z]{3,}/.test(t)).length >= 2;
function insuredHolder(text: string): string | null {
  const tokens = (fieldValue(text, 'INSURANCE', "Insured's Name") ?? '').split(/\s+/).filter(Boolean);
  // insuredName's capitals run keeps going into an ALL-CAPS next column; cleanPersonName cuts it.
  const cut = cleanPersonName(tokens.join(' '));
  if (!cut || twoWords(cut)) return cut;
  // The field reader stops at a middle initial ("RAVI K VERMA" reads "RAVI"); extractNames keeps
  // it. Read only the insured's own line, so another "Name:" line on the page cannot stand in.
  const line = text.split('\n').find((l) => /insured'?s?\s+name/i.test(l)) ?? '';
  return extractNames(line).find((n) => n.split(' ')[0] === tokens[0]) ?? cut;
}
const fieldValue = (text: string, type: 'INVOICE' | 'INSURANCE', label: string) =>
  documentFields(text, type).find((f) => f.label === label)?.value ?? null;

// What may sit between the label and the value: OCR marks and punctuation, Tally's "(Bill to)"
// echo, a salutation, or the next column's header ("Bill To Address Ship To NAME", row 19).
// Anything else (a mixed-case name, an address) means the caps run is not the buyer.
const LABEL_GAP_NOISE_RE = /\(\s*bill(?:ed)?\s*to\s*\)|\b(?:address|ship|to|name|details|customer|party|of|mr|mrs|ms|m\/s|m)\b\.?|[^A-Za-z0-9]/gi;

// Not a buyer's name: Tally's tax lines under the label ("GSTIN UNREGISTERED", "STATE CODE 36"),
// and the caps header or delivery unit a column-header gap lets through ("CONSIGNEE DETAILS").
const ADDRESS_START_RE = /^(?:house|flat|plot|door|no|near|opp)$/i;
const NOT_BUYER_RE = /\b(?:gstin|gst|uin|unregistered|state|consignee|details|receiver|recipient|unit)\b/i;

/** The label-less invoice buyer. billToName takes the first capitals run within 60 characters
 *  of the label, so the value is accepted only when it starts at the label (not an address or
 *  a later line) and survives the same cleaning extractNames applies. */
function billToHolder(text: string): string | null {
  const raw = billToName(text);
  const label = BILL_TO_RE.exec(text);
  if (!raw || !label) return null;
  const from = label.index + label[0].length;
  const at = text.indexOf(raw.split(' ')[0], from);
  if (at < 0 || text.slice(from, at).replace(LABEL_GAP_NOISE_RE, '') !== '') return null;
  // Same-line address ("ANIL SHARMA HOUSE NO 4-5 ...") is not part of the buyer; cut it from the
  // third token on so a first or second name that looks like an address word is kept.
  const tokens = raw.split(' ');
  const k = tokens.findIndex((t, i) => i >= 2 && ADDRESS_START_RE.test(t));
  const v = cleanPersonName(k < 0 ? raw : tokens.slice(0, k).join(' '));
  return twoWords(v) && !NOT_BUYER_RE.test(v) ? v : null;
}

/** The name of whoever the document belongs to, or null when no anchored reader finds one. */
export function holderName(page: CrossPage, newCarPolicyPages: Set<string>): Holder | null {
  const text = page.text;
  switch (classifyDocType(text)) {
    case 'INVOICE': {
      // A labelled invoice is dmsNameFindings' job; only the label-less layout is read here.
      if (extractNames(text).length) return null;
      const v = billToHolder(text);
      return v ? { name: v, type: 'INVOICE' } : null;
    }
    case 'STAFF_ID': {
      if (page.govtCode && KYC_GOVT.has(page.govtCode)) return null;
      const labelled = extractNames(text)[0];
      if (labelled) return { name: labelled, type: 'STAFF_ID' };
      // cleanPersonName cuts at the next label, as extractNames does.
      const m = cleanPersonName(STAFF_NAME_RE.exec(text)?.[1] ?? '');
      if (twoWords(m)) return { name: m, type: 'STAFF_ID' };
      const above = nameAboveLine(text, STAFF_ANCHOR_RE, notAHolderLine);
      return twoWords(above) ? { name: above, type: 'STAFF_ID' } : null;
    }
    case 'PAYSLIP': {
      const n = extractNames(text)[0];
      return n ? { name: n, type: 'PAYSLIP' } : null;
    }
    case 'INSURANCE': {
      if (!newCarPolicyPages.has(`${page.documentId}:${page.page}`)) return null;
      const v = insuredHolder(text);
      return v ? { name: v, type: 'INSURANCE' } : null;
    }
    default:
      return null;
  }
}

const OWNER_LABEL_RE = /(?:owner\s*name|ownername|name\s+of\s+(?:the\s+)?owner|regd\.?\s*owner|registered\s+owner|owner\s+serial)\b[^A-Za-z\n]{0,4}/i;

const NOT_AN_OWNER_RE = /^(?:OWNERSHIP|PERMANENT|SON|WIFE|DAUGHTER|ADDRESS)$/;
// A caps run on the owner label's line, or under it, that is the next label and not a name.
const isOwnerLabel = (run: string) => isLabelValue(run) || NOT_AN_OWNER_RE.test(run.split(/\s+/)[0]);

/** RC owner: "Owner Name", "Name of the Owner", "Regd./Registered Owner", "Owner Serial", value on the same line or the next. */
export function rcOwnerName(text: string): string | null {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = OWNER_LABEL_RE.exec(lines[i]);
    if (!m) continue;
    const rest = lines[i].slice(m.index + m[0].length).replace(/^.{0,3}?(?=[A-Z]{2})/, '');
    const same = CAPS_NAME_RE.exec(rest);
    if (same && same.index <= 3 && same[1].replace(/\s/g, '').length >= 4 && !/^(?:SERIAL|NAME|OWNER)\b/.test(same[1]) && !isOwnerLabel(same[1])) return cleanPersonName(same[1]);
    // Smart-card RCs flatten a label column under "Owner Name": step over a bare one-word label
    // ("ADDRESS") to the line below it, but give up on a longer label row ("OWNERSHIP TYPE ...").
    for (let j = i + 1; j <= i + 2; j++) {
      const next = CAPS_NAME_RE.exec((lines[j] ?? '').replace(/^.*?owner\s+serial\b/i, ''));
      if (!next || next.index > 4 || next[1].replace(/\s/g, '').length < 4) break;
      if (!isOwnerLabel(next[1])) return cleanPersonName(next[1]);
      if (/\s/.test(next[1])) break;
    }
  }
  return null;
}

const NAME_LABEL_PREFIX_RE = /^[^A-Za-z]*(?:(?:emp(?:loyee)?|staff)\.?\s+)?name\b/i;

// Initials count ("ANIL K SHARMA", "K. RAMESH"), but a run needs two tokens and one real word.
const isNameRun = (run: string) => {
  const t = nameTokens(run);
  return t.length >= 2 && t.some((x) => x.length >= 3);
};

/** Does any line carry a name run that is the customer? Then the document is theirs. */
function carriesCustomer(ref: string, text: string): boolean {
  return text.split(/\r?\n/).some((line) =>
    (line.replace(NAME_LABEL_PREFIX_RE, ' ').match(/[A-Za-z]+(?:[ \t.]+[A-Za-z]+)*/g) ?? []).some((run) => isNameRun(run) && nameMatches(ref, run)),
  );
}

/** The invoice name used as the reference when DMS has none. An invoice for the claim's car
 *  wins over an earlier proforma or accessories invoice; the first invoice is used only when
 *  no invoice carries a chassis at all. The name must pass the same quality gate as a holder. */
function invoiceReference(pages: CrossPage[], claimVin: string): string | null {
  const claim = claimVin.toUpperCase();
  const invoices = pages.filter((p) => classifyDocType(p.text) === 'INVOICE').map((p) => ({ p, ids: chassisCandidates(p.text) }));
  const forClaim = invoices.filter(({ ids }) => ids.some((c) => chassisMatch(c, claim)));
  const pool = forClaim.length ? forClaim : invoices.some(({ ids }) => ids.length) ? [] : invoices;
  for (const { p } of pool) {
    const n = extractNames(p.text)[0] ?? billToHolder(p.text);
    if (twoWords(n)) return n;
  }
  return null;
}

/** ERROR CROSS_HOLDER_NAME_MISMATCH per page whose holder is not the customer. */
export function holderNameFindings(dmsName: string | null | undefined, pages: CrossPage[], claimVin: string): FindingInput[] {
  const dms = dmsName?.trim() || null;
  const invoiceRef = dms ? null : invoiceReference(pages, claimVin);
  const ref = dms ?? invoiceRef;
  if (!ref) return [];
  const policyKeys = new Set(otherNewCarPolicies(pages, claimVin).map(({ page }) => `${page.documentId}:${page.page}`));
  const rcOwners = pages
    .filter((p) => classifyDocType(p.text) === 'RC')
    .map((p) => rcOwnerName(p.text) ?? extractNames(p.text)[0])
    .filter((o): o is string => !!o);
  const out: FindingInput[] = [];
  for (const p of pages) {
    const h = holderName(p, policyKeys);
    // Without a DMS name the invoice is the reference itself.
    if (!h || (!dms && h.type === 'INVOICE') || nameMatches(ref, h.name)) continue;
    // A listed policy with no readable full chassis may still be a family car whose RC is here;
    // the chassis rule stays silent on it, so the holder rule must too when the owner agrees.
    if (h.type === 'INSURANCE' && !chassisCandidates(p.text).some(isFullChassis) && rcOwners.some((o) => nameMatches(o, h.name))) continue;
    // The layout readers cannot tell a designation from a name. If the customer's own name is
    // on their staff ID or payslip, the card is theirs and whatever else we read is not the holder.
    if ((h.type === 'STAFF_ID' || h.type === 'PAYSLIP') && carriesCustomer(ref, p.text)) continue;
    out.push({
      documentId: p.documentId,
      code: 'CROSS_HOLDER_NAME_MISMATCH',
      severity: 'ERROR',
      message: `Name "${h.name}" on the ${LABEL[h.type]} does not match the customer "${ref}" (${dms ? 'DMS upload' : 'invoice'}).`,
      page: p.page,
      data: { actual: h.name, expected: ref, expectedType: dms ? 'DMS' : 'INVOICE', actualType: h.type },
    });
  }
  return out;
}

/** ERROR CROSS_OLD_CAR_NAME_MISMATCH: old RC owner vs insured on the old policy with the same chassis (Rule #3). */
export function oldCarNameFindings(pages: CrossPage[], claimVin: string): FindingInput[] {
  // Without a full claim VIN the claim's own papers cannot be told from the old car's.
  const claim = claimVin.toUpperCase();
  if (!isFullChassis(claim)) return [];
  const skip = new Set(otherNewCarPolicies(pages, claimVin).map(({ page }) => `${page.documentId}:${page.page}`));
  // chassisMatch, not sameVehicle: an OCR-split own VIN is partial and must still count as the claim's car.
  const old = pages
    .map((p) => ({ p, ids: chassisCandidates(p.text), type: classifyDocType(p.text) }))
    .filter(({ p, ids, type }) => {
      if (ids.some((c) => chassisMatch(c, claim))) return false;
      // A temporary registration is a new car, never the old one.
      if (type === 'RC') return !TEMP_RC_RE.test(p.text);
      return type === 'INSURANCE' && !skip.has(`${p.documentId}:${p.page}`);
    });
  const out: FindingInput[] = [];
  for (const pol of old.filter((x) => x.type === 'INSURANCE')) {
    const rc = old.find((x) => x.type === 'RC' && x.ids.some((a) => pol.ids.some((b) => sameVehicle(a, b))));
    if (!rc) continue;
    const owner = rcOwnerName(rc.p.text) ?? extractNames(rc.p.text)[0];
    const insured = insuredHolder(pol.p.text);
    if (!owner || !insured || nameMatches(owner, insured)) continue;
    out.push({
      documentId: pol.p.documentId,
      code: 'CROSS_OLD_CAR_NAME_MISMATCH',
      severity: 'ERROR',
      message: `The old car policy on page ${pol.p.page} is insured to "${insured}", but the old car RC on page ${rc.p.page} (same chassis) is registered to "${owner}".`,
      page: pol.p.page,
      data: { actual: insured, expected: owner, rcPage: rc.p.page },
    });
  }
  return out;
}
