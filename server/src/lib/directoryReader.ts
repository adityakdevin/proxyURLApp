import path from 'path';

export interface DirectoryEntry {
  name: string;
}

export interface DirectoryReader {
  /** Lists the immediate children of `absolutePath` matching the scan target. */
  list(absolutePath: string, target: 'FOLDER' | 'FILE'): Promise<DirectoryEntry[]>;
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
