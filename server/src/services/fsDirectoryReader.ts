import { promises as fs } from 'fs';
import path from 'path';
import {
  DirectoryReader,
  DirectoryEntry,
  ScanListOptions,
} from '../lib/directoryReader.js';

export class FsDirectoryReader implements DirectoryReader {
  async list(
    absolutePath: string,
    target: 'FOLDER' | 'FILE',
    opts?: ScanListOptions
  ): Promise<DirectoryEntry[]> {
    if (target === 'FILE') {
      // Flat: loose files directly under the location (non-recursive).
      const dirents = await fs.readdir(absolutePath, { withFileTypes: true });
      return dirents
        .filter((d) => d.isFile())
        .map((d) => ({ name: d.name, relSegments: [d.name], isDirectory: false }));
    }

    // FOLDER: recurse (depth-capped). A folder whose name is long enough to yield the
    // Claim ID is a claim; a file is its own claim only when its parent isn't a claim
    // (so files inside a claim-folder stay that claim's documents, not separate claims).
    const start = (opts?.startPosition ?? 1) - 1;
    const length = opts?.length ?? 0;
    const maxDepth = opts?.maxDepth ?? 5;
    const qualifies = (n: string) =>
      n.length >= start + length && n.substring(start, start + length).trim().length > 0;

    const out: DirectoryEntry[] = [];
    // depth 0 = immediate children of the scan root. Symlinked dirs report
    // isDirectory() === false with withFileTypes, so loops can't be followed.
    const walk = async (dir: string, relSegs: string[], depth: number, parentIsClaim: boolean) => {
      if (depth > maxDepth) return;
      const dirents = await fs.readdir(dir, { withFileTypes: true });
      for (const d of dirents) {
        const segs = [...relSegs, d.name];
        if (d.isDirectory()) {
          const isClaim = qualifies(d.name);
          if (isClaim) out.push({ name: d.name, relSegments: segs, isDirectory: true });
          await walk(path.join(dir, d.name), segs, depth + 1, isClaim);
        } else if (d.isFile() && !parentIsClaim) {
          out.push({ name: d.name, relSegments: segs, isDirectory: false });
        }
      }
    };
    await walk(absolutePath, [], 0, false);
    return out;
  }
}
