import { PrismaClient, Prisma, Role } from '@prisma/client';
import crypto from 'crypto';

// Get Session type from Prisma
type Session = Prisma.SessionGetPayload<{}>;

const SESSION_MAX_AGE_MS = parseInt(process.env.SESSION_MAX_AGE_MS || '1800000', 10); // 30 minutes

export interface SessionData {
  userId: string;
  username: string;
  fullName: string;
  role: Role;
  forcePasswordChange: boolean;
  userTypeId?: string;
  projectTypeId?: string;
  impersonatedBy?: string;
}

export class SessionService {
  constructor(private prisma: PrismaClient) {}

  // Generate cryptographically secure session token
  generateSessionToken(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  // Create new session (invalidates any existing session for the user - single session rule)
  async createSession(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    impersonatedBy?: string
  ): Promise<Session> {
    // Delete any existing sessions for this user (single session enforcement)
    await this.prisma.session.deleteMany({
      where: { userId },
    });

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

    // Check if User Type and Project Type are active (if user has assignment)
    const assignment = session.user.assignments[0];
    if (assignment) {
      const userType = await this.prisma.userType.findUnique({
        where: { id: assignment.userTypeId },
      });
      const projectType = await this.prisma.projectType.findUnique({
        where: { id: assignment.projectTypeId },
      });

      if (userType?.status !== 'ACTIVE' || projectType?.status !== 'ACTIVE') {
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
      userTypeId: assignment?.userTypeId,
      projectTypeId: assignment?.projectTypeId,
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

  // Delete sessions for all users with a specific User Type
  async deleteSessionsByUserType(userTypeId: string): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        assignments: {
          some: { userTypeId },
        },
      },
      select: { id: true },
    });

    const userIds = users.map((u) => u.id);
    await this.prisma.session.deleteMany({
      where: { userId: { in: userIds } },
    });
  }

  // Delete sessions for all users with a specific Project Type
  async deleteSessionsByProjectType(projectTypeId: string): Promise<void> {
    const users = await this.prisma.user.findMany({
      where: {
        assignments: {
          some: { projectTypeId },
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
