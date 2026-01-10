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

// GET /api/admin/project-types
router.get(
  '/',
  [
    query('status').optional().isIn(['ACTIVE', 'INACTIVE']),
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
      if (search) {
        where.OR = [
          { name: { contains: search as string, mode: 'insensitive' } },
          { description: { contains: search as string, mode: 'insensitive' } },
        ];
      }

      const [projectTypes, total] = await Promise.all([
        prisma.projectType.findMany({
          where,
          skip,
          take: limitNum,
          orderBy: { [sortBy as string]: sortOrder },
        }),
        prisma.projectType.count({ where }),
      ]);

      res.json({
        data: projectTypes,
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

// POST /api/admin/project-types
router.post(
  '/',
  [
    body('name').trim().notEmpty().withMessage('Name is required'),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { name, description, status = 'ACTIVE' } = req.body;

      const existing = await prisma.projectType.findUnique({ where: { name } });
      if (existing) {
        return res.status(409).json({
          error: 'A Project Type with this name already exists',
          code: 'DUPLICATE_NAME',
        });
      }

      const projectType = await prisma.projectType.create({
        data: {
          name,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
      });

      res.status(201).json(projectType);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/project-types/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const projectType = await prisma.projectType.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              userAssignments: true,
              categories: true,
            },
          },
        },
      });

      if (!projectType) {
        return res.status(404).json({
          error: 'Project Type not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(projectType);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/project-types/:id
router.put(
  '/:id',
  [
    param('id').isUUID(),
    body('name').optional().trim().notEmpty(),
    body('description').optional().isString(),
    body('status').optional().isIn(['ACTIVE', 'INACTIVE']),
  ],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;
      const { name, description, status } = req.body;

      const existing = await prisma.projectType.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({
          error: 'Project Type not found',
          code: 'NOT_FOUND',
        });
      }

      if (name && name !== existing.name) {
        const duplicate = await prisma.projectType.findUnique({ where: { name } });
        if (duplicate) {
          return res.status(409).json({
            error: 'A Project Type with this name already exists',
            code: 'DUPLICATE_NAME',
          });
        }
      }

      // If deactivating, terminate all sessions for users with this Project Type
      if (status === 'INACTIVE' && existing.status === 'ACTIVE') {
        const { SessionService } = await import('../../services/sessionService.js');
        const sessionService = new SessionService(prisma);
        await sessionService.deleteSessionsByProjectType(id);
      }

      const projectType = await prisma.projectType.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          updatedBy: req.session!.userId,
        },
      });

      res.json(projectType);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/project-types/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.projectType.findUnique({
        where: { id },
        include: {
          _count: {
            select: {
              userAssignments: true,
              categories: true,
            },
          },
        },
      });

      if (!existing) {
        return res.status(404).json({
          error: 'Project Type not found',
          code: 'NOT_FOUND',
        });
      }

      if (existing._count.userAssignments > 0 || existing._count.categories > 0) {
        return res.status(409).json({
          error: 'Cannot delete Project Type with assigned users or categories',
          code: 'HAS_DEPENDENCIES',
        });
      }

      await prisma.projectType.delete({ where: { id } });

      res.json({ message: 'Project Type deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
