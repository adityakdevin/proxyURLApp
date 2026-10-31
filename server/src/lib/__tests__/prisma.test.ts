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
      connectionLimit: os.availableParallelism() * 2 + 1,
    });
  });

  it('leaves the prepared-statement cache to the adapter, which turns it off', () => {
    expect(mariadbConfigFromUrl('mysql://u:p@localhost/db')).not.toHaveProperty('prepareCacheLength');
  });

  it('defaults the port to 3306', () => {
    expect(mariadbConfigFromUrl('mysql://root@localhost/db').port).toBe(3306);
  });

  it('honours connection_limit like Prisma 5 did', () => {
    expect(mariadbConfigFromUrl('mysql://u:p@h/db?connection_limit=7').connectionLimit).toBe(7);
  });

  // mariadb keeps NaN, 0 or a negative limit as given, and that pool never opens a
  // connection: every query fails with "pool timeout". A typo must not get that far.
  it.each(['abc', '0', '-1', '2.5', ''])('reports connection_limit=%s and uses the default', (value) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { connectionLimit } = mariadbConfigFromUrl(`mysql://u:p@h/db?connection_limit=${value}`);
    expect(connectionLimit).toBe(os.availableParallelism() * 2 + 1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('connection_limit'));
    warn.mockRestore();
  });

  // Prisma 5 read pool_timeout, socket_timeout and friends from the URL; the adapter does not,
  // so a URL carried over from Prisma 5 must say what it lost rather than quietly drop it.
  // Value: protects=an unsupported DATABASE_URL option is reported, never silently dropped; fails_when=the ignored-params warning is removed or lists connection_limit; why_new=only connection_limit warnings are asserted; seam=none; no_claim=TLS support itself
  it('reports every unsupported URL parameter, and not connection_limit', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mariadbConfigFromUrl('mysql://u@h/db?socket_timeout=5&connection_limit=5&pool_timeout=10');
    expect(warn).toHaveBeenCalledTimes(1);
    const [message] = warn.mock.calls[0];
    expect(message).toEqual(expect.stringContaining('socket_timeout'));
    expect(message).toEqual(expect.stringContaining('pool_timeout'));
    expect(message).not.toEqual(expect.stringContaining('connection_limit'));
    warn.mockRestore();
  });

  // Dropping a TLS parameter with a warning would connect in plaintext to a database that
  // asked for TLS, so these stop the server instead.
  it.each(['sslaccept=strict', 'sslcert=/ca.pem'])('refuses %s rather than connect without TLS', (param) => {
    expect(() => mariadbConfigFromUrl(`mysql://u:secretpw@db.example.com/db?${param}`)).toThrow(/TLS/);
    expect(() => mariadbConfigFromUrl(`mysql://u:secretpw@db.example.com/db?${param}`)).not.toThrow(/secretpw/);
  });

  // WHATWG URL keeps the brackets ("[::1]"), and mariadb only unwraps them when it parses a
  // URL string itself; an options object goes to net.connect as given, which cannot resolve it.
  it('unwraps an IPv6 literal host', () => {
    expect(mariadbConfigFromUrl('mysql://u:p@[::1]:3306/db').host).toBe('::1');
  });

  // new URL keeps a bare "%" as is, and decodeURIComponent throws on it. Prisma 5 accepted
  // such a password; here the throw would crash the server at import with no hint why.
  it('keeps a user or password containing a bare %', () => {
    expect(mariadbConfigFromUrl('mysql://a%b:Pa%ss@127.0.0.1/db')).toMatchObject({ user: 'a%b', password: 'Pa%ss' });
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
