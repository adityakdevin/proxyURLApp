import { PrismaClient } from '@prisma/client';

// App factory (routes + middleware, no listen/sweeps)
import { createApp } from './app.js';

// Services (startup sweeps + graceful shutdown)
import { getHeadlessManager } from './services/headlessManager.js';
import { ScanService } from './services/scanService.js';
import { FsDirectoryReader } from './services/fsDirectoryReader.js';
import { ValidationService } from './services/validationService.js';
import { kickDrain } from './services/validationQueue.js';
import { registry as validatorRegistry } from './validators/registry.js';

const prisma = new PrismaClient();
const app = createApp(prisma);
const PORT = process.env.PORT || 3001;

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
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
    .then((n) => {
      if (n > 0) console.log(`Swept ${n} stale validation run(s) to FAILED on startup.`);
    })
    .catch((e) => console.error('Validation stale-run sweep failed:', e))
    .finally(() => kickDrain(prisma, validatorRegistry));
});

export { app, prisma };
