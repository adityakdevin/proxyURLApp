import { PrismaClient, Prisma, Role } from '@prisma/client';
import crypto from 'crypto';

// Get Session type from Prisma
type Session = Prisma.SessionGetPayload<{}>;

/**
 * Idle timeout: how long a session survives with NO requests on it. Refreshed on every
 * validated request, and the cookie is re-issued to match, so an actively worked session
 * never expires under someone mid-task. Eight hours covers a working day — the old 30
 * minutes was chosen when the cookie's own lifetime was a hardcoded 30 minutes from LOGIN,
 * which logged active users out regardless of what they were doing.
 */
export const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS || '28800000', 10);

/**
 * How many sessions one account may hold at once. Concurrent logins are allowed — a
 * reviewer works from a desktop and a laptop, and staff share an account — but not without
 * a ceiling: an unlimited count means a leaked password can be used from anywhere with
 * nothing on the Sessions page to notice. Past the cap the LEAST recently active session is
 * evicted, so the device someone actually stopped using is the one that goes.
 */
export const SESSION_MAX_PER_USER = parseInt(process.env.SESSION_MAX_PER_USER || '3', 10);

export interface SessionData {
  userId: string;
  username: string;
  fullName: string;
  role: Role;
  forcePasswordChange: boolean;
  projectId?: string;
  impersonatedBy?: string;
}

export class SessionService {
  constructor(private prisma: PrismaClient) {}

  // Generate cryptographically secure session token
  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Create a session, making room for it first.
   *
   * Concurrent sessions per account are allowed up to SESSION_MAX_PER_USER; the single
   * session rule this replaces meant a second device silently signed the first one out,
   * which two people sharing a login experienced as being logged out at random.
   *
   * Impersonation stays EXCLUSIVE in both directions. An impersonated session and an
   * ordinary one running at the same time makes "who was acting" ambiguous, and that
   * question is the entire reason impersonation is audited.
   */
  async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    impersonatedBy?: string
  ): Promise<Session> {
    if (impersonatedBy) {
      await this.prisma.session.deleteMany({ where: { userId } });
    } else {
      // Any impersonation in flight ends here for the same reason.
      await this.prisma.session.deleteMany({ where: { userId, impersonatedBy: { not: null } } });
      // Evict the least recently active sessions down to cap-1, leaving room for this one.
      // Selected by id rather than a raw skip so a session started concurrently cannot shift
      // the window and leave the account one over the cap.
      const existing = await this.prisma.session.findMany({
        where: { userId },
        orderBy: { lastActivity: 'desc' },
        select: { id: true },
      });
      const evict = existing.slice(Math.max(0, SESSION_MAX_PER_USER - 1)).map((s) => s.id);
      if (evict.length) {
        await this.prisma.session.deleteMany({ where: { id: { in: evict } } });
      }
    }

    // Create new session
    const session = await this.prisma.session.create({
      data: {
        userId,
        sessionToken: this.generateSessionToken(),
        ipAddress,
        userAgent,
        impersonatedBy,
        lastActivity: new Date(),
      },
    });

    return session;
  }

  // Validate session and return user data
  async validateSession(sessionToken: string): Promise<SessionData | null> {
    const session = await this.prisma.session.findUnique({
      where: { sessionToken },
      include: {
        user: {
          include: {
            assignments: true,
          },
        },
      },
    });

    if (!session) {
      return null;
    }

    // Check if session has expired (idle timeout)
    const now = new Date();
    const lastActivity = new Date(session.lastActivity);
    const idleTime = now.getTime() - lastActivity.getTime();

    if (idleTime > SESSION_MAX_AGE_MS) {
      // Session expired, delete it
      await this.prisma.session.delete({ where: { id: session.id } });
      return null;
    }

    // Check if user is active
    if (session.user.status !== 'ACTIVE') {
      await this.prisma.session.delete({ where: { id: session.id } });
      return null;
    }

    // Check if Project is active (if user has assignment)
    const assignment = session.user.assignments[0];
    if (assignment) {
      const project = await this.prisma.project.findUnique({
        where: { id: assignment.projectId },
      });

      if (project?.status !== 'ACTIVE') {
        await this.prisma.session.delete({ where: { id: session.id } });
        return null;
      }
    }

    // Update last activity
    await this.prisma.session.update({
      where: { id: session.id },
      data: { lastActivity: new Date() },
    });

    return {
      userId: session.user.id,
      username: session.user.username,
      fullName: session.user.fullName,
      role: session.user.role,
      forcePasswordChange: session.user.forcePasswordChange,
      projectId: assignment?.projectId,
      impersonatedBy: session.impersonatedBy || undefined,
    };
  }

  // Delete session (logout)
  async deleteSession(sessionToken: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: { sessionToken },
    });
  }

  // Delete all sessions for a user
  async deleteUserSessions(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: { userId },
    });
  }

  // Delete sessions for all users with a specific Project
  async deleteSessionsByProject(projectId: string): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        assignments: {
          some: { projectId },
        },
      },
      select: { id: true },
    });

    const userIds = users.map((u) => u.id);
    await this.prisma.session.deleteMany({
      where: { userId: { in: userIds } },
    });
  }

  // Get all active sessions (for admin view)
  async getActiveSessions() {
    return this.prisma.session.findMany({
      include: {
        user: {
          select: {
            id: true,
            username: true,
            fullName: true,
            role: true,
          },
        },
      },
      orderBy: { lastActivity: 'desc' },
    });
  }

  // Terminate a specific session by ID
  async terminateSession(sessionId: string): Promise<void> {
    await this.prisma.session.delete({
      where: { id: sessionId },
    });
  }
}
