import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { FsFileSystemPort } from '../fsFileSystemPort.js';

describe('FsFileSystemPort', () => {
  let dir: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docs-'));
    await fs.writeFile(path.join(dir, 'a.pdf'), 'abc');
    await fs.writeFile(path.join(dir, 'b.png'), 'de');
    await fs.mkdir(path.join(dir, 'sub'));
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('stat reports a directory', async () => {
    const s = await new FsFileSystemPort().stat(dir);
    expect(s).toMatchObject({ exists: true, isDirectory: true, isFile: false });
  });

  it('stat reports a missing path as not existing', async () => {
    const s = await new FsFileSystemPort().stat(path.join(dir, 'nope'));
    expect(s.exists).toBe(false);
  });

  it('listFiles returns only files with sizes (no subdirs)', async () => {
    const files = (await new FsFileSystemPort().listFiles(dir)).sort((x, y) =>
      x.name.localeCompare(y.name)
    );
    expect(files.map((f) => f.name)).toEqual(['a.pdf', 'b.png']);
    expect(files[0].sizeBytes).toBe(3);
    expect(files[1].sizeBytes).toBe(2);
  });
});
