import path from 'path';

export interface DirectoryEntry {
  /** Basename of the entry — the Claim ID is sliced from this. */
  name: string;
  /** Path parts relative to the scan root, used to rebuild the stored Windows path. */
  relSegments: string[];
  isDirectory: boolean;
}

export interface ScanListOptions {
  /** 1-based start of the Claim-ID slice (from the rule) — used to qualify folder names. */
  startPosition: number;
  /** Length of the Claim-ID slice (from the rule). */
  length: number;
  /** Max levels below the scan root to descend. FOLDER target only. */
  maxDepth: number;
}

export interface DirectoryReader {
  /**
   * Enumerates Claim candidates under `absolutePath`.
   * - FILE: loose files directly under the location (non-recursive).
   * - FOLDER: recurses (depth-capped). A folder whose name is long enough for the rule
   *   is a claim (its direct files become that claim's documents); a file is its own
   *   claim only when its parent folder is NOT a claim-folder (loose / bucket files).
   */
  list(absolutePath: string, target: 'FOLDER' | 'FILE', opts?: ScanListOptions): Promise<DirectoryEntry[]>;
}

/**
 * In production the stored `scanLocation` (e.g. "D:\\Claims\\Daily") is read as-is.
 * In macOS dev those paths don't exist; set CLAIMS_SCAN_ROOT to a local folder and
 * the drive-letter prefix is stripped and re-rooted under it so a real reader works.
 */
export function resolveScanRoot(scanLocation: string): string {
  const override = process.env.CLAIMS_SCAN_ROOT;
  if (!override) return scanLocation;
  const withoutDrive = scanLocation.replace(/^[A-Za-z]:\\?/, '').replace(/\\/g, '/');
  return path.join(override, withoutDrive);
}
