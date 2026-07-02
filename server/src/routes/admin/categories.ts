import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

const router = Router();

// GET /api/admin/categories
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
    query('projectId').optional().isUUID(),
    query('search').optional().isString(),
    query('page').optional().isInt({ min: 1 }),
    query('limit').optional().isInt({ min: 1, max: 100 }),
    query('sortBy').optional().isIn(['name', 'createdAt', 'status']),
    query('sortOrder').optional().isIn(['asc', 'desc']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = prismaOf(req);
      const { status, projectId, search, sortBy = 'name', sortOrder = 'asc' } = req.query;
      const { page, limit, skip, take } = parsePagination(req.query);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (projectId) where.projectId = projectId;
      if (search) {
        where.OR = [
          { name: { contains: search as string } },
          { description: { contains: search as string } },
        ];
      }

      const [categories, total] = await Promise.all([
        prisma.category.findMany({
          where,
          skip,
          take,
          orderBy: { [sortBy as string]: sortOrder },
          include: {
            project: { select: { id: true, name: true } },
            _count: { select: { subCategories: true } },
          },
        }),
        prisma.category.count({ where }),
      ]);

      res.json(paginated(categories, total, page, limit));
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
    body('projectId').isUUID().withMessage('Valid Project is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { name, projectId, description, status = 'ACTIVE' } = req.body;

      // Verify Project exists and is active
      const project = await prisma.project.findUnique({ where: { id: projectId } });

      if (!project || project.status !== 'ACTIVE') {
        return res.status(400).json({
          error: 'Invalid or inactive Project',
          code: 'INVALID_PROJECT',
        });
      }

      // Check for duplicate name within same Project
      const existing = await prisma.category.findFirst({
        where: { name, projectId },
      });
      if (existing) {
        return res.status(409).json({
          error: 'A Category with this name already exists for this Project',
          code: 'DUPLICATE_NAME',
        });
      }

      const category = await prisma.category.create({
        data: {
          name,
          projectId,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
        include: {
          project: { select: { id: true, name: true } },
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
          project: { select: { id: true, name: true } },
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
    body('projectId').optional().isUUID(),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { name, description, status, projectId } = req.body;

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

      // Cannot change Project if sub-categories exist
      if (projectId && existing._count.subCategories > 0) {
        return res.status(409).json({
          error: 'Cannot change Project when sub-categories exist',
          code: 'HAS_DEPENDENCIES',
        });
      }

      // Check for duplicate name
      const finalName = name || existing.name;
      const finalProjectId = projectId || existing.projectId;

      if (name || projectId) {
        const duplicate = await prisma.category.findFirst({
          where: {
            name: finalName,
            projectId: finalProjectId,
            id: { not: id },
          },
        });
        if (duplicate) {
          return res.status(409).json({
            error: 'A Category with this name already exists for this Project',
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
          ...(projectId && { projectId }),
          updatedBy: req.session!.userId,
        },
        include: {
          project: { select: { id: true, name: true } },
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
