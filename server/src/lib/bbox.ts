/** A normalized ([0..1], top-left origin) bounding box. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Clamp a number into the [0, 1] range. */
export const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));
