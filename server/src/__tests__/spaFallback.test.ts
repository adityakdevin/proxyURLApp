import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { PrismaClient } from '@prisma/client';
import { createApp } from '../app.js';

// Production serves the client build and falls back to index.html for client-side routes.
// Express 5 needs the named wildcard ('/{*splat}'); a pattern it rejects throws at startup,
// and nothing else exercises this block: e2e runs with NODE_ENV=test.
describe('production SPA fallback', () => {
  const env = process.env.NODE_ENV;
  let tmp: string;

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spa-'));
    fs.mkdirSync(path.join(tmp, 'client', 'dist'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'server'));
    fs.writeFileSync(path.join(tmp, 'client', 'dist', 'index.html'), '<!doctype html>SPA');
    // createApp resolves the build as ../client/dist from the server's working directory.
    jest.spyOn(process, 'cwd').mockReturnValue(path.join(tmp, 'server'));
    process.env.NODE_ENV = 'production';
  });

  afterAll(() => {
    process.env.NODE_ENV = env;
    jest.restoreAllMocks();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('serves index.html for deep client routes and leaves /api to the API', async () => {
    const app = createApp({} as PrismaClient);
    for (const route of ['/admin/users', '/claims/abc/documents/def']) {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);
      expect(res.text).toContain('SPA');
    }
    expect((await request(app).get('/api/no-such-route')).text).not.toContain('SPA');
  });
});
