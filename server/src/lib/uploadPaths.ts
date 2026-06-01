import path from 'path';

export function uploadsRoot(): string {
  return process.env.UPLOADS_ROOT || path.join(process.cwd(), 'uploads');
}

export function claimUploadDir(claimId: string): string {
  return path.join(uploadsRoot(), claimId);
}
