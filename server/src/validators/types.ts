import { PrismaClient } from '@prisma/client';
import { BBox } from '../lib/bbox.js';

export type ValidatorKey = 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL' | 'REDFLAG';
export type ClaimColumn =
  | 'metaExtractionStatus'
  | 'spellCheckStatus'
  | 'qrStatus'
  | 'intraClaimStatus'
  | 'fullScanStatus'
  | 'redFlagStatus';

/** A normalized ([0..1], top-left origin) bounding box for a recognized word. */
export interface WordBox {
  text: string;
  page: number; // 1-based (1 for single images)
  bbox: BBox;
  conf?: number;
}

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
   */
  extractPdf?(
    absolutePath: string,
    onlyPages?: number[]
  ): Promise<{
    text: string;
    words: WordBox[];
    /** Per-page text with its LINE BREAKS intact, keyed by 1-based page. Rebuilding page
     *  text by space-joining word boxes loses them, and the ID-card extractors depend on
     *  them: a PAN card's holder name is identified as the line above the father label,
     *  and an Aadhaar's as the line above its date of birth. */
    pages?: { page: number; text: string }[];
  }>;
  /** Release any underlying resources (e.g. a reused OCR worker). Optional. */
  close?(): Promise<void>;
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
  claim: { id: string; claimId: string; subCategoryId: string };
  documents: ValidatorDoc[];
  prisma: PrismaClient;
  ocr: OcrPort;
  shared: Map<string, string>; // documentId → extracted text (META fills; SPELL/INTRA read)
  /** documentId → per-word boxes (META fills for images; SPELL/INTRA read to anchor highlights). */
  wordBoxes: Map<string, WordBox[]>;
  /** documentId → per-page text (META fills; segment/REDFLAG read for page-scoped classification+rules). */
  pageTexts: Map<string, string[]>;
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

export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;
  findings?: FindingInput[];
}

export interface Validator {
  key: ValidatorKey;
  column: ClaimColumn;
  run(ctx: ValidatorContext): Promise<ValidatorOutcome>;
}
