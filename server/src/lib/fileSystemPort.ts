export interface FileEntry {
  name: string;
  sizeBytes: number;
}

export interface PathStat {
  exists: boolean;
  isDirectory: boolean;
  isFile: boolean;
  sizeBytes: number;
}

export interface FileSystemPort {
  stat(absolutePath: string): Promise<PathStat>;
  /** Immediate child files only (no directories, no recursion). */
  listFiles(absolutePath: string): Promise<FileEntry[]>;
}
