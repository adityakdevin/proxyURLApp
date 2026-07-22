import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FsDirectoryReader } from '../fsDirectoryReader.js';

// Claim ID = first 8 chars of the name.
const OPTS = { startPosition: 1, length: 8, maxDepth: 5 };

describe('FsDirectoryReader', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    // A claim-folder (long enough name) with two docs inside.
    await fs.mkdir(path.join(dir, 'CLM00001_folder'));
    await fs.writeFile(path.join(dir, 'CLM00001_folder', 'front.pdf'), 'x');
    await fs.writeFile(path.join(dir, 'CLM00001_folder', 'back.pdf'), 'x');
    // A loose file directly under the root.
    await fs.writeFile(path.join(dir, 'CLM00003_file.pdf'), 'x');
    // A short "bucket" folder (name too short to be a claim) holding a loose file.
    await fs.mkdir(path.join(dir, 'batch'));
    await fs.writeFile(path.join(dir, 'batch', 'CLM00009_nested.pdf'), 'x');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists only files for FILE target (non-recursive)', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FILE', OPTS)).map((e) => e.name);
    expect(names).toEqual(['CLM00003_file.pdf']);
  });

  it('FOLDER: claim-folders + loose files, skipping docs inside claim-folders', async () => {
    const entries = await new FsDirectoryReader().list(dir, 'FOLDER', OPTS);
    const names = entries.map((e) => e.name).sort();
    // CLM00001_folder = claim; its front.pdf/back.pdf are its docs (NOT claims).
    // CLM00003_file.pdf = loose claim. batch = bucket (too short, not a claim), but its
    // nested file IS a loose claim.
    expect(names).toEqual(['CLM00001_folder', 'CLM00003_file.pdf', 'CLM00009_nested.pdf']);
    // Nested loose file carries its relative segments so the stored path can be rebuilt.
    const nested = entries.find((e) => e.name === 'CLM00009_nested.pdf');
    expect(nested?.relSegments).toEqual(['batch', 'CLM00009_nested.pdf']);
  });

  it('FOLDER: maxDepth stops the descent', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FOLDER', { ...OPTS, maxDepth: 0 }))
      .map((e) => e.name)
      .sort();
    // Depth 0 = root children only: the claim-folder and the loose root file. The file
    // inside `batch` sits one level down and is not reached.
    expect(names).toEqual(['CLM00001_folder', 'CLM00003_file.pdf']);
  });
});
