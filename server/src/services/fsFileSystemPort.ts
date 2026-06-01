import { promises as fs } from 'fs';
import path from 'path';
import { FileSystemPort, FileEntry, PathStat } from '../lib/fileSystemPort.js';

export class FsFileSystemPort implements FileSystemPort {
  async stat(absolutePath: string): Promise<PathStat> {
    try {
      const s = await fs.stat(absolutePath);
      return { exists: true, isDirectory: s.isDirectory(), isFile: s.isFile(), sizeBytes: s.size };
    } catch {
      return { exists: false, isDirectory: false, isFile: false, sizeBytes: 0 };
    }
  }

  async listFiles(absolutePath: string): Promise<FileEntry[]> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    const files = dirents.filter((d) => d.isFile());
    return Promise.all(
      files.map(async (d) => ({
        name: d.name,
        sizeBytes: (await fs.stat(path.join(absolutePath, d.name))).size,
      }))
    );
  }
}
