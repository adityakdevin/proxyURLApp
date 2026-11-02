import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import fsSync from 'fs';
import { STATUS_CODES } from 'http';
import path from 'path';
import { param } from 'express-validator';
import { ClaimService } from '../services/claimService.js';
import { DocumentService } from '../services/documentService.js';
import { FsFileSystemPort } from '../services/fsFileSystemPort.js';
import { claimUploadDir } from '../lib/uploadPaths.js';
import { isInline, isAllowedUploadName } from '../lib/mimeTypes.js';
import { enqueue } from '../services/validationQueue.js';
import { registry } from '../validators/registry.js';
import { validate, prismaOf, pickChecks } from '../lib/routeHelpers.js';

// mergeParams so :id from the parent /claims/:id mount is available here.
const router = Router({ mergeParams: true });

const claimSvc = (req: Request) => new ClaimService(prismaOf(req));
const docSvc = (req: Request) => new DocumentService(prismaOf(req), new FsFileSystemPort());

/** Fire-and-forget auto-validation; log (never crash) on a queue error. */
const enqueueValidation = (req: Request, claimId: string, checks?: string[]) => {
  void enqueue(prismaOf(req), registry, claimId, 'AUTO', req.session!.userId, checks).catch((e) =>
    console.error(`Auto-validation enqueue failed for claim ${claimId}:`, e)
  );
};

// View-scope gate: caller must be able to see the claim.
const requireView = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const claim = await claimSvc(req).getById(req.params.id, req.session!.userId, req.session!.role);
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    next();
  } catch (err) {
    next(err);
  }
};

// Edit gate for mutations.
const requireEdit = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const ok = await claimSvc(req).canEditClaim(
      req.params.id,
      req.session!.userId,
      req.session!.role
    );
    if (!ok) {
      return res.status(403).json({ error: 'Cannot edit this claim', code: 'CLAIM_NOT_EDITABLE' });
    }
    next();
  } catch (err) {
    next(err);
  }
};

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_UPLOAD_FILES = 50;
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, _file, cb) => {
      const dir = claimUploadDir(req.params.id);
      fsSync.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (_req, file, cb) => cb(null, `${Date.now()}-${path.basename(file.originalname)}`),
  }),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: MAX_UPLOAD_FILES },
  // Allowlist by extension at ingress (mimetype is spoofable) so unexpected
  // files are never written to disk.
  fileFilter: (_req, file, cb) => {
    if (isAllowedUploadName(file.originalname)) cb(null, true);
    else cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

// Wrap multer so a rejected file/size/count limit returns a clean typed response.
const handleUpload = (req: Request, res: Response, next: NextFunction) => {
  upload.array('files', MAX_UPLOAD_FILES)(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof Error && err.message === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(415).json({ error: 'Unsupported file type', code: 'UNSUPPORTED_FILE_TYPE' });
    }
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res.status(tooBig ? 413 : 400).json({
        error: err.message,
        code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR',
      });
    }
    return next(err);
  });
};

router.get('/', [param('id').isUUID()], validate, requireView, async (req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ data: await docSvc(req).list(req.params.id) });
  } catch (err) {
    next(err);
  }
});

router.post(
  '/',
  [param('id').isUUID()],
  validate,
  requireEdit,
  handleUpload,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
      if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      const files = (req.files as Express.Multer.File[]) || [];
      if (files.length === 0) {
        return res.status(400).json({ error: 'No files provided', code: 'NO_FILES' });
      }
      const svc = docSvc(req);
      const created: Awaited<ReturnType<typeof svc.registerUpload>>[] = [];
      for (const f of files) {
        created.push(
          await svc.registerUpload(
            claim.id,
            claim.subCategoryId,
            { originalName: f.originalname, storedPath: f.path, sizeBytes: f.size },
            req.session!.userId
          )
        );
      }
      // A multipart field, so the tick-boxes travel with the files they belong to.
      enqueueValidation(req, claim.id, pickChecks(req.body?.checks));
      res.status(201).json({ data: created });
    } catch (err) {
      next(err);
    }
  }
);

router.post('/sync', [param('id').isUUID()], validate, requireEdit, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const prisma = prismaOf(req);
    const claim = await prisma.claim.findUnique({ where: { id: req.params.id } });
    if (!claim) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
    const result = await docSvc(req).discoverForClaim(claim, req.session!.userId);
    enqueueValidation(req, claim.id);
    res.json({ data: result });
  } catch (err) {
    next(err);
  }
});

router.get(
  '/:docId/content',
  [param('id').isUUID(), param('docId').isUUID()],
  validate,
  requireView,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const doc = await prisma.document.findFirst({
        where: { id: req.params.docId, claimId: req.params.id },
      });
      if (!doc) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      const resolved = await docSvc(req).resolveServingPath(doc.id);
      // Log the path we actually tried: a claim can hold a valid RESULT from an earlier
      // run while the file itself has since moved on the scan share, and without this the
      // 404 is undiagnosable from the server logs.
      if (!resolved) {
        console.warn(
          `[documents] ${doc.id} (${doc.source}) path rejected: storagePath=${JSON.stringify(doc.storagePath)} CLAIMS_SCAN_ROOT=${process.env.CLAIMS_SCAN_ROOT ?? '<unset>'}`
        );
        return res.status(404).json({ error: 'File not found', code: 'FILE_NOT_FOUND' });
      }
      res.setHeader('Content-Type', resolved.mimeType);
      res.setHeader(
        'Content-Disposition',
        `${isInline(resolved.mimeType) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(resolved.fileName)}"`
      );
      // Revalidate on every view: a scan can be replaced in place on the share.
      res.setHeader('Cache-Control', 'private, no-cache');
      // send (under sendFile) stats the file, streams only the stat's length (a scan still being
      // written can grow after the stat), and closes the file when the client hangs up, which
      // stepping through claims in the viewer does constantly.
      res.sendFile(
        resolved.absolutePath,
        // Scan-share paths can hold dot segments, which the default 'ignore' answers 404.
        // No ranges or cache lifetime. Express sets the ETag from the app's 'etag' setting
        // (a per-call etag option is ignored), so a revisit may revalidate to a 304.
        { dotfiles: 'allow', acceptRanges: false, cacheControl: false, lastModified: false },
        (e?: NodeJS.ErrnoException & { status?: number }) => {
          if (!e || e.code === 'ECONNABORTED') return;
          // The file can vanish, or the scan share drop, before or during the read.
          console.warn(
            `[documents] ${doc.id} read failed for ${JSON.stringify(resolved.absolutePath)}: ${JSON.stringify(e.message)}`
          );
          if (res.headersSent) return res.destroy(e);
          // Drop the file's headers. send sets the ETag and Content-Length from the stat before it
          // opens the file; a kept ETag let the browser cache this error and revalidate it to a
          // 304 once the file was readable again.
          res.removeHeader('Content-Disposition');
          res.removeHeader('ETag');
          res.setHeader('Cache-Control', 'no-store');
          // send gives a missing file 404, a failed precondition 412 and any other read error
          // (a sharing lock, an ACL) 500; a directory arrives with no status.
          const status = e.status ?? 404;
          const body =
            status === 404
              ? { error: 'File not found', code: 'FILE_NOT_FOUND' }
              : // Not e.message: send's read errors carry the file's path.
                { error: STATUS_CODES[status] ?? 'Error', code: 'FILE_READ_FAILED' };
          const json = JSON.stringify(body);
          // Not res.json: it would give the error an ETag of its own (the app's 'etag' setting).
          // Sized here, as res.json would: the file's Content-Length would leave the client
          // waiting for the file's bytes or, for a file shorter than the JSON, desync the socket.
          res.status(status).type('json').setHeader('Content-Length', Buffer.byteLength(json));
          res.end(json);
        }
      );
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:docId',
  [param('id').isUUID(), param('docId').isUUID()],
  validate,
  requireEdit,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const doc = await prisma.document.findFirst({
        where: { id: req.params.docId, claimId: req.params.id },
      });
      if (!doc) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      await docSvc(req).delete(doc.id);
      // Removing a doc changes the validatable set — re-run so columns aren't stale.
      enqueueValidation(req, req.params.id);
      res.json({ message: 'Deleted' });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
