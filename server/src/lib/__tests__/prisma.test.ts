import os from 'node:os';
import { inspect } from 'node:util';
import { mariadbConfigFromUrl, createPrisma } from '../prisma.js';

describe('mariadbConfigFromUrl', () => {
  it('maps a Prisma-5 style URL to Prisma-5 pool behaviour', () => {
    expect(mariadbConfigFromUrl('mysql://app:p%40ss%23w0rd@127.0.0.1:3307/proxyapp_qa')).toMatchObject({
      host: '127.0.0.1',
      port: 3307,
      user: 'app',
      password: 'p@ss#w0rd',
      database: 'proxyapp_qa',
      connectTimeout: 5_000,
      idleTimeout: 300,
      allowPublicKeyRetrieval: true,
      connectionLimit: os.availableParallelism() + 1,
    });
  });

  it('defaults the port to 3306', () => {
    expect(mariadbConfigFromUrl('mysql://root@localhost/db').port).toBe(3306);
  });

  it('honours connection_limit like Prisma 5 did', () => {
    expect(mariadbConfigFromUrl('mysql://u:p@h/db?connection_limit=7').connectionLimit).toBe(7);
  });

  // Node's ERR_INVALID_URL keeps the whole input, password included, and index.ts builds the
  // client at import time, so the uncaught error printed it to the PM2 log.
  it('does not echo the URL when it fails to parse', () => {
    let err: unknown;
    try {
      mariadbConfigFromUrl('mysql://u:pa/ss@127.0.0.1:3306/db');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(inspect(err)).not.toContain('pa/ss');
  });

  // The public key comes over the unencrypted connection, so a man in the middle could swap
  // it and read the password. Only trust it when the database is on this host.
  it.each([
    ['localhost', true],
    ['127.0.0.1', true],
    ['[::1]', true],
    ['db.internal', false],
    ['10.0.0.5', false],
  ])('allows public key retrieval for %s: %s', (host, allowed) => {
    expect(mariadbConfigFromUrl(`mysql://u:p@${host}:3306/db`).allowPublicKeyRetrieval).toBe(allowed);
  });
});

describe('createPrisma', () => {
  it('refuses to build a client without a database URL', () => {
    expect(() => createPrisma('')).toThrow('DATABASE_URL is not set');
  });
});
