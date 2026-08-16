import fs from 'node:fs';
import https from 'node:https';
import { PrismaClient } from '@prisma/client';

// App factory (routes + middleware, no listen/sweeps)
import { createApp } from './app.js';

// Services (startup sweeps + graceful shutdown)
import { getHeadlessManager } from './services/headlessManager.js';
import { ScanService } from './services/scanService.js';
import { FsDirectoryReader } from './services/fsDirectoryReader.js';
import { ValidationService } from './services/validationService.js';
import { enqueue, kickDrain } from './services/validationQueue.js';
import { registry as validatorRegistry } from './validators/registry.js';

const prisma = new PrismaClient();
const app = createApp(prisma);
const PORT = process.env.PORT || 3001;
const HTTPS_PORT = process.env.HTTPS_PORT || 443;

// Safety net for fire-and-forget background jobs (scan runner, validation
// drainer): log stray rejections instead of letting them terminate the process.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  try {
    const headlessManager = getHeadlessManager();
    await headlessManager.shutdown();
  } catch (e) {
    console.error('Error shutting down HeadlessManager:', e);
  }
  await prisma.$disconnect();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  try {
    const headlessManager = getHeadlessManager();
    await headlessManager.shutdown();
  } catch (e) {
    console.error('Error shutting down HeadlessManager:', e);
  }
  await prisma.$disconnect();
  process.exit(0);
});

function runStartupSweeps() {
  // Fail any scan jobs orphaned by a previous shutdown (in-process runner).
  new ScanService(prisma, new FsDirectoryReader())
    .sweepStaleJobs()
    .then((n) => {
      if (n > 0) console.log(`Swept ${n} stale scan job(s) to FAILED on startup.`);
    })
    .catch((e) => console.error('Stale scan-job sweep failed:', e));

  // Fail orphaned validation runs (also resets stranded claim columns), then
  // resume QUEUED runs. kickDrain runs in finally so a sweep failure can't block it.
  new ValidationService(prisma, validatorRegistry)
    .sweepStaleRuns()
    .then(async ({ count, claimIds }) => {
      if (count > 0) {
        console.log(`Swept ${count} stale validation run(s) to FAILED on startup.`);
      }
      // Re-queue what the sweep just blanked. The sweep resets the claim's five columns to
      // PENDING, which discards its findings — so without this a claim that happened to be
      // mid-run during a restart comes back with empty check tabs and NOTHING scheduled to
      // refill them, and stays that way until a human notices. Queue each one individually
      // so a single bad claim cannot stop the rest from recovering.
      for (const claimId of claimIds) {
        try {
          await enqueue(prisma, validatorRegistry, claimId, 'AUTO');
        } catch (e) {
          console.error(`Could not re-queue interrupted claim ${claimId}:`, e);
        }
      }
      if (claimIds.length > 0) {
        console.log(`Re-queued ${claimIds.length} claim(s) interrupted by the restart.`);
      }
    })
    .catch((e) => console.error('Validation stale-run sweep failed:', e))
    .finally(() => kickDrain(prisma, validatorRegistry));
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  runStartupSweeps(); // once, regardless of whether HTTPS is also enabled
});

// Optional in-app TLS: enabled when HTTPS_KEY + HTTPS_CERT point at readable PEM
// files. Shares the same Express app; PM2 supervises this process, so HTTPS
// survives reboot without a separate reverse proxy. HTTP stays up alongside.
const httpsKey = process.env.HTTPS_KEY;
const httpsCert = process.env.HTTPS_CERT;
if (httpsKey && httpsCert) {
  if (fs.existsSync(httpsKey) && fs.existsSync(httpsCert)) {
    https
      .createServer({ key: fs.readFileSync(httpsKey), cert: fs.readFileSync(httpsCert) }, app)
      .listen(HTTPS_PORT, () => console.log(`HTTPS server running on port ${HTTPS_PORT}`));
  } else {
    // Don't crash-loop under PM2 if certs are misconfigured — log and stay HTTP-only.
    console.error(`HTTPS disabled: cert files not found (${httpsKey}, ${httpsCert})`);
  }
}

export { app, prisma };
