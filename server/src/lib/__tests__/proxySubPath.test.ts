import express from 'express';
import request from 'supertest';
import { PROXY_SUBRESOURCE_ROUTE, proxySubPath } from '../routeHelpers.js';

// Characterization: these expectations are what Express 4's `req.params[0] || ''` returned.
// The Express 5 route syntax must keep producing the same sub-path string.
describe('proxySubPath', () => {
  const app = express();
  app.all(PROXY_SUBRESOURCE_ROUTE, (req, res) => {
    res.send(proxySubPath(req));
  });

  it.each([
    ['/abc/', ''],
    ['/abc/css/site.css', 'css/site.css'],
    ['/abc/dir/', 'dir/'],
    ['/abc/a%20b/c.js?x=1', 'a b/c.js'],
    ['/abc/_ext/aHR0cHM6Ly9leGFtcGxlLmNvbS8', '_ext/aHR0cHM6Ly9leGFtcGxlLmNvbS8'],
    // Decoded exactly once: a literal '%' survives, and '%2520' stays '%20'.
    ['/abc/100%25.css', '100%.css'],
    ['/abc/a%2520b.js', 'a%20b.js'],
  ])('%s -> %j', async (path, expected) => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.text).toBe(expected);
  });
});
