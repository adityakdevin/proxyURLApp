import { PrismaClient } from '@prisma/client';
import { promises as fs } from 'fs';
import path from 'path';
import { FileSystemPort } from '../lib/fileSystemPort.js';
import { resolveScanRoot } from '../lib/directoryReader.js';
import { classify } from './documentClassifier.js';
import { mimeTypeFor } from '../lib/mimeTypes.js';
import { uploadsRoot } from '../lib/uploadPaths.js';

export class DocumentService {
  constructor(private prisma: PrismaClient, private fsPort: FileSystemPort) {}

  private async docTypesFor(subCategoryId: string) {
    return this.prisma.documentTypeMaster.findMany({
      where: { subCategoryId, status: 'ACTIVE' },
      select: { id: true, name: true, category: true, govtCode: true, displayOrder: true },
    });
  }

  async discoverForClaim(
    claim: { id: string; folderPath: string | null; subCategoryId: string },
    actorId?: string
  ): Promise<{ created: number; skipped: number }> {
    if (!claim.folderPath || !claim.folderPath.trim()) return { created: 0, skipped: 0 };
    const readPath = resolveScanRoot(claim.folderPath);
    const st = await this.fsPort.stat(readPath);
    if (!st.exists) return { created: 0, skipped: 0 };

    let items: { fileName: string; storagePath: string; sizeBytes: number }[] = [];
    if (st.isDirectory) {
      const files = await this.fsPort.listFiles(readPath);
      items = files.map((f) => ({
        fileName: f.name,
        storagePath: path.win32.join(claim.folderPath as string, f.name),
        sizeBytes: f.sizeBytes,
      }));
    } else if (st.isFile) {
      items = [
        {
          fileName: path.win32.basename(claim.folderPath),
          storagePath: claim.folderPath,
          sizeBytes: st.sizeBytes,
        },
      ];
    }
    if (items.length === 0) return { created: 0, skipped: 0 };

    const docTypes = await this.docTypesFor(claim.subCategoryId);
    let created = 0;
    let skipped = 0;
    for (const it of items) {
      try {
        await this.prisma.document.create({
          data: {
            claimId: claim.id,
            documentTypeId: classify(it.fileName, docTypes),
            source: 'SCANNED',
            fileName: it.fileName,
            storagePath: it.storagePath,
            sizeBytes: it.sizeBytes,
            mimeType: mimeTypeFor(it.fileName),
            createdBy: actorId ?? null,
          },
        });
        created++;
      } catch (e) {
        if ((e as { code?: string }).code === 'P2002') skipped++;
        else throw e;
      }
    }
    return { created, skipped };
  }

  async registerUpload(
    claimId: string,
    subCategoryId: string,
    file: { originalName: string; storedPath: string; sizeBytes: number },
    actorId: string
  ) {
    const docTypes = await this.docTypesFor(subCategoryId);
    return this.prisma.document.create({
      data: {
        claimId,
        documentTypeId: classify(file.originalName, docTypes),
        source: 'UPLOADED',
        fileName: file.originalName,
        storagePath: file.storedPath,
        sizeBytes: file.sizeBytes,
        mimeType: mimeTypeFor(file.originalName),
        createdBy: actorId,
      },
      include: { documentType: { select: { id: true, name: true } } },
    });
  }

  async list(claimId: string) {
    return this.prisma.document.findMany({
      where: { claimId },
      include: { documentType: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Absolute path for an UPLOADED doc if it stays within its claim's upload dir,
   * else null. Shared by serving + delete so their policy can't drift apart.
   */
  private confinedUploadPath(doc: { storagePath: string; claimId: string }): string | null {
    const absolutePath = path.resolve(doc.storagePath);
    const root = path.resolve(uploadsRoot(), doc.claimId);
    if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return null;
    return absolutePath;
  }

  /** Resolve the absolute path to stream, or null if missing / out of its allowed root. */
  async resolveServingPath(
    docId: string
  ): Promise<{ absolutePath: string; fileName: string; mimeType: string } | null> {
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc) return null;
    let absolutePath: string;
    if (doc.source === 'UPLOADED') {
      const confined = this.confinedUploadPath(doc);
      if (!confined) return null;
      absolutePath = confined;
    } else {
      // Reject '..' in the stored path regardless of root config.
      if (doc.storagePath.split(/[\\/]/).includes('..')) return null;
      const remapped = resolveScanRoot(doc.storagePath);
      const override = process.env.CLAIMS_SCAN_ROOT;
      if (override) {
        absolutePath = path.resolve(remapped);
        const root = path.resolve(override);
        if (absolutePath !== root && !absolutePath.startsWith(root + path.sep)) return null;
      } else {
        // Production: serve the admin-configured Windows path as-is.
        absolutePath = remapped;
      }
    }
    return {
      absolutePath,
      fileName: doc.fileName,
      mimeType: doc.mimeType ?? 'application/octet-stream',
    };
  }

  async delete(docId: string): Promise<void> {
    const doc = await this.prisma.document.findUnique({ where: { id: docId } });
    if (!doc) return;
    // Unlink BEFORE deleting the row so a crash can't orphan a file whose record
    // is gone. ENOENT is fine; other errors keep the row (recoverable).
    if (doc.source === 'UPLOADED') {
      const confined = this.confinedUploadPath(doc);
      if (confined) {
        try {
          await fs.unlink(confined);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
            console.error(`Failed to unlink ${confined} for document ${docId}:`, e);
            throw e;
          }
        }
      }
    }
    await this.prisma.document.delete({ where: { id: docId } });
  }
}
