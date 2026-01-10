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

// GET /api/admin/categories
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
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
      if (userTypeId) where.userTypeId = userTypeId;
      if (projectTypeId) where.projectTypeId = projectTypeId;
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            userType: { select: { id: true, name: true } },
            projectType: { select: { id: true, name: true } },
            _count: { select: { subCategories: true } },
          },
        }),
        prisma.category.count({ where }),
      ]);

      res.json({
        data: categories,
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

// POST /api/admin/categories
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('userTypeId').isUUID().withMessage('Valid User Type is required'),
    body('projectTypeId').isUUID().withMessage('Valid Project Type is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { name, userTypeId, projectTypeId, description, status = 'ACTIVE' } = req.body;

      // Verify User Type and Project Type exist and are active
      const [userType, projectType] = await Promise.all([
        prisma.userType.findUnique({ where: { id: userTypeId } }),
        prisma.projectType.findUnique({ where: { id: projectTypeId } }),
      ]);

      if (!userType || userType.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive User Type',
          code: 'INVALID_USER_TYPE',
        });
      }

      if (!projectType || projectType.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive Project Type',
          code: 'INVALID_PROJECT_TYPE',
        });
      }

      // Check for duplicate name within same User Type + Project Type pair
      const existing = await prisma.category.findFirst({
        where: { name, userTypeId, projectTypeId },
      });
      if (existing) {
        return res.status(409).json({
          error: 'A Category with this name already exists for this User Type + Project Type',
          code: 'DUPLICATE_NAME',
        });
      }

      const category = await prisma.category.create({
        data: {
          name,
          userTypeId,
          projectTypeId,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
        include: {
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
        },
      });

      res.status(201).json(category);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/categories/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const category = await prisma.category.findUnique({
        where: { id },
        include: {
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
          _count: { select: { subCategories: true } },
        },
      });

      if (!category) {
        return res.status(404).json({
          error: 'Category not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(category);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/categories/:id
router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    body('userTypeId').optional().isUUID(),
    body('projectTypeId').optional().isUUID(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { name, description, status, userTypeId, projectTypeId } = req.body;

      const existing = await prisma.category.findUnique({
        where: { id },
        include: { _count: { select: { subCategories: true } } },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'Category not found',
          code: 'NOT_FOUND',
        });
      }

      // Cannot change User Type or Project Type if sub-categories exist
      if ((userTypeId || projectTypeId) && existing._count.subCategories > 0) {
        return res.status(409).json({
          error: 'Cannot change User Type or Project Type when sub-categories exist',
          code: 'HAS_DEPENDENCIES',
        });
      }

      // Check for duplicate name
      const finalName = name || existing.name;
      const finalUserTypeId = userTypeId || existing.userTypeId;
      const finalProjectTypeId = projectTypeId || existing.projectTypeId;

      if (name || userTypeId || projectTypeId) {
        const duplicate = await prisma.category.findFirst({
          where: {
            name: finalName,
            userTypeId: finalUserTypeId,
            projectTypeId: finalProjectTypeId,
            id: { not: id },
          },
        });
        if (duplicate) {
          return res.status(409).json({
            error: 'A Category with this name already exists for this User Type + Project Type',
            code: 'DUPLICATE_NAME',
          });
        }
      }

      const category = await prisma.category.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          ...(userTypeId && { userTypeId }),
          ...(projectTypeId && { projectTypeId }),
          updatedBy: req.session!.userId,
        },
        include: {
          userType: { select: { id: true, name: true } },
          projectType: { select: { id: true, name: true } },
        },
      });

      res.json(category);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/categories/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.category.findUnique({
        where: { id },
        include: { _count: { select: { subCategories: true } } },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'Category not found',
          code: 'NOT_FOUND',
        });
      }

      if (existing._count.subCategories > 0) {
        return res.status(409).json({
          error: 'Cannot delete Category with sub-categories',
          code: 'HAS_DEPENDENCIES',
        });
      }

      await prisma.category.delete({ where: { id } });

      res.json({ message: 'Category deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
