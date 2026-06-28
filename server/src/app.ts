import express, { Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { PrismaClient } from '@prisma/client';

// Routes
import authRoutes from './routes/auth.js';
import adminRoutes from './routes/admin/index.js';
import userRoutes from './routes/user.js';
import claimsRoutes from './routes/claims.js';
import proxyRoutes from './routes/proxy.js';

// Middleware
import { errorHandler } from './middleware/errorHandler.js';

/**
 * Build the fully-wired Express app WITHOUT binding a port or starting any
 * background jobs (scan sweep, validation drain, headless browser pool).
 *
 * The HTTP entrypoint (`index.ts`) owns process lifecycle: it constructs a
 * production PrismaClient, calls `listen()`, runs startup sweeps, and registers
 * signal handlers. Tests import THIS factory with an injected (test-DB) Prisma
 * client and drive the app in-process via supertest — no port, no sweeps.
 */
export function createApp(prisma: PrismaClient): Express {
  const app = express();
  const isHttps = process.env.CLIENT_URL?.startsWith('https://') ?? false;

  // Apply helmet to non-proxy routes only (proxy needs to allow iframes)
  app.use((req, res, next) => {
    if (req.path.startsWith('/proxy')) {
      return next();
    }
    helmet({
      contentSecurityPolicy: false,
      crossOriginOpenerPolicy: isHttps ? { policy: 'same-origin' } : false,
      crossOriginResourcePolicy: isHttps ? { policy: 'same-origin' } : false,
      originAgentCluster: isHttps,
    })(req, res, next);
  });

  app.use(
    cors({
      origin: process.env.CLIENT_URL || 'http://localhost:5173',
      credentials: true,
    })
  );
  app.use(cookieParser());

  // Make prisma available to routes (read via req.app.get('prisma'))
  app.set('prisma', prisma);

  // Proxy routes MUST be before express.json() to preserve raw body stream
  app.use('/proxy', proxyRoutes);

  // Parse JSON body only for API routes (after proxy to not consume body stream)
  app.use('/api', express.json());

  // Health check
  app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Routes
  app.use('/api/auth', authRoutes);
  app.use('/api/admin', adminRoutes);
  app.use('/api/user', userRoutes);
  app.use('/api/claims', claimsRoutes);

  if (process.env.NODE_ENV === 'production') {
    const clientPath = path.resolve(process.cwd(), '../client/dist');
    app.use(express.static(clientPath));
    app.get('*', (req, res, next) => {
      if (
        !req.path.startsWith('/api') &&
        !req.path.startsWith('/proxy') &&
        !req.path.startsWith('/health')
      ) {
        res.sendFile(path.join(clientPath, 'index.html'));
      } else {
        next();
      }
    });
  }

  // Error handler
  app.use(errorHandler);

  return app;
}
