import router from '../proxy.js';

/**
 * Route ORDER, asserted on the router stack — no app, no database, no headless browser
 * (the health handler probes one and can block).
 *
 * `/:opaqueId/*` matches /proxy/health/headless with opaqueId="health" and
 * /proxy/redirect/<id> with opaqueId="redirect", so both specific routes must be declared
 * BEFORE it. Declared after, they were dead: the health check answered SESSION_EXPIRED
 * instead of a status, and the NEW_WINDOW redirect resolved as a proxy request for a URL
 * config that does not exist.
 */
describe('proxy router declaration order', () => {
  const paths = (router as unknown as { stack: { route?: { path: string } }[] }).stack
    .filter((l) => l.route)
    .map((l) => l.route!.path);

  it('declares the specific routes before the opaque-id catch-all', () => {
    const catchAll = paths.indexOf('/:opaqueId/*');
    expect(catchAll).toBeGreaterThan(-1);
    for (const specific of ['/redirect/:opaqueId', '/health/headless']) {
      expect(paths).toContain(specific);
      expect(paths.indexOf(specific)).toBeLessThan(catchAll);
    }
  });
});
