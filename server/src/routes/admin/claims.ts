import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { body, param, query } from 'express-validator';
import { ClaimService, ClaimServiceError } from '../../services/claimService.js';
import {
  parseObservationWorkbook,
  ObservationParseError,
} from '../../services/observationImportService.js';
import { buildObservationWorkbook } from '../../services/claimReportService.js';
import { validate, prismaOf, makeErrorHandler } from '../../lib/routeHelpers.js';

const router = Router();
const getService = (req: Request) => new ClaimService(prismaOf(req));
const handleErr = makeErrorHandler(ClaimServiceError, {
  NOT_FOUND: 404,
  SUBCATEGORY_NOT_FOUND: 404,
  OUT_OF_SCOPE: 403,
  NO_DEFAULT_STATUS: 409,
});

// Observation upload: a single .xlsx held in memory (we parse, never persist the
// file). The cap is deliberately small: a claims sheet is tiny, and a smaller
// ceiling limits how much an admin-only zip-bomb could decompress during parsing.
const MAX_SHEET_BYTES = 5 * 1024 * 1024;
const sheetUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_SHEET_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.xlsx')) cb(null, true);
    else cb(new Error('UNSUPPORTED_FILE_TYPE'));
  },
});

const handleSheetUpload = (req: Request, res: Response, next: NextFunction) => {
  sheetUpload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof Error && err.message === 'UNSUPPORTED_FILE_TYPE') {
      return res
        .status(415)
        .json({ error: 'Only .xlsx files are accepted', code: 'UNSUPPORTED_FILE_TYPE' });
    }
    if (err instanceof multer.MulterError) {
      const tooBig = err.code === 'LIMIT_FILE_SIZE';
      return res
        .status(tooBig ? 413 : 400)
        .json({ error: err.message, code: tooBig ? 'FILE_TOO_LARGE' : 'UPLOAD_ERROR' });
    }
    return next(err);
  });
};

router.get(
  '/',
  [
    query('subCategoryId').optional().isUUID(),
    query('workflowStatusId').optional().isUUID(),
    query('assignedToUserId').optional().isUUID(),
    query('search').optional().isString(),
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('page').optional().isInt({ min: 1 }).toInt(),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const r = await getService(req).list({
        subCategoryId: req.query.subCategoryId as string | undefined,
        workflowStatusId: req.query.workflowStatusId as string | undefined,
        assignedToUserId: req.query.assignedToUserId as string | undefined,
        search: req.query.search as string | undefined,
        status: req.query.status as 'ACTIVE' | 'INACTIVE' | undefined,
        scope: 'ALL',
        callerId: req.session!.userId,
        page: req.query.page as unknown as number | undefined,
        limit: req.query.limit as unknown as number | undefined,
      });
      res.json({
        data: r.data,
        pagination: {
          page: r.page,
          limit: r.limit,
          total: r.total,
          totalPages: Math.ceil(r.total / r.limit),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

// Bulk-import the "Forged Documents Observations" sheet into a chosen Sub-Category.
router.post(
  '/import-observations',
  handleSheetUpload,
  [body('subCategoryId').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const file = req.file;
      if (!file) {
        return res.status(400).json({ error: 'No file provided', code: 'NO_FILE' });
      }
      const subCategoryId = req.body.subCategoryId as string;

      const { rows, errors: parseErrors } = await parseObservationWorkbook(file.buffer);
      const { created, updated, errors: rowErrors } = await getService(req).importObservations(
        rows,
        subCategoryId,
        req.session!.userId,
        'ALL'
      );
      const errors = [...parseErrors, ...rowErrors];
      res.json({
        data: { subCategoryId, parsed: rows.length, created, updated, failed: errors.length, errors },
      });
    } catch (err) {
      if (err instanceof ObservationParseError) {
        return res.status(422).json({ error: err.message, code: err.code });
      }
      handleErr(err, res, next);
    }
  }
);

// Export the observation sheet (same 10 columns) with Status filled from validation.
router.get(
  '/export-observations',
  [query('subCategoryId').isUUID(), query('search').optional().isString().isLength({ max: 100 })],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const rows = await getService(req).observationExportRows({
        subCategoryId: req.query.subCategoryId as string | undefined,
        search: req.query.search as string | undefined,
        scope: 'ALL',
        callerId: req.session!.userId,
      });
      const wb = buildObservationWorkbook(rows);
      const buf = await wb.xlsx.writeBuffer();
      const date = new Date().toISOString().slice(0, 10);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="forged-observations-${date}.xlsx"`
      );
      res.send(Buffer.from(buf));
    } catch (err) {
      next(err);
    }
  }
);

router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const c = await getService(req).getById(req.params.id, req.session!.userId, 'ADMIN');
      if (!c) return res.status(404).json({ error: 'Not found', code: 'NOT_FOUND' });
      res.json({ data: c });
    } catch (err) {
      next(err);
    }
  }
);

router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      await getService(req).softDelete(req.params.id, req.session!.userId);
      res.json({ message: 'Soft-deleted' });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

// Recover a soft-deleted claim (the only way back from INACTIVE).
router.post(
  '/:id/restore',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const restored = await getService(req).restore(req.params.id, req.session!.userId);
      res.json({ data: restored });
    } catch (err) {
      handleErr(err, res, next);
    }
  }
);

export default router;
