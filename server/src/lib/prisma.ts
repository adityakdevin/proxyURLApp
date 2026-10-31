import os from 'node:os';
import path from 'node:path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { PrismaMariaDb } from '@prisma/adapter-mariadb';
import type { PoolConfig } from 'mariadb';

// Prisma 5 loaded server/.env as a side effect of importing @prisma/client, and the server
// relied on that for SESSION_SECRET, CLIENT_URL and the rest. Prisma 7 does not, so this
// module does it instead; index.ts imports it first. Resolves to server/.env from both
// src/lib and dist/lib. Variables already set (e.g. by the shell) are never overridden.
dotenv.config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Translate a Prisma-style `mysql://` URL into mariadb pool options that behave like
 * Prisma 5's built-in pool. Only `connection_limit` is honoured; any other search
 * parameter is reported and ignored.
 */
export function mariadbConfigFromUrl(url: string): PoolConfig {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    // Not rethrown as-is: Node's error carries the whole URL, password included.
    throw new Error('DATABASE_URL is not a valid URL (percent-encode special characters in the user and password)');
  }
  const limit = u.searchParams.get('connection_limit');
  const ignored = [...u.searchParams.keys()].filter((k) => k !== 'connection_limit');
  if (ignored.length) {
    console.warn(`DATABASE_URL parameters ignored by the MariaDB adapter: ${ignored.join(', ')}`);
  }
  return {
    host: u.hostname,
    port: Number(u.port) || 3306,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1)) || undefined,
    // Prisma 5 defaults: 5 s to connect, idle connections closed after 300 s (seconds here).
    connectTimeout: 5_000,
    idleTimeout: 300,
    // MySQL 8+ caching_sha2_password over a non-TLS connection needs the server's public
    // key. Fetched unencrypted, so a man in the middle could swap it and read the password:
    // only trusted when the database is on this host, as every one is today.
    allowPublicKeyRetrieval: LOOPBACK_HOSTS.has(u.hostname),
    // ponytail: Prisma 5 used physical CPUs x 2 + 1; logical CPUs + 1 approximates that on
    // SMT hardware. Set connection_limit in DATABASE_URL to pin an exact size.
    connectionLimit: limit ? Number(limit) : os.availableParallelism() + 1,
  };
}

/** A PrismaClient on the MariaDB driver adapter. Throws when no URL is configured. */
export function createPrisma(url: string | undefined = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaMariaDb(mariadbConfigFromUrl(url)) });
}
