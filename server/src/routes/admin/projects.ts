import { Router, Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { body, param, query } from 'express-validator';
import { validate, prismaOf, parsePagination, paginated } from '../../lib/routeHelpers.js';

const router = Router();

// GET /api/admin/projects
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
      const prisma = prismaOf(req);
      const { status, search, sortBy = 'name', sortOrder = 'asc' } = req.query;
      const { page, limit, skip, take } = parsePagination(req.query);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { name: { contains: search as string } },
          { description: { contains: search as string } },
        ];
      }

      const [projects, total] = await Promise.all([
        prisma.project.findMany({
          where,
          skip,
          take,
          orderBy: { [sortBy as string]: sortOrder },
        }),
        prisma.project.count({ where }),
      ]);

      res.json(paginated(projects, total, page, limit));
    } catch (error) {
      next(error);
    }
  }
);

// POST /api/admin/projects
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

      const existing = await prisma.project.findUnique({ where: { name } });
      if (existing) {
        return res.status(409).json({
          error: 'A Project with this name already exists',
          code: 'DUPLICATE_NAME',
        });
      }

      const project = await prisma.project.create({
        data: {
          name,
          description,
          status,
          createdBy: req.session!.userId,
          updatedBy: req.session!.userId,
        },
      });

      res.status(201).json(project);
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/admin/projects/:id
router.get(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const project = await prisma.project.findUnique({
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

      if (!project) {
        return res.status(404).json({
          error: 'Project not found',
          code: 'NOT_FOUND',
        });
      }

      res.json(project);
    } catch (error) {
      next(error);
    }
  }
);

// PUT /api/admin/projects/:id
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

      const existing = await prisma.project.findUnique({ where: { id } });
      if (!existing) {
        return res.status(404).json({
          error: 'Project not found',
          code: 'NOT_FOUND',
        });
      }

      if (name && name !== existing.name) {
        const duplicate = await prisma.project.findUnique({ where: { name } });
        if (duplicate) {
          return res.status(409).json({
            error: 'A Project with this name already exists',
            code: 'DUPLICATE_NAME',
          });
        }
      }

      // If deactivating, terminate all sessions for users with this Project
      if (status === 'INACTIVE' && existing.status === 'ACTIVE') {
        const { SessionService } = await import('../../services/sessionService.js');
        const sessionService = new SessionService(prisma);
        await sessionService.deleteSessionsByProject(id);
      }

      const project = await prisma.project.update({
        where: { id },
        data: {
          ...(name && { name }),
          ...(description !== undefined && { description }),
          ...(status && { status }),
          updatedBy: req.session!.userId,
        },
      });

      res.json(project);
    } catch (error) {
      next(error);
    }
  }
);

// DELETE /api/admin/projects/:id
router.delete(
  '/:id',
  [param('id').isUUID()],
  validate,
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const prisma = req.app.get('prisma') as PrismaClient;
      const { id } = req.params;

      const existing = await prisma.project.findUnique({
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
          error: 'Project not found',
          code: 'NOT_FOUND',
        });
      }

      if (existing._count.userAssignments > 0 || existing._count.categories > 0) {
        return res.status(409).json({
          error: 'Cannot delete Project with assigned users or categories',
          code: 'HAS_DEPENDENCIES',
        });
      }

      await prisma.project.delete({ where: { id } });

      res.json({ message: 'Project deleted successfully' });
    } catch (error) {
      next(error);
    }
  }
);

export default router;
