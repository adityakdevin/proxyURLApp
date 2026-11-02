import { PrismaClient } from '@prisma/client';
import { BBox } from '../lib/bbox.js';
import type { PageImage } from '../lib/pdfExtractor.js';

export type ValidatorKey = 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL' | 'REDFLAG' | 'DUP' | 'COMPARE';
export type ClaimColumn =
  | 'metaExtractionStatus'
  | 'spellCheckStatus'
  | 'qrStatus'
  | 'intraClaimStatus'
  | 'duplicateStatus'
  | 'fullScanStatus'
  | 'redFlagStatus'
  | 'dataCompareStatus';

/** A normalized ([0..1], top-left origin) bounding box for a recognized word. */
export interface WordBox {
  text: string;
  page: number; // 1-based (1 for single images)
  bbox: BBox;
  conf?: number;
}

/** One box of one PDF page to OCR, with the scale to render that page at. */
export interface PdfRegion { page: number; box: BBox; scale: number }

/** An extra OCR read of one page. IMAGE: the picture of a page that has a text layer.
 *  UPSCALE: a small picture on a scanned page, cropped and upscaled.
 *  RESCALE: a scanned civil certificate with no registration number parsed, read again at scale 4. */
export interface SecondRead { page: number; text: string; kind: 'IMAGE' | 'UPSCALE' | 'RESCALE' }

export interface OcrPort {
  /** Extract text from an image file. Returns '' on failure. */
  extractImageText(absolutePath: string): Promise<string>;
  /**
   * Image OCR returning both text and per-word normalized boxes. Optional — when
   * absent (e.g. test mocks) callers fall back to extractImageText (text only).
   */
  extractImage?(absolutePath: string): Promise<{ text: string; words: WordBox[] }>;
  /**
   * OCR a scanned (image-only) PDF by rasterizing its pages. Optional — when absent,
   * a PDF with no text layer yields no text. Returns text + per-word normalized boxes.
   * `opts.deadline` is on activeNow()'s clock (lib/pdfExtractor.ts): set it from
   * performance.now(), never Date.now().
   */
  extractPdf?(
    absolutePath: string,
    onlyPages?: number[],
    opts?: { deadline?: number }
  ): Promise<{
    text: string;
    words: WordBox[];
    /** Per-page text with its LINE BREAKS intact, keyed by 1-based page. Rebuilding page
     *  text by space-joining word boxes loses them, and the ID-card extractors depend on
     *  them: a PAN card's holder name is identified as the line above the father label,
     *  and an Aadhaar's as the line above its date of birth. */
    pages?: { page: number; text: string }[];
    /** Pages in the source PDF, so the caller can report a scan the page cap truncated. */
    totalPages?: number;
    /** 1-based pages whose first look did not finish before the deadline. Absent only when the
     *  read failed as a whole: META then counts every page it asked for as unread. */
    unreadPages?: number[];
  }>;
  /** Release any underlying resources (e.g. a reused OCR worker). Optional. */
  close?(): Promise<void>;
  /** OCR one box of each listed page, rendering only that box at the region's scale (its long
   *  side capped). Results by region index; null = not started before the deadline (on the
   *  same clock as extractPdf's).
   *  A region that fails reads ''. */
  extractPdfRegions?(absolutePath: string, regions: PdfRegion[], opts?: { deadline?: number }): Promise<(string | null)[]>;
}

export interface ValidatorDoc {
  id: string;
  fileName: string;
  storagePath: string;
  readablePath: string; // resolved absolute path (scan-root remap applied for SCANNED)
  mimeType: string | null;
  source: 'SCANNED' | 'UPLOADED';
  documentTypeId: string | null;
}

export interface ValidatorContext {
  claim: {
    id: string;
    claimId: string;
    subCategoryId: string;
    /** Customer name from the DMS upload (the observation sheet), if imported. */
    customerName?: string | null;
    /** Invoice date from the DMS upload (the observation sheet), if imported. */
    invoiceDate?: Date | null;
  };
  documents: ValidatorDoc[];
  prisma: PrismaClient;
  ocr: OcrPort;
  shared: Map<string, string>; // documentId → extracted text (META fills; SPELL/INTRA read)
  /** documentId → per-word boxes (META fills for images; SPELL/INTRA read to anchor highlights). */
  wordBoxes: Map<string, WordBox[]>;
  /** documentId → per-page text (META fills; segment/REDFLAG read for page-scoped classification+rules). */
  pageTexts: Map<string, string[]>;
  /** documentId → pages read vs pages in the file, for a PDF the page cap cut short (META
   *  fills; FULL reports it, since META itself is hidden from reviewers). */
  truncatedPages?: Map<string, { scanned: number; total: number }>;
  /** documentId to 1-based pages OCR did not finish reading before its deadline, or 'all' when the
   *  whole document timed out unread (META fills; FULL reports it as a red flag). */
  unreadPages?: Map<string, number[] | 'all'>;
  /** documentId -> 1-based pages whose text is wholly the PDF's own text layer (META did not
   *  OCR them). A number read there is exact, not an OCR guess, when the layer is visible. */
  textLayerPages?: Map<string, Set<number>>;
  /** documentId -> page -> its widest picture (META fills, PDFs only; REDFLAG reads). */
  pageImages?: Map<string, Map<number, PageImage>>;
  /** documentId -> extra OCR reads, kept out of shared/pageTexts (META fills; DUP, REDFLAG read). */
  secondReads?: Map<string, SecondRead[]>;
  /** documentId -> 1-based small-picture pages whose second read a cap or the deadline skipped
   *  (META fills; REDFLAG leaves them out of the small-picture flag, which claims a sharper read). */
  secondReadsSkipped?: Map<string, number[]>;
}

/**
 * A single piece of evidence for a check, attributed to a Document when possible.
 * page/bbox are reserved for the coordinate-capture phases and stay undefined for now.
 */
export interface FindingInput {
  documentId?: string | null;
  code: string;
  severity?: 'INFO' | 'WARNING' | 'ERROR';
  message: string;
  page?: number | null;
  bbox?: BBox | null;
  data?: Record<string, unknown>;
}

/** What lands in the claim's status column. Validators decide PASSED/FAILED; DOUBTFUL is
 *  now written only for a check that did not run (see validationService). */
export type CheckStatus = 'PASSED' | 'FAILED' | 'DOUBTFUL';

export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;
  findings?: FindingInput[];
  /** Extra Claim columns this validator owns, written in the same transaction as its
   *  status. Keeps check-specific knowledge (e.g. QR's bifurcated outcome) inside the
   *  validator instead of teaching the service what each key means. */
  claimFields?: Record<string, string | null>;
}

export interface Validator {
  key: ValidatorKey;
  column: ClaimColumn;
  run(ctx: ValidatorContext): Promise<ValidatorOutcome>;
}
