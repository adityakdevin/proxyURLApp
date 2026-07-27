const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.txt': 'text/plain',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

export function mimeTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return 'application/octet-stream';
  return MIME[fileName.slice(dot).toLowerCase()] ?? 'application/octet-stream';
}

/** Extensions accepted on upload — the same set we know how to type/serve. */
export const ALLOWED_UPLOAD_EXTENSIONS = new Set(Object.keys(MIME));

/** True if the filename has a recognised, allowed extension. */
export function isAllowedUploadName(fileName: string): boolean {
  const dot = fileName.lastIndexOf('.');
  if (dot < 0) return false;
  return ALLOWED_UPLOAD_EXTENSIONS.has(fileName.slice(dot).toLowerCase());
}

export function isInline(mime: string): boolean {
  return mime === 'application/pdf' || mime.startsWith('image/');
}
