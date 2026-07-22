import { promises as fs } from 'fs';
import { DirectoryReader, DirectoryEntry } from '../lib/directoryReader.js';

export class FsDirectoryReader implements DirectoryReader {
  async list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    // FILE = loose files only. FOLDER = sub-folders AND loose files, so a location
    // holding a mix (folder-per-claim plus stray files-as-claims) is scanned fully.
    return dirents
      .filter((d) => (target === 'FILE' ? d.isFile() : d.isDirectory() || d.isFile()))
      .map((d) => ({ name: d.name }));
  }
}
