import { PrismaClient, Role } from '@prisma/client';
import { hashPassword } from '../../../utils/password.js';

/**
 * Self-contained fixture builder for the claim e2e suites.
 *
 * Seeds a complete access graph so the HTTP layer (auth → scope → role guards →
 * service → DB) can be exercised end-to-end without depending on `db:seed`:
 *
 *   Project  ──┐
 *              ├─ Category ─ SubCategory ─ (StatusMaster, Claims)
 *   (a second, disjoint project) ─┘  used for OUT_OF_SCOPE assertions
 *
 *   Users: admin (scope ALL), teamLead + user (assigned to the in-scope project),
 *          otherTeamLead (assigned to the disjoint project).
 *
 * All four users share TEST_PASSWORD and have forcePasswordChange=false so they
 * pass the password-change gate. Names carry a per-suite random suffix to keep
 * suites isolated even though they share one database.
 */
export const TEST_PASSWORD = 'Passw0rd!23';

export interface SeededUser {
  id: string;
  username: string;
  role: Role;
}

export interface ScopeGraph {
  suffix: string;
  projectId: string;
  categoryId: string;
  subCategoryId: string;
  otherProjectId: string;
  otherCategoryId: string;
  otherSubCategoryId: string;
  admin: SeededUser;
  teamLead: SeededUser;
  user: SeededUser;
  otherTeamLead: SeededUser;
}

function rand(): string {
  return Math.random().toString(36).slice(2, 8);
}

export async function seedScopeGraph(prisma: PrismaClient, label: string): Promise<ScopeGraph> {
  const suffix = `${label}-${rand()}`;
  const passwordHash = await hashPassword(TEST_PASSWORD);

  // In-scope project
  const project = await prisma.project.create({ data: { name: `PT-${suffix}` } });
  const category = await prisma.category.create({
    data: { name: `Cat-${suffix}`, projectId: project.id },
  });
  const subCategory = await prisma.subCategory.create({
    data: { name: `Sub-${suffix}`, categoryId: category.id },
  });

  // Disjoint project (for OUT_OF_SCOPE)
  const otherProject = await prisma.project.create({ data: { name: `PT2-${suffix}` } });
  const otherCategory = await prisma.category.create({
    data: { name: `Cat2-${suffix}`, projectId: otherProject.id },
  });
  const otherSubCategory = await prisma.subCategory.create({
    data: { name: `Sub2-${suffix}`, categoryId: otherCategory.id },
  });

  const mkUser = async (uname: string, role: Role) =>
    prisma.user.create({
      data: {
        username: uname,
        passwordHash,
        fullName: uname,
        role,
        status: 'ACTIVE',
        forcePasswordChange: false,
      },
    });

  const admin = await mkUser(`admin-${suffix}`, 'ADMIN');
  const teamLead = await mkUser(`tl-${suffix}`, 'TEAM_LEAD');
  const user = await mkUser(`user-${suffix}`, 'USER');
  const otherTeamLead = await mkUser(`tl2-${suffix}`, 'TEAM_LEAD');

  await prisma.userAssignment.create({
    data: { userId: teamLead.id, projectId: project.id },
  });
  await prisma.userAssignment.create({
    data: { userId: user.id, projectId: project.id },
  });
  await prisma.userAssignment.create({
    data: {
      userId: otherTeamLead.id,
      projectId: otherProject.id,
    },
  });

  const pick = (u: { id: string; username: string; role: Role }): SeededUser => ({
    id: u.id,
    username: u.username,
    role: u.role,
  });

  return {
    suffix,
    projectId: project.id,
    categoryId: category.id,
    subCategoryId: subCategory.id,
    otherProjectId: otherProject.id,
    otherCategoryId: otherCategory.id,
    otherSubCategoryId: otherSubCategory.id,
    admin: pick(admin),
    teamLead: pick(teamLead),
    user: pick(user),
    otherTeamLead: pick(otherTeamLead),
  };
}

/**
 * Seed the default + a terminal workflow status for a SubCategory and return
 * their ids. Claim tables are truncated between tests, so call this per-test
 * (or in beforeEach) for whichever sub-categories a test needs.
 */
export async function seedStatuses(
  prisma: PrismaClient,
  subCategoryId: string,
  createdBy: string,
  names: { def?: string; terminal?: string } = {}
): Promise<{ defaultId: string; terminalId: string }> {
  const def = await prisma.statusMaster.create({
    data: { subCategoryId, name: names.def ?? 'Pending', isDefault: true, displayOrder: 0, createdBy },
  });
  const terminal = await prisma.statusMaster.create({
    data: {
      subCategoryId,
      name: names.terminal ?? 'Approved',
      isTerminal: true,
      displayOrder: 1,
      createdBy,
    },
  });
  return { defaultId: def.id, terminalId: terminal.id };
}

/**
 * Tear down everything seedScopeGraph created. Claim-scoped rows (claims,
 * remarks, statuses, doc types, id-rules) are removed by truncateClaimsTables in
 * the suite's afterAll; here we also clear claimRule (not covered by truncate)
 * and the access graph itself, in FK-safe order.
 */
export async function cleanupScopeGraph(prisma: PrismaClient, g: ScopeGraph): Promise<void> {
  const subCategoryIds = [g.subCategoryId, g.otherSubCategoryId];
  const userIds = [g.admin.id, g.teamLead.id, g.user.id, g.otherTeamLead.id];

  await prisma.claimRule.deleteMany({ where: { subCategoryId: { in: subCategoryIds } } });
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userAssignment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.subCategory.deleteMany({ where: { id: { in: subCategoryIds } } });
  await prisma.category.deleteMany({ where: { id: { in: [g.categoryId, g.otherCategoryId] } } });
  await prisma.project.deleteMany({
    where: { id: { in: [g.projectId, g.otherProjectId] } },
  });
}
