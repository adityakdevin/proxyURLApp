import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FsDirectoryReader } from '../fsDirectoryReader.js';

describe('FsDirectoryReader', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'scan-'));
    await fs.mkdir(path.join(dir, 'CLM00001_folder'));
    await fs.mkdir(path.join(dir, 'CLM00002_folder'));
    await fs.writeFile(path.join(dir, 'CLM00003_file.pdf'), 'x');
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('lists both directories and files for FOLDER target', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FOLDER')).map((e) => e.name).sort();
    expect(names).toEqual(['CLM00001_folder', 'CLM00002_folder', 'CLM00003_file.pdf']);
  });

  it('lists only files for FILE target', async () => {
    const names = (await new FsDirectoryReader().list(dir, 'FILE')).map((e) => e.name);
    expect(names).toEqual(['CLM00003_file.pdf']);
  });
});
