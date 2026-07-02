/** A normalized ([0..1], top-left origin) bounding box. */
export interface BBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One piece of validation evidence, as returned by GET /claims/:id/validation. */
export interface Finding {
  id: string;
  documentId: string | null;
  code: string;
  severity: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  page: number | null;
  bbox: BBox | null;
}
