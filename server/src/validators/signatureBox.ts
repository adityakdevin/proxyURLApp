import { BBox, rotateBox, unrotateBox } from '../lib/bbox.js';
import { WordBox } from './types.js';
import { checkPan, PAN_FATHER_LABEL } from './redFlagLogic.js';
import { editDistanceCapped } from './logic.js';

/** Ink share at or under which a signature box counts as blank. */
export const BLANK_INK_MAX = 0.005;
/** A pixel is ink only below this share of the area's own paper brightness... */
export const INK_DARK_RATIO = 0.55;
/** ...and below this share of its neighbourhood mean (drops a broad tinted ground). */
export const STROKE_RATIO = 0.7;

export type QuarterTurn = 0 | 90 | 180 | 270;
/** `bbox` is in normalized page coordinates as stored; `turn` is the frame it was found in. */
export interface SignatureArea { design: 'current' | 'older'; turn: QuarterTurn; bbox: BBox }

const TURNS: QuarterTurn[] = [0, 90, 180, 270];
const norm = (t: string): string => t.replace(/[^A-Za-z]/g, '').toLowerCase();
const sideways = (b: BBox): boolean => b.h > b.w;
/** After "Signature": an e-PAN widget ("Signature Not Verified", "valid Digitally signed") or a
 *  form's "Signature of ...". One letter off for OCR; "of" exact, as two letters match too much. */
const WIDGET_WORDS = ['not', 'verified', 'valid', 'digitally', 'signed'];
const notACardLabel = (t: string): boolean => t === 'of' || WIDGET_WORDS.some((n) => editDistanceCapped(t, n, 1) <= 1);

/** The quarter turn at which these words read left to right; 0 when nothing reads. */
export function readingTurn(words: WordBox[]): QuarterTurn {
  let best: QuarterTurn = 0;
  let bestCount = 0;
  for (const turn of TURNS) {
    const boxes = words.map((w) => rotateBox(w.bbox, turn));
    let count = 0;
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1];
      const b = boxes[i];
      if (sideways(a) || sideways(b)) continue;
      const dy = Math.abs(a.y + a.h / 2 - (b.y + b.h / 2));
      if (dy < Math.max(a.h, b.h) / 2 && b.x > a.x + a.w / 2) count++;
    }
    if (count > bestCount) {
      best = turn;
      bestCount = count;
    }
  }
  return best;
}

/** Where the customer signs, from the page's word boxes; null when no usable anchor. */
export function signatureArea(words: WordBox[], page: number): SignatureArea | null {
  const onPage = words.filter((w) => w.page === page);
  const turn = readingTurn(onPage);
  const ws = onPage.map((w) => ({ t: norm(w.text), b: rotateBox(w.bbox, turn) }));
  // A label near the top of a page whose other words are below it is another document's.
  const upright = (b: BBox): boolean => !sideways(b) && ws.filter((w) => w.b.y < b.y).length > ws.length / 2;
  const done = (design: SignatureArea['design'], bbox: BBox): SignatureArea => ({
    design,
    turn,
    bbox: unrotateBox(bbox, turn),
  });

  // Only inside the card's "Valid unless physically signed": a prose "unless" is not an anchor.
  const next = (i: number): string | undefined => ws[i + 1]?.t;
  const unless = ws.find(
    (w, i) => w.t === 'unless' && (ws[i - 1]?.t === 'valid' || next(i) === 'physically') && upright(w.b)
  );
  const physically = unless
    ? undefined
    : ws.find((w, i) => w.t === 'physically' && next(i) === 'signed' && upright(w.b));
  const cur = unless ?? physically;
  if (cur) {
    const U = unless ? cur.b.w : cur.b.w / 1.62;
    const left = unless ? cur.b.x - 0.9 * U : cur.b.x - 2.1 * U;
    return done('current', { x: left - 9 * U, y: cur.b.y - 0.75 * U, w: 6.7 * U, h: 1.25 * U });
  }

  // The first label only: when it fails the guard, a later one is another document's.
  const i = ws.findIndex(
    (w, j) => w.t === 'signature' && !ws.slice(j + 1, j + 4).some((n) => notACardLabel(n.t))
  );
  if (i < 0 || !upright(ws[i].b)) return null;
  const { x, y, w: S } = ws[i].b;
  return done('older', { x: x - 1.5 * S, y: y - S, w: 3.5 * S, h: 0.93 * S });
}

/** Share of the area's pixels that are ink: darker than INK_DARK_RATIO x the area's
 *  90th-percentile brightness and than STROKE_RATIO x their neighbourhood mean.
 *  `luma` is one byte per pixel, row-major. Null when the area clips to under 10x5 px. */
export function inkFraction(luma: Uint8Array, width: number, height: number, area: BBox): number | null {
  const x0 = Math.max(0, Math.round(area.x * width));
  const y0 = Math.max(0, Math.round(area.y * height));
  const x1 = Math.min(width, Math.round((area.x + area.w) * width));
  const y1 = Math.min(height, Math.round((area.y + area.h) * height));
  const aw = x1 - x0;
  const ah = y1 - y0;
  if (aw < 10 || ah < 5) return null;

  const hist = new Array<number>(256).fill(0);
  const stride = aw + 1;
  const sum = new Float64Array(stride * (ah + 1)); // integral image of the area
  for (let y = 0; y < ah; y++) {
    let row = 0;
    for (let x = 0; x < aw; x++) {
      const v = luma[(y0 + y) * width + x0 + x];
      hist[v]++;
      row += v;
      sum[(y + 1) * stride + x + 1] = sum[y * stride + x + 1] + row;
    }
  }
  const n = aw * ah;
  let acc = 0;
  let bg = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= 0.9 * n) {
      bg = v;
      break;
    }
  }

  const r = Math.max(2, Math.round(Math.min(aw, ah) / 8));
  const dark = bg * INK_DARK_RATIO;
  let ink = 0;
  for (let y = 0; y < ah; y++) {
    const ya = Math.max(0, y - r);
    const yb = Math.min(ah, y + r + 1);
    for (let x = 0; x < aw; x++) {
      const v = luma[(y0 + y) * width + x0 + x];
      if (v >= dark) continue;
      const xa = Math.max(0, x - r);
      const xb = Math.min(aw, x + r + 1);
      const total = sum[yb * stride + xb] - sum[ya * stride + xb] - sum[yb * stride + xa] + sum[ya * stride + xa];
      if (v < (STROKE_RATIO * total) / ((xb - xa) * (yb - ya))) ink++;
    }
  }
  return ink / n;
}

/** False only for a card that should carry no signature: its PAN reads with a holder
 *  other than Individual AND the page prints no "Father's Name" label (decision 3). */
export function signatureExpected(text: string, page: number | null): boolean {
  // A father's name makes it an individual's card whatever the 4th letter says; checkPan then
  // reports a holder-type flag instead of a category, so the label test must stand on its own.
  if (PAN_FATHER_LABEL.test(text)) return true;
  const category = checkPan(text, page).find((f) => f.code === 'REDFLAG_PAN_OK')?.data?.category;
  return category === undefined || category === 'Individual';
}
