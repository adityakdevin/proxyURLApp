import urlConfigs from '../admin/urlConfigs.js';
import projects from '../admin/projects.js';
import subCategories from '../admin/subCategories.js';
import categories from '../admin/categories.js';
import claimRules from '../admin/claimRules.js';

/**
 * Every admin page built on useCrudResource toggles status through its update route.
 * The hook used to call PATCH /:id/status, which only the claim-rules router implemented,
 * so Deactivate answered 404 on URL Configs, Projects, Sub-Categories and Categories.
 *
 * This asserts the contract the hook now relies on: each of those routers exposes
 * PUT /:id. Checked on the router stack rather than by grepping source, because route
 * ORDER matters as much as existence — a stray '/:id/...' declared first would swallow it.
 */
const routers = { urlConfigs, projects, subCategories, categories, claimRules };

describe('admin routers used by useCrudResource', () => {
  for (const [name, router] of Object.entries(routers)) {
    it(`${name} exposes PUT /:id for the status toggle`, () => {
      const layers = (
        router as unknown as {
          stack: { route?: { path: string; methods: Record<string, boolean> } }[];
        }
      ).stack.filter((l) => l.route);
      const put = layers.find((l) => l.route!.path === '/:id' && l.route!.methods.put);
      expect(put).toBeDefined();
    });
  }
});
