import { Request, Response, NextFunction } from 'express';
import { PrismaClient } from '@prisma/client';
import { AuthService } from '../services/authService.js';
import { SessionData } from '../services/sessionService.js';
import { createError } from './errorHandler.js';

// Extend Express Request to include session data
declare global {
  namespace Express {
    interface Request {
      session?: SessionData;
      sessionToken?: string;
    }
  }
}

const COOKIE_NAME = 'proxy_session';

export const authMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  try {
    const prisma = req.app.get('prisma') as PrismaClient;
    const authService = new AuthService(prisma);

    // Get session token from cookie
    const sessionToken = req.cookies[COOKIE_NAME];

    if (!sessionToken) {
      return res.status(401).json({
        error: 'Authentication required',
        code: 'AUTH_REQUIRED',
      });
    }

    // Validate session
    const sessionData = await authService.validateSession(sessionToken);

    if (!sessionData) {
      // Clear invalid cookie
      res.clearCookie(COOKIE_NAME);
      return res.status(401).json({
        error: 'Session expired or invalid',
        code: 'SESSION_EXPIRED',
      });
    }

    // Attach session data to request
    req.session = sessionData;
    req.sessionToken = sessionToken;

    next();
  } catch (error) {
    next(error);
  }
};

// Middleware to check if user is admin
export const adminMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
    });
  }

  if (req.session.role !== 'ADMIN') {
    return res.status(403).json({
      error: 'Admin access required',
      code: 'ADMIN_REQUIRED',
    });
  }

  next();
};

// Middleware to check if password change is NOT required
// (blocks access to other pages if force password change is true)
export const passwordChangedMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (!req.session) {
    return res.status(401).json({
      error: 'Authentication required',
      code: 'AUTH_REQUIRED',
    });
  }

  if (req.session.forcePasswordChange) {
    return res.status(403).json({
      error: 'Password change required',
      code: 'PASSWORD_CHANGE_REQUIRED',
    });
  }

  next();
};

// Helper to set session cookie
export const setSessionCookie = (res: Response, sessionToken: string) => {
  const isHttps = process.env.CLIENT_URL?.startsWith('https://') ?? false;

  res.cookie(COOKIE_NAME, sessionToken, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    maxAge: 30 * 60 * 1000, // 30 minutes
    path: '/',
  });
};

// Helper to clear session cookie
export const clearSessionCookie = (res: Response) => {
  const isHttps = process.env.CLIENT_URL?.startsWith('https://') ?? false;

  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: isHttps,
    sameSite: 'lax',
    path: '/',
  });
};
