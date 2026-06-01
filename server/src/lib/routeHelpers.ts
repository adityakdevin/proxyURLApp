import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { validationResult } from 'express-validator';

/** Canonical express-validator gate: 400 with the first message + `details` array. */
export const validate = (req: Request, res: Response, next: NextFunction): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      error: errors.array()[0]?.msg ?? 'Validation failed',
      code: 'VALIDATION_ERROR',
      details: errors.array(),
    });
    return;
  }
  next();
};

/** The PrismaClient stashed on the app by index.ts. */
export const prismaOf = (req: Request): PrismaClient => req.app.get('prisma') as PrismaClient;

interface CodedError extends Error {
  code: string;
}

/**
 * Error-translating handler for a typed service-error class: known codes map to
 * the given status, unknown service-error codes fall back, anything else passes
 * to the global handler.
 */
export function makeErrorHandler<E extends CodedError>(
  ErrorClass: new (...args: any[]) => E,
  statusByCode: Record<string, number>,
  fallbackStatus = 400
) {
  return (err: unknown, res: Response, next: NextFunction): void => {
    if (err instanceof ErrorClass) {
      const status = statusByCode[err.code] ?? fallbackStatus;
      res.status(status).json({ error: err.message, code: err.code });
      return;
    }
    next(err);
  };
}
