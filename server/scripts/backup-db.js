const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in environment');
  process.exit(1);
}

// Split on the LAST "@" so a password containing "@" (e.g. "vps@1234") parses
// correctly: user is up to the first ":", host has no "@"/":"/"/", and any
// trailing "?params" on the database name is ignored.
const urlPattern = /^mysql:\/\/([^:]+):(.*)@([^:@/]+):(\d+)\/([^?]+)/;
const match = DATABASE_URL.match(urlPattern);

if (!match) {
  console.error('ERROR: Invalid DATABASE_URL format');
  console.error('Expected: mysql://user:password@host:port/database');
  process.exit(1);
}

const [, user, password, host, port, database] = match;

/**
 * Find mysqldump, rather than assuming PATH and failing at 02:00 where nobody is looking.
 *
 * On the Windows deploy box the MySQL bin folder is not on the service account's PATH, so
 * this exited ENOENT every night from 2026-08-14 with the only evidence in a pm2 log file.
 * Telling an operator to "add it to PATH" is a fix that has to be re-applied by hand on every
 * machine and after every MySQL upgrade; finding it is a fix that holds.
 *
 * Order is deliberate: an explicit setting always wins, then PATH, then the standard install
 * locations, and only then the running server — which is the slowest check but the one that
 * cannot be wrong, since mysqldump ships in the same bin folder as the mysqld that is
 * currently serving this database.
 */
function resolveMysqldump() {
  const exe = process.platform === 'win32' ? 'mysqldump.exe' : 'mysqldump';
  const works = (p) => {
    try {
      execFileSync(p, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  };

  const searched = [];

  if (process.env.MYSQLDUMP_PATH) {
    // Configured explicitly: do NOT fall through if it is wrong. Silently using some other
    // mysqldump than the one an operator named is how you back up the wrong server.
    return { path: process.env.MYSQLDUMP_PATH, how: 'MYSQLDUMP_PATH', searched };
  }

  searched.push('(PATH)');
  if (works(exe)) return { path: exe, how: 'PATH', searched };

  // Standard install roots. Globbed rather than version-pinned so a MySQL upgrade does not
  // silently re-break backups six months from now.
  const roots =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\MySQL',
          'C:\\Program Files (x86)\\MySQL',
          'C:\\ProgramData\\MySQL',
          'C:\\Program Files\\MariaDB',
          'C:\\xampp\\mysql',
          'C:\\wamp64\\bin\\mysql',
          'C:\\laragon\\bin\\mysql',
        ]
      : ['/usr/local/mysql', '/opt/homebrew/opt/mysql-client', '/usr/local/opt/mysql-client'];

  for (const root of roots) {
    let entries;
    try {
      entries = fs.existsSync(path.join(root, 'bin')) ? [''] : fs.readdirSync(root);
    } catch {
      // Record the miss rather than skipping silently. An operator reading the failure needs
      // to know this root was considered and is absent — otherwise the obvious next question
      // ("did it even look in Program Files?") has no answer in the output.
      searched.push(`${root} (not present)`);
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(root, entry, 'bin', exe);
      searched.push(candidate);
      if (fs.existsSync(candidate) && works(candidate)) {
        return { path: candidate, how: 'standard install location', searched };
      }
    }
  }

  // Last resort: ask the OS where the running mysqld lives. Slowest, and the only one that
  // is right by construction on a box with a non-standard install.
  try {
    const cmd =
      process.platform === 'win32'
        ? [
            'powershell',
            [
              '-NoProfile',
              '-Command',
              "(Get-Process mysqld -ErrorAction SilentlyContinue | Select-Object -First 1).Path",
            ],
          ]
        : ['sh', ['-c', 'ps -o comm= -C mysqld 2>/dev/null | head -1']];
    const mysqld = execFileSync(cmd[0], cmd[1], { encoding: 'utf8' }).trim();
    searched.push(`(alongside running mysqld${mysqld ? `: ${mysqld}` : ', not found'})`);
    if (mysqld) {
      const candidate = path.join(path.dirname(mysqld), exe);
      if (fs.existsSync(candidate) && works(candidate)) {
        return { path: candidate, how: 'alongside the running mysqld', searched };
      }
    }
  } catch {
    /* no shell, no mysqld, or not permitted — fall through to the reported failure */
  }

  return { path: exe, how: 'not found', searched };
}

const resolved = resolveMysqldump();
const MYSQLDUMP = resolved.path;

// Create backups directory with date-wise subfolder
const now = new Date();
const dateFolder = now.toISOString().slice(0, 10); // YYYY-MM-DD
const backupDir = path.join(__dirname, '..', '..', 'backups', dateFolder);
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// Generate backup filename with timestamp
const time = now.toTimeString().slice(0, 8).replace(/:/g, '-'); // HH-MM-SS
const backupFile = path.join(backupDir, `${database}_${time}.sql`);

console.log(`Starting backup of database: ${database}`);
console.log(`Backup file: ${backupFile}`);
console.log(
  resolved.how === 'not found'
    ? `mysqldump: NOT FOUND on this machine — this run will fail, see below`
    : `mysqldump: ${MYSQLDUMP} (found via ${resolved.how})`
);

/**
 * Backed up as structure only — schema kept, rows dropped.
 *
 * These are TABLE names, and must stay TABLE names. They read "Session" and "AuditLog" —
 * the Prisma MODEL names — while schema.prisma maps those models to `sessions` and
 * `audit_logs`. Two different failures came out of that one mistake: `--ignore-table` named
 * a table that does not exist and so quietly excluded nothing, and the `--no-data` pass named
 * them as dump targets and died outright with `Couldn't find table: "Session"`.
 *
 * The second is why this script has produced no output since the tables were mapped. The
 * newest backup on the dev box is dated 2026-01-10 and contains ten tables, none of them
 * claims — it predates the entire feature. "Backups have been failing since 2026-08-14" was
 * generous by about seven months.
 */
const structureOnlyTables = ['sessions', 'audit_logs'];

try {
  // Base connection args
  const baseArgs = ['-h', host, '-P', port, '-u', user];
  if (password) {
    baseArgs.push(`--password=${password}`);
  }

  // Step 1: Backup all tables except structure-only tables
  const dataArgs = [
    ...baseArgs,
    '--routines',
    '--triggers',
    '--single-transaction',
    ...structureOnlyTables.map(t => `--ignore-table=${database}.${t}`),
    database
  ];

  const dataOutput = execFileSync(MYSQLDUMP, dataArgs, {
    maxBuffer: 1024 * 1024 * 100
  });

  // Step 2: Backup structure only for Session and AuditLog
  const structureArgs = [
    ...baseArgs,
    '--no-data',
    database,
    ...structureOnlyTables
  ];

  const structureOutput = execFileSync(MYSQLDUMP, structureArgs, {
    maxBuffer: 1024 * 1024 * 10
  });

  // Combine outputs
  const output = Buffer.concat([dataOutput, structureOutput]);

  // Write to file
  fs.writeFileSync(backupFile, output);

  // Verify before claiming success, and BEFORE the retention sweep below deletes older
  // folders. mysqldump can exit 0 having written a truncated dump (killed mid-stream, disk
  // full, connection dropped), and a half-written .sql is worse than none: it looks like a
  // backup in the folder listing and only fails when it is restored, which is the one moment
  // nobody can afford it. mysqldump ends a complete dump with this trailer, so its absence
  // means the stream did not finish.
  const written = fs.readFileSync(backupFile, 'utf8');
  const tail = written.slice(-200);
  if (!/-- Dump completed/.test(tail)) {
    throw new Error(
      `dump is incomplete — "-- Dump completed" trailer missing from ${backupFile} ` +
        `(${written.length} bytes written). Treating as a FAILED backup; the file is kept for ` +
        'inspection but must not be trusted as a restore point.'
    );
  }
  // The exclusion has to be checked, not trusted. `--ignore-table` naming a table that does
  // not exist is silently accepted by mysqldump — that is exactly how `Session` excluded
  // nothing for months without a single warning. The `--no-data` pass fails loudly on a bad
  // name, so only this half can rot quietly; assert on the output instead of the flag.
  const leaked = structureOnlyTables.filter((t) =>
    new RegExp(`INSERT INTO \`${t}\``).test(written)
  );
  if (leaked.length) {
    throw new Error(
      `dump contains row data for ${leaked.join(', ')}, which must be structure-only. ` +
        'The --ignore-table names no longer match the real table names (check @@map in ' +
        'schema.prisma). The file is kept but contains data it should not.'
    );
  }
  const sizeMb = fs.statSync(backupFile).size / 1024 / 1024;

  console.log(`(Excluded data: ${structureOnlyTables.join(', ')})`);

  console.log(`Backup completed successfully!`);
  console.log(`File size: ${sizeMb.toFixed(2)} MB`);

  // Clear the failure marker only now — after a dump that was verified complete. Clearing it
  // on any run that merely reached this far would let one good night erase the record of a
  // week of bad ones.
  const failedMarker = path.join(__dirname, '..', '..', 'backups', 'LAST_BACKUP_FAILED.txt');
  if (fs.existsSync(failedMarker)) {
    fs.unlinkSync(failedMarker);
    console.log('Cleared LAST_BACKUP_FAILED.txt — previous failure is resolved.');
  }

  const rootBackupDir = path.join(__dirname, '..', '..', 'backups');
  const folders = fs.readdirSync(rootBackupDir)
    .filter(f => /^\d{4}-\d{2}-\d{2}$/.test(f)) // Only date folders
    .map(f => ({ name: f, path: path.join(rootBackupDir, f) }))
    .sort((a, b) => b.name.localeCompare(a.name)); // Sort by date desc

  if (folders.length > 7) {
    folders.slice(7).forEach(folder => {
      // Delete all files in folder then the folder
      fs.readdirSync(folder.path).forEach(file => {
        fs.unlinkSync(path.join(folder.path, file));
      });
      fs.rmdirSync(folder.path);
      console.log(`Deleted old backup folder: ${folder.name}`);
    });
  }

} catch (error) {
  console.error('Backup failed:', error.message);
  if (error.code === 'ENOENT') {
    if (resolved.how === 'MYSQLDUMP_PATH') {
      // No search happened — an explicit setting is used verbatim and never fallen back
      // from. Printing an empty "looked in" list here reads as "searched nowhere", which is
      // true and useless; naming the setting is the actionable half.
      console.error(
        `\n"${MYSQLDUMP}" was not found, and it came from MYSQLDUMP_PATH in server/.env.\n` +
          'Correct or remove that setting — with it removed, this script searches PATH and the\n' +
          'standard install locations itself.'
      );
    } else {
      console.error(`\n"${MYSQLDUMP}" was not found. Looked in, in order:`);
      for (const p of resolved.searched) console.error(`    ${p}`);
    }
    console.error(
      `\nIf mysqldump is installed somewhere else, set MYSQLDUMP_PATH in server/.env to its\n` +
        `full path and this will use it verbatim, e.g.\n` +
        `  MYSQLDUMP_PATH="C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysqldump.exe"\n\n` +
        `If it is installed NOWHERE, the MySQL client tools are missing from this machine and\n` +
        `no amount of configuration will help — install them (MySQL Installer > "MySQL Server"\n` +
        `or the standalone "MySQL Shell"/client package). The database server running on this\n` +
        `box does not imply the client tools are present; they are a separate component.`
    );
  }
  // A failed backup that leaves nothing behind is how this went two days unnoticed: the only
  // evidence was a pm2 log nobody opens, and the backups folder simply stopped gaining files
  // — which looks identical to "no backup was due". Leave the reason where someone looking
  // for a backup will actually find it.
  try {
    const rootBackupDir = path.join(__dirname, '..', '..', 'backups');
    fs.mkdirSync(rootBackupDir, { recursive: true });
    fs.writeFileSync(
      path.join(rootBackupDir, 'LAST_BACKUP_FAILED.txt'),
      `${now.toISOString()}  ${database}\n${error.message}\n\n` +
        `This file is written when a backup fails and deleted when one succeeds.\n` +
        `If it is present, the newest .sql in this folder is older than it looks.\n`
    );
  } catch {
    /* if even this cannot be written, the console + non-zero exit are all that is left */
  }
  process.exit(1);
}
