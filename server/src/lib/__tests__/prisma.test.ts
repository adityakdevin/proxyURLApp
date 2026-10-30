import os from 'node:os';
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
});

describe('createPrisma', () => {
  it('refuses to build a client without a database URL', () => {
    expect(() => createPrisma('')).toThrow('DATABASE_URL is not set');
  });
});
