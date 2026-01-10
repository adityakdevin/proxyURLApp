import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query, validationResult } from 'express-validator';

const router = Router();

const validate = (req: Request, res: Response, next: NextFunction) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: errors.array()[0]?.msg || 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
  }
  next();
};

// GET /api/admin/url-configs
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('userTypeId').optional().isUUID(),
    query('projectTypeId').optional().isUUID(),
    query('categoryId').optional().isUUID(),
    query('subCategoryId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['label', 'createdAt', 'status']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        status,
        userTypeId,
        projectTypeId,
        categoryId,
        subCategoryId,
        search,
        page = '1',
        limit = '10',
        sortBy = 'label',
        sortOrder = 'asc',
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const skip = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (userTypeId) where.userTypeId = userTypeId;
      if (projectTypeId) where.projectTypeId = projectTypeId;
      if (categoryId) where.categoryId = categoryId;
      if (subCategoryId) where.subCategoryId = subCategoryId;
      if (search) {
        where.OR = [
          { label: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } },
          { targetUrl: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [urlConfigs, total] = await Promise.all([
        prisma.urlConfiguration.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            userType: { select: { id: true, name: true } },
            projectType: { select: { id: true, name: true } },
            category: { select: { id: true, name: true } },
            subCategory: { select: { id: true, name: true } },
          },
        }),
        prisma.urlConfiguration.count({ where }),
      ]);

      res.json({
        data: urlConfigs,
        pagination: {
          page: pageNum,
          limit: limitNum,
          total,
          totalPages: Math.ceil(total / limitNum),
        },
      });
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
    body('userTypeId').isUUID().withMessage('Valid User Type is required'),
    body('projectTypeId').isUUID().withMessage('Valid Project Type is required'),
    body('categoryId').isUUID().withMessage('Valid Category is required'),
    body('subCategoryId').isUUID().withMessage('Valid Sub-Category is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        label,
        targetUrl,
        userTypeId,
        projectTypeId,
        categoryId,
        subCategoryId,
        description,
        status = 'ACTIVE',
      } = req.body;

      // Validate cascading references
      // 1. Category must belong to User Type + Project Type
      const category = await prisma.category.findFirst({
        where: {
          id: categoryId,
          userTypeId,
          projectTypeId,
        },
      });

      if (!category) {
        return res.status(400).json({
          error: 'Category does not belong to the selected User Type and Project Type',
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
          userTypeId,
          projectTypeId,
          categoryId,
          subCategoryId,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
        include: {
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
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
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
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
    body('userTypeId').optional().isUUID(),
    body('projectTypeId').optional().isUUID(),
    body('categoryId').optional().isUUID(),
    body('subCategoryId').optional().isUUID(),
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
        userTypeId,
        projectTypeId,
        categoryId,
        subCategoryId,
      } = req.body;

      const existing = await prisma.urlConfiguration.findUnique({ where: { id } });

      if (!existing) {
        return res.status(404).json({
          error: 'URL Configuration not found',
          code: 'NOT_FOUND',
        });
      }

      // If any reference is being changed, validate cascading
      if (userTypeId || projectTypeId || categoryId || subCategoryId) {
        const finalUserTypeId = userTypeId || existing.userTypeId;
        const finalProjectTypeId = projectTypeId || existing.projectTypeId;
        const finalCategoryId = categoryId || existing.categoryId;
        const finalSubCategoryId = subCategoryId || existing.subCategoryId;

        // Validate Category belongs to User Type + Project Type
        const category = await prisma.category.findFirst({
          where: {
            id: finalCategoryId,
            userTypeId: finalUserTypeId,
            projectTypeId: finalProjectTypeId,
          },
        });

        if (!category) {
          return res.status(400).json({
            error: 'Category does not belong to the selected User Type and Project Type',
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
          ...(userTypeId && { userTypeId }),
          ...(projectTypeId && { projectTypeId }),
          ...(categoryId && { categoryId }),
          ...(subCategoryId && { subCategoryId }),
          updatedBy: req.session!.userId,
        },
        include: {
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
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
