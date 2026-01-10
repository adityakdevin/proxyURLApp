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

// GET /api/admin/sub-categories
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('categoryId').optional().isUUID(),
    query('userTypeId').optional().isUUID(),
    query('projectTypeId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['name', 'createdAt', 'status']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const {
        status,
        categoryId,
        userTypeId,
        projectTypeId,
        search,
        page = '1',
        limit = '10',
        sortBy = 'name',
        sortOrder = 'asc',
      } = req.query;

      const pageNum = parseInt(page as string, 10);
      const limitNum = parseInt(limit as string, 10);
      const skip = (pageNum - 1) * limitNum;

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (categoryId) where.categoryId = categoryId;
      if (userTypeId || projectTypeId) {
        where.category = {
          ...(userTypeId && { userTypeId: userTypeId as string }),
          ...(projectTypeId && { projectTypeId: projectTypeId as string }),
        };
      }
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [subCategories, total] = await Promise.all([
        prisma.subCategory.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            category: {
              select: {
                id: true,
                name: true,
                userType: { select: { id: true, name: true } },
                projectType: { select: { id: true, name: true } },
              },
            },
            _count: { select: { urlConfigurations: true } },
          },
        }),
        prisma.subCategory.count({ where }),
      ]);

      res.json({
        data: subCategories,
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

// POST /api/admin/sub-categories
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('categoryId').isUUID().withMessage('Valid Category is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { name, categoryId, description, status = 'ACTIVE' } = req.body;

      // Verify Category exists and is active
      const category = await prisma.category.findUnique({
        where: { id: categoryId },
      });

      if (!category) {
        return res.status(400).json({
          error: 'Invalid Category',
          code: 'INVALID_CATEGORY',
        });
      }

      // Check for duplicate name within same category
      const existing = await prisma.subCategory.findFirst({
        where: { name, categoryId },
      });
      if (existing) {
        return res.status(409).json({
          error: 'A Sub-Category with this name already exists in this Category',
          code: 'DUPLICATE_NAME',
        });
      }

      const subCategory = await prisma.subCategory.create({
        data: {
          name,
          categoryId,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
        },
      });

      res.status(201).json(subCategory);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/sub-categories/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const subCategory = await prisma.subCategory.findUnique({
        where: { id },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
          _count: { select: { urlConfigurations: true } },
        },
      });

      if (!subCategory) {
        return res.status(404).json({
          error: 'Sub-Category not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(subCategory);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/sub-categories/:id
router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('categoryId').optional().isUUID(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { name, description, status, categoryId } = req.body;

      const existing = await prisma.subCategory.findUnique({
        where: { id },
        include: { _count: { select: { urlConfigurations: true } } },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'Sub-Category not found',
          code: 'NOT_FOUND',
        });
      }

      // Cannot change Category if URL configurations exist
      if (categoryId && categoryId !== existing.categoryId && existing._count.urlConfigurations > 0) {
        return res.status(409).json({
          error: 'Cannot change Category when URL configurations exist',
          code: 'HAS_DEPENDENCIES',
        });
      }

      // Check for duplicate name
      const finalName = name || existing.name;
      const finalCategoryId = categoryId || existing.categoryId;

      if (name || categoryId) {
        const duplicate = await prisma.subCategory.findFirst({
          where: {
            name: finalName,
            categoryId: finalCategoryId,
            id: { not: id },
          },
        });
        if (duplicate) {
          return res.status(409).json({
            error: 'A Sub-Category with this name already exists in this Category',
            code: 'DUPLICATE_NAME',
          });
        }
      }

      const subCategory = await prisma.subCategory.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          ...(categoryId && { categoryId }),
          updatedBy: req.session!.userId,
        },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              userType: { select: { id: true, name: true } },
              projectType: { select: { id: true, name: true } },
            },
          },
        },
      });

      res.json(subCategory);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/sub-categories/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.subCategory.findUnique({
        where: { id },
        include: { _count: { select: { urlConfigurations: true } } },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'Sub-Category not found',
          code: 'NOT_FOUND',
        });
      }

      if (existing._count.urlConfigurations > 0) {
        return res.status(409).json({
          error: 'Cannot delete Sub-Category with URL configurations',
          code: 'HAS_DEPENDENCIES',
        });
      }

      await prisma.subCategory.delete({ where: { id } });

      res.json({ message: 'Sub-Category deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
