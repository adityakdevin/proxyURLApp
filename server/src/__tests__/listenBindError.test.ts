import net from 'net';
import path from 'path';
import { spawn } from 'child_process';

// Value: protects=a server that cannot bind its port exits 1 with the FATAL line, never logging "Server running" or running the startup sweeps; fails_when=the listen callback stops ignoring the bind error Express 5 now passes it; why_new=no test started index.ts; seam=none; no_claim=the HTTPS listener, the sweeps themselves
describe('server startup on a port that is already in use', () => {
  let blocker: net.Server;
  let port: number;

  beforeAll(async () => {
    blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, resolve));
    port = (blocker.address() as net.AddressInfo).port;
  });

  afterAll(() => new Promise<void>((resolve) => blocker.close(() => resolve())));

  it('exits 1 naming the port, and does not start', async () => {
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: path.join(__dirname, '..', '..'),
      env: {
        ...process.env,
        PORT: String(port),
        // Set, so server/.env cannot supply them: no HTTPS listener, and a database
        // nothing listens on, so even a regressed startup sweep reaches no real data.
        HTTPS_KEY: '',
        HTTPS_CERT: '',
        DATABASE_URL: 'mysql://nobody@127.0.0.1:9/none',
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const code = await new Promise<number | null>((resolve) => child.on('exit', resolve));

    expect(code).toBe(1);
    expect(stderr).toContain(`FATAL: port ${port} is already in use`);
    expect(stdout).not.toContain('Server running');
  });
});
