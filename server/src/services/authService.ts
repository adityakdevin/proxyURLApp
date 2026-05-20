import { PrismaClient } from '@prisma/client';
import {
  hashPassword,
  verifyPassword,
  validatePasswordPolicy,
  shouldLockAccount,
  calculateUnlockTime,
  calculateLockoutDelay,
  isAccountLocked,
} from '../utils/password.js';
import { SessionService, SessionData } from './sessionService.js';

export interface LoginResult {
  success: boolean;
  user?: SessionData;
  sessionToken?: string;
  error?: string;
  retryAfter?: number; // milliseconds until retry allowed
}

export class AuthService {
  private sessionService: SessionService;

  constructor(private prisma: PrismaClient) {
    this.sessionService = new SessionService(prisma);
  }

  async login(
    username: string,
    password: string,
    ipAddress?: string,
    userAgent?: string
  ): Promise<LoginResult> {
    // Find user by username
    const user = await this.prisma.user.findUnique({
      where: { username },
      include: {
        assignments: true,
      },
    });

    if (!user) {
      return { success: false, error: 'Invalid username or password' };
    }

    // Check if user is active
    if (user.status !== 'ACTIVE') {
      return { success: false, error: 'Account is inactive' };
    }

    // Check if account is locked
    if (isAccountLocked(user.lockedUntil)) {
      const retryAfter = user.lockedUntil
        ? user.lockedUntil.getTime() - Date.now()
        : 0;
      return {
        success: false,
        error: 'Account is locked. Please try again later.',
        retryAfter,
      };
    }

    // Check progressive delay
    const delay = calculateLockoutDelay(user.failedAttempts);
    if (delay > 0 && user.failedAttempts > 0) {
      // This is handled client-side, but we can enforce it here too
    }

    // Verify password
    const passwordValid = await verifyPassword(password, user.passwordHash);

    if (!passwordValid) {
      // Increment failed attempts
      const newFailedAttempts = user.failedAttempts + 1;
      const updates: { failedAttempts: number; lockedUntil?: Date } = {
        failedAttempts: newFailedAttempts,
      };

      // Lock account if threshold reached
      if (shouldLockAccount(newFailedAttempts)) {
        updates.lockedUntil = calculateUnlockTime();
      }

      await this.prisma.user.update({
        where: { id: user.id },
        data: updates,
      });

      const retryAfter = calculateLockoutDelay(newFailedAttempts);
      return {
        success: false,
        error: 'Invalid username or password',
        retryAfter,
      };
    }

    // Reset failed attempts on successful login
    if (user.failedAttempts > 0 || user.lockedUntil) {
      await this.prisma.user.update({
        where: { id: user.id },
        data: {
          failedAttempts: 0,
          lockedUntil: null,
        },
      });
    }

    // Create session
    const session = await this.sessionService.createSession(
      user.id,
      ipAddress,
      userAgent
    );

    const assignment = user.assignments[0];

    return {
      success: true,
      sessionToken: session.sessionToken,
      user: {
        userId: user.id,
        username: user.username,
        fullName: user.fullName,
        role: user.role,
        forcePasswordChange: user.forcePasswordChange,
        userTypeId: assignment?.userTypeId,
        projectTypeId: assignment?.projectTypeId,
      },
    };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.sessionService.deleteSession(sessionToken);
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string
  ): Promise<{ success: boolean; error?: string }> {
    // Validate new password policy
    const validation = validatePasswordPolicy(newPassword);
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }

    // Get user
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      return { success: false, error: 'User not found' };
    }

    // Verify current password
    const passwordValid = await verifyPassword(currentPassword, user.passwordHash);
    if (!passwordValid) {
      return { success: false, error: 'Current password is incorrect' };
    }

    // Hash new password
    const newPasswordHash = await hashPassword(newPassword);

    // Update password and clear force password change flag
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: newPasswordHash,
        forcePasswordChange: false,
      },
    });

    // Invalidate all sessions (per SPEC: password change invalidates all sessions)
    await this.sessionService.deleteUserSessions(userId);

    return { success: true };
  }

  async validateSession(sessionToken: string): Promise<SessionData | null> {
    return this.sessionService.validateSession(sessionToken);
  }

  getSessionService(): SessionService {
    return this.sessionService;
  }
}
