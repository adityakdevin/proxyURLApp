import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient, ProxyMode, AuditLevel } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

// Valid enum values for validation
const PROXY_MODES = ['DIRECT', 'HEADLESS', 'NEW_WINDOW'];
const AUDIT_LEVELS = ['STANDARD', 'NAVIGATION', 'FULL'];

const router = Router();

// GET /api/admin/url-configs
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('projectId').optional().isUUID(),
    query('categoryId').optional().isUUID(),
    query('subCategoryId').optional().isUUID(),
    query('proxyMode').optional().isIn(PROXY_MODES),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['label', 'createdAt', 'status', 'proxyMode']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const {
        status,
        projectId,
        categoryId,
        subCategoryId,
        proxyMode,
        search,
        sortBy = 'label',
        sortOrder = 'asc',
      } = req.query;
      const { page, limit, skip, take } = parsePagination(req.query);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (projectId) where.projectId = projectId;
      if (categoryId) where.categoryId = categoryId;
      if (subCategoryId) where.subCategoryId = subCategoryId;
      if (proxyMode) where.proxyMode = proxyMode;
      if (search) {
        where.OR = [
          { label: { contains: search as string } },
          { description: { contains: search as string } },
          { targetUrl: { contains: search as string } },
        ];
      }

      const [urlConfigs, total] = await Promise.all([
        prisma.urlConfiguration.findMany({
          where,
          skip,
          take,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            project: { select: { id: true, name: true } },
            category: { select: { id: true, name: true } },
            subCategory: { select: { id: true, name: true } },
          },
        }),
        prisma.urlConfiguration.count({ where }),
      ]);

      res.json(paginated(urlConfigs, total, page, limit));
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/admin/url-configs
router.post(
  '/',
  [
    body('label').trim().notEmpty().withMessage('Label is required'),
    body('targetUrl').isURL().withMessage('Valid URL is required'),
    body('projectId').isUUID().withMessage('Valid Project is required'),
    body('categoryId').isUUID().withMessage('Valid Category is required'),
    body('subCategoryId').isUUID().withMessage('Valid Sub-Category is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    // New proxy mode fields
    body('proxyMode').optional().isIn(PROXY_MODES).withMessage('Invalid proxy mode'),
    body('headlessTimeout').optional().isInt({ min: 5000, max: 300000 }).withMessage('Headless timeout must be between 5000 and 300000 ms'),
    body('sessionTtl').optional().isInt({ min: 5000, max: 300000 }).withMessage('Session TTL must be between 5000 and 300000 ms'),
    body('auditLevel').optional().isIn(AUDIT_LEVELS).withMessage('Invalid audit level'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        label,
        targetUrl,
        projectId,
        categoryId,
        subCategoryId,
        description,
        status = 'ACTIVE',
        // New proxy mode fields
        proxyMode = 'DIRECT',
        headlessTimeout = 60000,
        sessionTtl = 30000,
        auditLevel = 'STANDARD',
      } = req.body;

      // Validate cascading references
      // 1. Category must belong to Project
      const category = await prisma.category.findFirst({
        where: {
          id: categoryId,
          projectId,
        },
      });

      if (!category) {
        return res.status(400).json({
          error: 'Category does not belong to the selected Project',
          code: 'INVALID_CATEGORY',
        });
      }

      // 2. Sub-Category must belong to Category
      const subCategory = await prisma.subCategory.findFirst({
        where: {
          id: subCategoryId,
          categoryId,
        },
      });

      if (!subCategory) {
        return res.status(400).json({
          error: 'Sub-Category does not belong to the selected Category',
          code: 'INVALID_SUB_CATEGORY',
        });
      }

      const urlConfig = await prisma.urlConfiguration.create({
        data: {
          label,
          targetUrl,
          projectId,
          categoryId,
          subCategoryId,
          description,
          status,
          proxyMode: proxyMode as ProxyMode,
          headlessTimeout,
          sessionTtl,
          auditLevel: auditLevel as AuditLevel,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
        include: {
          project: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
        },
      });

      res.status(201).json(urlConfig);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/url-configs/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const urlConfig = await prisma.urlConfiguration.findUnique({
        where: { id },
        include: {
          project: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
        },
      });

      if (!urlConfig) {
        return res.status(404).json({
          error: 'URL Configuration not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(urlConfig);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/url-configs/:id
router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('label').optional().trim().notEmpty(),
    body('targetUrl').optional().isURL(),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('projectId').optional().isUUID(),
    body('categoryId').optional().isUUID(),
    body('subCategoryId').optional().isUUID(),
    // New proxy mode fields
    body('proxyMode').optional().isIn(PROXY_MODES).withMessage('Invalid proxy mode'),
    body('headlessTimeout').optional().isInt({ min: 5000, max: 300000 }).withMessage('Headless timeout must be between 5000 and 300000 ms'),
    body('sessionTtl').optional().isInt({ min: 5000, max: 300000 }).withMessage('Session TTL must be between 5000 and 300000 ms'),
    body('auditLevel').optional().isIn(AUDIT_LEVELS).withMessage('Invalid audit level'),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const {
        label,
        targetUrl,
        description,
        status,
        projectId,
        categoryId,
        subCategoryId,
        // New proxy mode fields
        proxyMode,
        headlessTimeout,
        sessionTtl,
        auditLevel,
      } = req.body;

      const existing = await prisma.urlConfiguration.findUnique({ where: { id } });

      if (!existing) {
        return res.status(404).json({
          error: 'URL Configuration not found',
          code: 'NOT_FOUND',
        });
      }

      // If any reference is being changed, validate cascading
      if (projectId || categoryId || subCategoryId) {
        const finalProjectId = projectId || existing.projectId;
        const finalCategoryId = categoryId || existing.categoryId;
        const finalSubCategoryId = subCategoryId || existing.subCategoryId;

        // Validate Category belongs to Project
        const category = await prisma.category.findFirst({
          where: {
            id: finalCategoryId,
            projectId: finalProjectId,
          },
        });

        if (!category) {
          return res.status(400).json({
            error: 'Category does not belong to the selected Project',
            code: 'INVALID_CATEGORY',
          });
        }

        // Validate Sub-Category belongs to Category
        const subCategory = await prisma.subCategory.findFirst({
          where: {
            id: finalSubCategoryId,
            categoryId: finalCategoryId,
          },
        });

        if (!subCategory) {
          return res.status(400).json({
            error: 'Sub-Category does not belong to the selected Category',
            code: 'INVALID_SUB_CATEGORY',
          });
        }
      }

      const urlConfig = await prisma.urlConfiguration.update({
        where: { id },
        data: {
          ...(label && { label }),
          ...(targetUrl && { targetUrl }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          ...(projectId && { projectId }),
          ...(categoryId && { categoryId }),
          ...(subCategoryId && { subCategoryId }),
          // New proxy mode fields
          ...(proxyMode && { proxyMode: proxyMode as ProxyMode }),
          ...(headlessTimeout !== undefined && { headlessTimeout }),
          ...(sessionTtl !== undefined && { sessionTtl }),
          ...(auditLevel && { auditLevel: auditLevel as AuditLevel }),
          updatedBy: req.session!.userId,
        },
        include: {
          project: { select: { id: true, name: true } },
          category: { select: { id: true, name: true } },
          subCategory: { select: { id: true, name: true } },
        },
      });

      res.json(urlConfig);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/url-configs/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.urlConfiguration.findUnique({ where: { id } });

      if (!existing) {
        return res.status(404).json({
          error: 'URL Configuration not found',
          code: 'NOT_FOUND',
        });
      }

      await prisma.urlConfiguration.delete({ where: { id } });

      res.json({ message: 'URL Configuration deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
