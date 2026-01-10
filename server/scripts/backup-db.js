const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not found in environment');
  process.exit(1);
}

const urlPattern = /mysql:\/\/([^:]+):([^@]*)@([^:]+):(\d+)\/(.+)/;
const match = DATABASE_URL.match(urlPattern);

if (!match) {
  console.error('ERROR: Invalid DATABASE_URL format');
  console.error('Expected: mysql://user:password@host:port/database');
  process.exit(1);
}

const [, user, password, host, port, database] = match;

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

try {
  const args = [
    '-h', host,
    '-P', port,
    '-u', user,
  ];

  if (password) {
    args.push(`--password=${password}`);
  }

  args.push(
    '--routines',
    '--triggers',
    '--single-transaction',
    database
  );

  const output = execFileSync('mysqldump', args, {
    maxBuffer: 1024 * 1024 * 100 // 100MB buffer
  });

  // Write to file
  fs.writeFileSync(backupFile, output);

  console.log(`Backup completed successfully!`);
  console.log(`File size: ${(fs.statSync(backupFile).size / 1024 / 1024).toFixed(2)} MB`);

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
  process.exit(1);
}
