import { PrismaClient } from '@prisma/client';
import { FileSystemPort } from '../lib/fileSystemPort.js';

export type ValidatorKey = 'META' | 'SPELL' | 'QR' | 'INTRA' | 'FULL';
export type ClaimColumn =
  | 'metaExtractionStatus'
  | 'spellCheckStatus'
  | 'qrStatus'
  | 'intraClaimStatus'
  | 'fullScanStatus';

export interface OcrPort {
  /** Extract text from an image file. Returns '' on failure. */
  extractImageText(absolutePath: string): Promise<string>;
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
  fsPort: FileSystemPort;
  ocr: OcrPort;
  shared: Map<string, string>; // documentId → extracted text (META fills; SPELL/INTRA read)
}

export interface ValidatorOutcome {
  status: 'PASSED' | 'FAILED';
  summary: string;
  details?: unknown;
}

export interface Validator {
  key: ValidatorKey;
  column: ClaimColumn;
  run(ctx: ValidatorContext): Promise<ValidatorOutcome>;
}
