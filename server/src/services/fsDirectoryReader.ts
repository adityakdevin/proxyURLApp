import { promises as fs } from 'fs';
import { DirectoryReader, DirectoryEntry } from '../lib/directoryReader.js';

export class FsDirectoryReader implements DirectoryReader {
  async list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]> {
    const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
    return dirents
      .filter((d) => (target === 'FOLDER' ? d.isDirectory() : d.isFile()))
      .map((d) => ({ name: d.name }));
  }
}
