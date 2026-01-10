import bcrypt from 'bcrypt';

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

// Password policy: Min 8 chars, uppercase, lowercase, number
const PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export function validatePasswordPolicy(password: string): { valid: boolean; error?: string } {
  if (!password || password.length < 8) {
    return { valid: false, error: 'Password must be at least 8 characters' };
  }

  if (!PASSWORD_REGEX.test(password)) {
    return {
      valid: false,
      error: 'Password must contain at least one uppercase letter, one lowercase letter, and one number',
    };
  }

  return { valid: true };
}

// Progressive delay calculation for failed login attempts
// 1s, 2s, 4s, 8s, 16s... up to max
export function calculateLockoutDelay(failedAttempts: number): number {
  if (failedAttempts === 0) return 0;
  const delay = Math.pow(2, failedAttempts - 1) * 1000; // in milliseconds
  const maxDelay = 15 * 60 * 1000; // 15 minutes max
  return Math.min(delay, maxDelay);
}

// Check if account should be locked (5 failed attempts)
export function shouldLockAccount(failedAttempts: number): boolean {
  return failedAttempts >= 5;
}

// Calculate unlock time (15 minutes from now)
export function calculateUnlockTime(): Date {
  return new Date(Date.now() + 15 * 60 * 1000);
}

// Check if account is currently locked
export function isAccountLocked(lockedUntil: Date | null): boolean {
  if (!lockedUntil) return false;
  return new Date() < lockedUntil;
}
