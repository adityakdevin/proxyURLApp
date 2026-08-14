/**
 * Answer the two open questions from the 2026-08 "Cases Outcome" QA review without
 * needing the source documents: both facts are already persisted by a validation run.
 *
 *  - Page count      META stores readPdfInfo's `Pages`, which is the TRUE page count of the
 *                    file, not the capped one. Tells us whether the scan ceiling truncated
 *                    S.No 19 / 20.
 *  - QR payload      QR stores every decoded value in details.decoded[]. Its KEY STRUCTURE
 *                    is what QR_KEY_TO_LABELS needs to map GST / Scrappage codes.
 *
 * Values are MASKED by default — the key names are all that is needed to extend the
 * mapping, and these payloads carry PAN / Aadhaar / GST / customer data. Pass --full to
 * print them in the clear (your own terminal, your own data).
 *
 *   npx tsx server/prisma/qaCaseDiagnostics.ts          # from the repo root
 *   npx tsx prisma/qaCaseDiagnostics.ts                 # from server/
 *   ... --full                                          # print QR values in the clear
 */
import path from 'path';
import dotenv from 'dotenv';

// Load server/.env explicitly, whatever the working directory. The REPO ROOT .env carries a
// stale `postgresql://` DATABASE_URL while the datasource provider is mysql, so running this
// from the root and letting the nearest .env win connects to nothing (or the wrong engine).
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Imported after dotenv so the client reads the URL resolved above.
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const FULL = process.argv.includes('--full');

/** The five cases the review could not close from code alone. */
const CASES = [
  { sno: 11, vin: 'MZBGB813LTN308495', asks: 'Scrappage QR — decoded but nothing shown' },
  { sno: 16, vin: 'MZBEU813LSN749087', asks: 'GST QR — decoded but nothing shown' },
  { sno: 17, vin: 'MZBET815VSN751228', asks: 'GST QR — decoded but nothing shown' },
  { sno: 19, vin: 'MZBGB814LSN298909', asks: 'failed to scan all required documents' },
  { sno: 20, vin: 'MZBFB813LSN603467', asks: 'failed to scan PAN QR' },
];

/** Name the payload's shape — that is what decides how parseQrPayload must handle it. */
function shapeOf(v: string): string {
  if (v.startsWith('binary:')) return 'binary blob (base64)';
  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(v)) return 'JWT (3 dot-separated base64url parts)';
  if (v.trimStart().startsWith('<')) return 'XML';
  if (/^https?:\/\//i.test(v)) return 'URL';
  if (/^\d+$/.test(v)) return `all digits (${v.length})`;
  if (v.includes('|')) return 'pipe-delimited';
  if (v.includes(',')) return 'comma-delimited';
  return 'other';
}

/** Keys a "Label:Value" style payload carries, which is what the mapping is keyed on. */
function keysOf(v: string): string[] {
  if (v.trimStart().startsWith('<')) {
    return [...v.matchAll(/([A-Za-z_][\w-]*)="/g)].map((m) => m[1]);
  }
  const sep = v.includes('|') ? '|' : ',';
  return v
    .split(sep)
    .map((part) => {
      const m = /(?<!\d):|:(?!\d)/.exec(part);
      return m && m.index > 0 ? part.slice(0, m.index).trim() : null;
    })
    .filter((k): k is string => !!k);
}

const mask = (v: string) => (FULL ? v : v.length <= 12 ? '*'.repeat(v.length) : `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`);

async function main() {
  if (!FULL) console.log('(values masked — pass --full to print them in the clear)\n');

  for (const c of CASES) {
    const claim = await prisma.claim.findFirst({
      where: { vinNo: c.vin },
      include: {
        documents: { select: { id: true, fileName: true } },
        validationResults: {
          orderBy: { createdAt: 'desc' },
          select: { validatorKey: true, status: true, summary: true, details: true, createdAt: true },
        },
      },
    });

    console.log('='.repeat(78));
    console.log(`S.No ${c.sno}  VIN ${c.vin}`);
    console.log(`  reported: ${c.asks}`);
    if (!claim) {
      console.log('  NOT FOUND in this database — nothing stored for this VIN.\n');
      continue;
    }
    console.log(`  claim ${claim.claimId}  scheme=${claim.schemeType ?? '-'}  docs=${claim.documents.length}`);
    if (claim.validationResults.length === 0) {
      console.log('  never validated — run the claim through validation, then re-run this.\n');
      continue;
    }

    // Most recent result per validator.
    const latest = new Map<string, (typeof claim.validationResults)[number]>();
    for (const r of claim.validationResults) if (!latest.has(r.validatorKey)) latest.set(r.validatorKey, r);

    // --- page counts, from META ---
    const meta = latest.get('META');
    const extracted = (meta?.details as { extracted?: { fileName: string; properties?: Record<string, string> }[] } | null)?.extracted ?? [];
    if (extracted.length === 0) {
      console.log('  PAGES: META stored no extracted documents.');
    } else {
      for (const e of extracted) {
        const pages = e.properties?.Pages;
        console.log(`  PAGES: ${e.fileName} → ${pages ?? 'not recorded (image, or pdfjs could not read the info dict)'}`);
      }
    }

    // --- QR payloads ---
    const qr = latest.get('QR');
    console.log(`  QR check: ${qr?.status ?? '-'} — ${qr?.summary ?? '-'}`);
    const d = qr?.details as {
      decoded?: { fileName: string; value: string; page?: number }[];
      comparisons?: { label: string; verdict: string }[];
    } | null;
    const decoded = d?.decoded ?? [];
    if (decoded.length === 0) {
      console.log('  QR: nothing decoded.');
    } else {
      for (const q of decoded) {
        console.log(`  QR: ${q.fileName}${q.page !== undefined ? ` p.${q.page}` : ''}`);
        console.log(`      shape : ${shapeOf(q.value)}`);
        const keys = keysOf(q.value);
        console.log(`      keys  : ${keys.length ? keys.join(', ') : '(none — parseQrPayload yields an empty map, so no field rows can render)'}`);
        console.log(`      value : ${mask(q.value)}`);
      }
    }
    const cmp = d?.comparisons ?? [];
    console.log(`  QR field rows rendered: ${cmp.length}${cmp.length === 0 ? '  ← nothing for the reviewer to see' : ''}`);
    console.log();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
