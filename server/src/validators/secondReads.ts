import { PageImage } from '../lib/pdfExtractor.js';
import { PdfRegion } from './types.js';
import { classifyPage } from './segment.js';
import { extractIdentifiers, IdentifierField } from './dupIdentifiers.js';
import { idNorm, classifyDocType } from './crossDocLogic.js';
import { editDistanceCapped } from './logic.js';

/** Logos and stamps cover less than this share of the page; the target pictures cover more. */
const IMAGE_CHECK_MIN_COVER = 0.15;
const MAX_IMAGE_CHECK_PAGES = 6;
/** Strict: a picture at least this wide in pixels already OCRs well at the normal scale. */
const SMALL_PICTURE_MAX_PX = 800;
const SMALL_PICTURE_MIN_COVER = 0.1;
const MAX_UPSCALE_PAGES = 8;
/** MIN_OCR_IMAGE_WIDTH in lib/ocr.ts: the width OCR wants a picture rendered at. */
const TARGET_PX = 1600;
const MAX_CERT_RESCALE_PAGES = 2;
/** Row 9 of the corpus: scales 2 and 3 misread a digit of the number, 4 and 6 read it. */
const CERT_RESCALE_SCALE = 4;
const FULL_PAGE = { x: 0, y: 0, w: 1, h: 1 };
const CIVIL_CERT_TITLE =
  /\b(?:birth|death|marriage)\b[\s\S]{0,80}?\b(?:certificate|registration)\b|registration\s+of\s+(?:births|marriages)/i;
const CERT_WORDS = /certificate|place\s+of\s+birth|date\s+of\s+registration/i;

const cover = (img?: PageImage): number => (img?.box ? img.box.w * img.box.h : 0);
const isSmallPicture = (img: PageImage): boolean =>
  Math.max(img.width, img.height) < SMALL_PICTURE_MAX_PX && cover(img) >= SMALL_PICTURE_MIN_COVER;

/** Text-layer ID or certificate pages whose picture is worth its own OCR read, at most `max`. */
export function pickImageCheckPages(
  layerPageTexts: string[],
  textlessPages: number[],
  images: Map<number, PageImage>,
  max = MAX_IMAGE_CHECK_PAGES
): number[] {
  const out: number[] = [];
  layerPageTexts.forEach((text, i) => {
    const page = i + 1;
    if (out.length >= max || textlessPages.includes(page) || !text.trim()) return;
    if (!classifyPage(text) && !CERT_WORDS.test(text)) return;
    if (cover(images.get(page)) >= IMAGE_CHECK_MIN_COVER) out.push(page);
  });
  return out;
}

/** Render scale that brings a picture drawn `drawnWidthPt` wide up to TARGET_PX, within 2..6. */
export function upscaleScale(drawnWidthPt: number): number {
  return Math.min(6, Math.max(2, TARGET_PX / drawnWidthPt));
}

/** Scanned pages whose only picture is small: crop it and read it again, larger. */
export function pickUpscaleRegions(textlessPages: number[], images: Map<number, PageImage>): PdfRegion[] {
  const out: PdfRegion[] = [];
  for (const page of textlessPages) {
    const img = images.get(page);
    if (out.length >= MAX_UPSCALE_PAGES) break;
    if (!img?.box || !img.drawnWidthPt || !isSmallPicture(img)) continue;
    out.push({ page, box: img.box, scale: upscaleScale(img.drawnWidthPt) });
  }
  return out;
}

/** Small-picture pages a second read is meant for, caps aside: every scanned one (a crop read)
 *  and each text-layer one a picture read checks. A certificate re-read skips small pictures. */
export function smallPicturePages(
  layerPageTexts: string[],
  textlessPages: number[],
  images: Map<number, PageImage>
): number[] {
  return [...pickImageCheckPages(layerPageTexts, textlessPages, images, Infinity), ...textlessPages].filter((p) => {
    const img = images.get(p);
    return !!img && isSmallPicture(img);
  });
}

/** OCR'd pages that name a civil certificate but gave no CERT_REG_NO, in page order, capped. */
export function pickCertRescalePages(
  ocrPages: { page: number; text: string }[],
  images: Map<number, PageImage>
): number[] {
  const out: number[] = [];
  for (const { page, text } of ocrPages) {
    if (out.length >= MAX_CERT_RESCALE_PAGES) break;
    if (!text || !CIVIL_CERT_TITLE.test(text)) continue;
    if (extractIdentifiers(text).some((i) => i.field === 'CERT_REG_NO')) continue;
    const img = images.get(page);
    if (img && isSmallPicture(img)) continue;
    out.push(page);
  }
  return out;
}

/** The full-page region of a certificate re-read. */
export const certRescaleRegion = (page: number): PdfRegion => ({ page, box: FULL_PAGE, scale: CERT_RESCALE_SCALE });

/** Numbers a page prints once. Policy and account numbers are left out: a page legitimately prints several.
 *  Also the only fields DUP takes from a second read: they are checksummed or pattern-bound. */
export const LAYER_COMPARE_FIELDS: IdentifierField[] = [
  'PAN', 'AADHAAR', 'GSTIN', 'DL_NO', 'PASSPORT_NO', 'VOTER_ID', 'CERT_REG_NO', 'RATION_CARD_NO',
];

export interface LayerImageMismatch {
  field: IdentifierField;
  image: string;
  layer: string;
}

/** Same number, allowing a partial read of a long one and a couple of OCR slips. */
function close(a: string, b: string): boolean {
  const x = idNorm(a);
  const y = idNorm(b);
  return x.includes(y) || y.includes(x) || editDistanceCapped(x, y, 2) <= 2;
}

/**
 * ID numbers that read one way in a page's picture and another in its text layer.
 * A number only one side has is not a mismatch (that is DUP's concern, or an unreadable picture).
 */
export function layerImageMismatches(layerText: string, imageText: string): LayerImageMismatch[] {
  const layer = extractIdentifiers(layerText);
  const image = extractIdentifiers(imageText);
  const out: LayerImageMismatch[] = [];
  for (const field of LAYER_COMPARE_FIELDS) {
    const l = layer.filter((i) => i.field === field).map((i) => i.value);
    const im = image.filter((i) => i.field === field).map((i) => i.value);
    const shown = im.find((v) => !l.some((w) => close(v, w)));
    const stored = l.find((w) => !im.some((v) => close(v, w)));
    if (shown && stored) out.push({ field, image: shown, layer: stored });
  }
  return out;
}

/** Issuer words a government ID prints. */
const ID_ISSUER = /government of india|income tax|aadhaa?r|uidai|election commission|driving licen[cs]e|republic of india/i;

/**
 * True when a small ID picture yielded no ID number in any read of its page.
 * `texts` is the page text plus every second read of that page.
 * Some read must show the page is an ID: a government-ID class, a KYC page, or an issuer phrase on
 * an unrecognised page. A small photo on a letter or form is no ID (QA: 69 of 118 flags), and every
 * other type (RC, insurance, invoice, staff ID, payslip, DMS) carries no identifier by design.
 */
export function smallPictureUnread(img: PageImage, texts: string[]): boolean {
  if (!isSmallPicture(img)) return false;
  const joined = texts.join('\n');
  if (extractIdentifiers(joined).some((i) => i.field !== 'POLICY_NO')) return false;
  const type = classifyDocType(joined);
  const govt = classifyPage(joined);
  // A policy reads as GST from its insurer's GSTIN label (corpus row 7 p5).
  if (govt && !(govt === 'GST' && type === 'INSURANCE')) return true;
  return type === 'KYC' || (type === null && ID_ISSUER.test(joined));
}
