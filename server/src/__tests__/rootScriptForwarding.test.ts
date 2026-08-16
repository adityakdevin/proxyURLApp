import fs from 'fs';
import path from 'path';

/**
 * Every script in server/package.json must be runnable from the repo root.
 *
 * The deploy box runs from C:\ProxyApp, not C:\ProxyApp\server. A script that exists only
 * in the workspace fails there with a bare `npm error Missing script: "..."`, which during
 * a deploy reads as a broken build rather than a missing one-line alias — and the operator
 * has no way to tell those apart from the message.
 *
 * That is not hypothetical: db:revalidate and db:backfill-doctype-required were both
 * documented in runbooks as root commands, and both were absent from the root manifest.
 *
 * Reading package.json off disk rather than importing it: the root manifest is outside
 * server/'s tsconfig rootDir, so a static import will not typecheck.
 */
describe('root package.json forwards every server script', () => {
  const read = (p: string) =>
    JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8')) as {
      scripts: Record<string, string>;
    };

  const serverScripts = read('package.json').scripts;
  const rootScripts = read(path.join('..', 'package.json')).scripts;

  it('has a root alias for every server script', () => {
    const missing = Object.keys(serverScripts).filter((k) => !rootScripts[k]);
    expect(missing).toEqual([]);
  });

  it('passes arguments through on every script that reads argv', () => {
    // Without the trailing `--`, the root npm swallows the operator's arguments and the
    // script runs with none — silently. `db:backfill-doctype-required -- --apply` losing
    // its --apply would report a dry run as if it had committed; `db:revalidate -- CLM1`
    // losing its filter would re-validate the entire table instead of one claim. Both fail
    // by doing the wrong amount of work quietly, which is worse than not running.
    const readsArgv = [
      'db:revalidate',
      'db:backfill-doctype-required',
      'db:sync-spell-terms',
      'qa:diagnostics',
      'qa:qr-debug',
    ];
    for (const name of readsArgv) {
      expect(serverScripts[name]).toBeDefined(); // guards against a rename orphaning the list
      expect(rootScripts[name]).toMatch(/--workspace=server --$/);
    }
  });
});
