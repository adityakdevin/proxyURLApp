/**
 * Show what the QR decoder actually sees.
 *
 * Reviewers report "QR is clearly there and the app says it found nothing". The viewer
 * renders the PDF with pdf.js in the BROWSER; the validator decodes a server-side raster of
 * the same page. Those are two different images, so a QR that looks perfect on screen tells
 * you nothing about what the decoder was handed. This dumps the decoder's own input.
 *
 * For each page it renders at the production scale, tries zxing (falling back to jsQR
 * exactly as the validator does), and writes the PNG to disk so the raster can be inspected
 * or fed to any other reader. A blank, tiny or rotated PNG explains a miss immediately; a
 * crisp one that still fails to decode is a decoder problem worth escalating.
 *
 * Read-only against the database. Writes PNGs only.
 *
 *   npm run qa:qr-debug --workspace=server -- MZBFE813MSN602919
 *   npm run qa:qr-debug --workspace=server -- MZBFE813MSN602919 --out C:\temp\qr
 *   npm run qa:qr-debug --workspace=server -- MZBFE813MSN602919 --pages 4,5
 */
import path from 'path';
import fs from 'fs/promises';
import dotenv from 'dotenv';

// Load server/.env explicitly — a repo-root .env is read by nothing. See CLAUDE.md.
dotenv.config({ path: path.join(__dirname, '..', '.env') });

import { PrismaClient } from '@prisma/client';
import { DocumentService } from '../src/services/documentService.js';
import { rasterizePdf } from '../src/lib/pdfExtractor.js';
import { decodeAll, isDecoderDegraded, resetDecoderDegraded } from '../src/validators/qrValidator.js';

const prisma = new PrismaClient();

/** Production values, mirrored from qrValidator: the cheap first pass and the retry. */
const SCALES = [3, 8];

/**
 * Rescues to try when a page that rendered fine still decodes nothing.
 *
 * Each is a plausible reason a photographed ID card defeats a binarizer: washed-out
 * contrast, a colour cast over the code, a light-on-dark print, or a card small enough in
 * frame that the modules land under a pixel. Whichever one succeeds names the fix; all of
 * them failing says preprocessing is not where the answer is.
 */
type Op = (img: { greyscale(): unknown; contrast(n: number): unknown; invert(): unknown; normalize(): unknown; scale(n: number): unknown }) => void;
const VARIANTS: [string, Op][] = [
  ['greyscale+contrast', (i) => { i.greyscale(); i.contrast(0.5); }],
  ['normalize', (i) => { i.normalize(); }],
  ['greyscale+normalize', (i) => { i.greyscale(); i.normalize(); }],
  ['invert', (i) => { i.invert(); }],
  ['upscale-x2', (i) => { i.scale(2); }],
];

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  // Drop values that belong to a flag rather than being the claim id.
  const flagValues = new Set([argValue('--out'), argValue('--pages')].filter(Boolean) as string[]);
  const claimIdArg = positional.find((a) => !flagValues.has(a));
  if (!claimIdArg) throw new Error('Pass a claim id, e.g. -- MZBFE813MSN602919');

  const outDir = argValue('--out') ?? path.join(__dirname, '..', '..', 'qr-debug');
  const onlyPages = argValue('--pages')
    ?.split(',')
    .map((n) => Number(n.trim()))
    .filter((n) => Number.isFinite(n));

  const claim = await prisma.claim.findFirst({
    where: { claimId: claimIdArg },
    select: { id: true, claimId: true },
  });
  if (!claim) throw new Error(`No claim with claimId "${claimIdArg}".`);

  const docs = await prisma.document.findMany({
    where: { claimId: claim.id },
    select: { id: true, fileName: true, mimeType: true },
  });
  if (docs.length === 0) throw new Error(`Claim ${claim.claimId} has no documents.`);

  await fs.mkdir(outDir, { recursive: true });
  console.log(`Claim ${claim.claimId}: ${docs.length} document(s). PNGs -> ${outDir}\n`);

  const svc = new DocumentService(prisma);
  for (const doc of docs) {
    const resolved = await svc.resolveServingPath(doc.id);
    if (!resolved) {
      console.log(`${doc.fileName}: FILE NOT FOUND on disk — nothing to decode.`);
      continue;
    }
    // resolveServingPath builds a path from the DB row; it does NOT check the file is
    // there (claimDocuments stats it separately). A document row can outlive its file on
    // the scan share, which is its own reported bug — say so rather than let it surface as
    // a mysterious rasterize failure.
    const stat = await fs.stat(resolved.absolutePath).catch(() => null);
    if (!stat) {
      console.log(`${doc.fileName}: NOT ON DISK at ${resolved.absolutePath}`);
      console.log('  The row exists, the file does not. Nothing can be decoded.\n');
      continue;
    }
    console.log(`${doc.fileName}: ${(stat.size / 1024).toFixed(0)} KB at ${resolved.absolutePath}`);

    if (resolved.mimeType !== 'application/pdf') {
      console.log(`${doc.fileName}: not a PDF (${resolved.mimeType}) — skipped.`);
      continue;
    }

    for (const scale of SCALES) {
      const pages = await rasterizePdf(resolved.absolutePath, 60, scale, onlyPages);
      if (pages.length === 0) {
        console.log(`${doc.fileName} @scale ${scale}: rasterizePdf returned NOTHING.`);
        console.log('  That alone explains a miss — the decoder never received an image.\n');
        continue;
      }
      console.log(`${doc.fileName} @scale ${scale}: ${pages.length} page(s)`);
      for (const p of pages) {
        resetDecoderDegraded();
        // Jimp is what the validator uses to get pixels; keep the same path.
        const { Jimp } = await import('jimp');
        const img = await Jimp.read(p.png);
        const { data, width, height } = img.bitmap;
        const hits = await decodeAll(new Uint8ClampedArray(data), width, height);
        const file = path.join(outDir, `${doc.fileName}.p${p.page}.s${scale}.png`);
        await fs.writeFile(file, p.png);
        const how = isDecoderDegraded() ? 'jsQR (zxing UNAVAILABLE)' : 'zxing';
        console.log(
          `  page ${String(p.page).padStart(2)}  ${String(width).padStart(5)}x${String(height).padEnd(5)}` +
            `  ${hits.length} QR via ${how}  -> ${path.basename(file)}`
        );
        for (const h of hits) {
          const v = h.value.length > 60 ? `${h.value.slice(0, 60)}…` : h.value;
          console.log(`            value: ${v}`);
        }

        // Nothing read from a page that renders fine is where the guessing usually starts.
        // Try the standard rescues instead and report which one works — a variant that
        // decodes is a concrete change to make in the validator, and all of them failing
        // is real evidence that preprocessing is not the answer.
        if (hits.length === 0) {
          for (const [name, apply] of VARIANTS) {
            try {
              const v = await Jimp.read(p.png);
              apply(v);
              const got = await decodeAll(
                new Uint8ClampedArray(v.bitmap.data),
                v.bitmap.width,
                v.bitmap.height
              );
              if (got.length > 0) {
                const out = path.join(outDir, `${doc.fileName}.p${p.page}.s${scale}.${name}.png`);
                await fs.writeFile(out, await v.getBuffer('image/png'));
                console.log(`      ${name}: ${got.length} QR  -> ${path.basename(out)}`);
                for (const h of got) {
                  const t = h.value.length > 60 ? `${h.value.slice(0, 60)}…` : h.value;
                  console.log(`            value: ${t}`);
                }
              } else {
                console.log(`      ${name}: 0`);
              }
            } catch (e) {
              console.log(`      ${name}: failed (${e instanceof Error ? e.message : e})`);
            }
          }
        }
      }
      console.log('');
    }
  }

  console.log('Open the PNGs. If a page the reviewer says has a QR renders blank, tiny or');
  console.log('rotated, that is the bug. If it renders crisply and still decodes 0, the');
  console.log('decoder is the bug and the PNG is the reproduction to escalate with.');
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
