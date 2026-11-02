/** A normalized ([0..1], top-left origin) bounding box. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clamp a number into the [0, 1] range. */
export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

/**
 * The smallest box containing all of `boxes`, or null for an empty list.
 *
 * A printed identifier rarely lands in one word box: OCR splits "9150 6457 2260 8544" into
 * four, and a highlight drawn around only the first of them points at a quarter of the
 * number the reviewer is being asked to check.
 */
export function unionBBox(boxes: BBox[]): BBox | null {
  if (boxes.length === 0) return null;
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.w));
  const bottom = Math.max(...boxes.map((b) => b.y + b.h));
  return { x, y, w: right - x, h: bottom - y };
}

/**
 * Map a normalized box from an image rotated counter-clockwise by `deg` back onto the page
 * as the reviewer sees it. Without this, a card read at 270° highlights the wrong region —
 * the box would be drawn in the rotated frame nobody is looking at.
 */
export function unrotateBox(b: BBox, deg: number): BBox {
  const { x, y, w, h } = b;
  if (deg === 90) return { x: 1 - y - h, y: x, w: h, h: w };
  if (deg === 180) return { x: 1 - x - w, y: 1 - y - h, w, h };
  if (deg === 270) return { x: y, y: 1 - x - w, w: h, h: w };
  return b;
}

/** The inverse: where a page box sits on the page turned counter-clockwise by `deg`. */
export function rotateBox(b: BBox, deg: number): BBox {
  return unrotateBox(b, (360 - deg) % 360);
}
