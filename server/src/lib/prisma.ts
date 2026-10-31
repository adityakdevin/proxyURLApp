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

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

/** Percent-decode each valid escape run; a stray "%" (new URL keeps it) stays literal, as in Prisma 5. */
const decode = (s: string) =>
  s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });

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
  const params = [...u.searchParams.keys()];
  // Prisma 5 honoured sslaccept, sslcert, sslidentity and sslpassword. Nothing here sets up TLS,
  // and dropping them with a warning would connect in plaintext to a database that asked for it.
  const tls = params.filter((k) => k.startsWith('ssl'));
  if (tls.length) {
    throw new Error(`DATABASE_URL asks for TLS (${tls.join(', ')}), which lib/prisma.ts does not configure`);
  }
  const limit = u.searchParams.get('connection_limit');
  const ignored = params.filter((k) => k !== 'connection_limit');
  if (ignored.length) {
    console.warn(`DATABASE_URL parameters ignored by the MariaDB adapter: ${ignored.join(', ')}`);
  }
  // mariadb keeps NaN, 0 or a negative limit as given, and that pool never connects (every
  // query: "pool timeout"), so anything but a positive integer is reported and not used.
  const requested = Number(limit);
  const valid = Number.isInteger(requested) && requested > 0;
  if (limit !== null && !valid) {
    console.warn(`DATABASE_URL connection_limit=${limit} ignored: not a positive integer`);
  }
  const connectionLimit = valid ? requested : os.availableParallelism() * 2 + 1;
  // mariadb unwraps "[::1]" only when it parses a URL itself; options go to net.connect as given.
  const host = u.hostname.replace(/^\[(.*)\]$/, '$1');
  return {
    host,
    port: Number(u.port) || 3306,
    user: decode(u.username),
    password: decode(u.password),
    database: decode(u.pathname.slice(1)) || undefined,
    // Prisma's v6-compatible settings: 5 s to connect, idleTimeout 300 (seconds here). mariadb
    // keeps minimumIdle = connectionLimit, so idleTimeout never actually closes a connection:
    // the pool stays full, as mariadb recommends, and its validation ping replaces any
    // connection MySQL dropped while idle.
    connectTimeout: 5_000,
    idleTimeout: 300,
    // No prepareCacheLength: the adapter's 0 (no statement cache) is deliberate. With the
    // driver's cache on, evicted statements were not reliably closed and piled up until MySQL's
    // server-wide max_prepared_stmt_count was hit (prisma/prisma#29364).
    // MySQL 8+ caching_sha2_password over a non-TLS connection needs the server's public
    // key. Fetched unencrypted, so a man in the middle could swap it and read the password:
    // only trusted when the database is on this host, as every one is today.
    allowPublicKeyRetrieval: LOOPBACK_HOSTS.has(host),
    // ponytail: Prisma 5 used physical CPUs x 2 + 1. Node only knows logical CPUs, so this
    // matches on hardware without SMT and doubles it with SMT, well inside MySQL's default 151
    // connections. Set connection_limit in DATABASE_URL to pin an exact size.
    connectionLimit,
  };
}

/** A PrismaClient on the MariaDB driver adapter. Throws when no URL is configured. */
export function createPrisma(url: string | undefined = process.env.DATABASE_URL): PrismaClient {
  if (!url) throw new Error('DATABASE_URL is not set');
  return new PrismaClient({ adapter: new PrismaMariaDb(mariadbConfigFromUrl(url)) });
}
