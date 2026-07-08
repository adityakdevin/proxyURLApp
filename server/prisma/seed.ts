import { PrismaClient, RuleField, RuleOperator } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const adminUsername = process.env.ADMIN_USERNAME || 'admin';
  const adminPassword = process.env.ADMIN_PASSWORD || 'Admin123!';
  const adminFullName = process.env.ADMIN_FULLNAME || 'System Administrator';
  const bcryptRounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

  // Validate password policy
  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  if (!passwordRegex.test(adminPassword)) {
    throw new Error(
      'Admin password must be at least 8 characters with uppercase, lowercase, and number'
    );
  }

  console.log('Seeding database...');

  // Ensure admin exists
  let admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) {
    const passwordHash = await bcrypt.hash(adminPassword, bcryptRounds);
    admin = await prisma.user.create({
      data: {
        username: adminUsername,
        passwordHash,
        fullName: adminFullName,
        role: 'ADMIN',
        status: 'ACTIVE',
        forcePasswordChange: true,
      },
    });
    console.log(`Admin user created: ${admin.username}`);
  } else {
    console.log(`Admin user already exists: ${admin.username}`);
  }

  // Default settings (idempotent)
  await prisma.setting.upsert({
    where: { key: 'audit_retention_days' },
    update: {},
    create: { key: 'audit_retention_days', value: '90' },
  });

  const STANDARD_STATUSES = [
    { name: 'New', displayOrder: 1, isDefault: true, isTerminal: false },
    { name: 'In Progress', displayOrder: 2, isDefault: false, isTerminal: false },
    { name: 'Verified', displayOrder: 3, isDefault: false, isTerminal: false },
    { name: 'Closed', displayOrder: 4, isDefault: false, isTerminal: true },
  ];
  // Statuses are global (not per-SubCategory). Seed the standard set once.
  const hasDefault = await prisma.statusMaster.findFirst({ where: { isDefault: true } });
  if (!hasDefault) {
    await prisma.statusMaster.createMany({
      data: STANDARD_STATUSES.map((s) => ({
        ...s,
        createdBy: admin.id,
        updatedBy: admin.id,
      })),
    });
  }
  const activeSubs = await prisma.subCategory.findMany({ where: { status: 'ACTIVE' } });

  // Claim rules: the canonical global set (one predicate per RuleField),
  // dev-managed here. Source of truth mirrors seedDemo.ts.
  const CLAIM_RULES: {
    name: string;
    field: RuleField;
    operator: RuleOperator;
    value: string;
    displayOrder: number;
  }[] = [
    { name: 'At least one document', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1', displayOrder: 1 },
    { name: 'Has a remark logged', field: 'REMARK_COUNT', operator: 'GTE', value: '1', displayOrder: 2 },
    { name: 'Must be assigned', field: 'ASSIGNED', operator: 'EQ', value: 'true', displayOrder: 3 },
    { name: 'Invoice attached', field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Invoice', displayOrder: 4 },
    { name: 'Work has started (not New)', field: 'WORKFLOW_STATUS', operator: 'NEQ', value: 'New', displayOrder: 5 },
    { name: 'Spell check passed', field: 'SPELL_STATUS', operator: 'EQ', value: 'PASSED', displayOrder: 6 },
    { name: 'QR check passed', field: 'QR_STATUS', operator: 'EQ', value: 'PASSED', displayOrder: 7 },
    { name: 'Metadata check passed', field: 'META_STATUS', operator: 'EQ', value: 'PASSED', displayOrder: 8 },
    { name: 'Intra-claim consistency passed', field: 'INTRA_STATUS', operator: 'EQ', value: 'PASSED', displayOrder: 9 },
    { name: 'Full scan passed', field: 'FULL_STATUS', operator: 'EQ', value: 'PASSED', displayOrder: 10 },
  ];
  // Claim rules are global (not per-SubCategory). Seed the canonical set once.
  const hasRules = await prisma.claimRule.findFirst();
  if (!hasRules) {
    await prisma.claimRule.createMany({
      data: CLAIM_RULES.map((r) => ({
        ...r,
        createdBy: admin.id,
        updatedBy: admin.id,
      })),
    });
  }

  const sampleSub = activeSubs[0];
  if (sampleSub) {
    const defaultStatus = await prisma.statusMaster.findFirst({
      where: { isDefault: true },
    });

    // Document types are global (not per-SubCategory).
    const docTypeExists = await prisma.documentTypeMaster.findFirst();
    if (!docTypeExists) {
      await prisma.documentTypeMaster.createMany({
        data: [
          {
            name: 'Aadhar Card',
            category: 'GOVT',
            govtCode: 'AADHAR',
            displayOrder: 1,
            createdBy: admin.id,
            updatedBy: admin.id,
          },
          {
            name: 'PAN Card',
            category: 'GOVT',
            govtCode: 'PAN',
            displayOrder: 2,
            createdBy: admin.id,
            updatedBy: admin.id,
          },
          {
            name: 'Bill',
            category: 'CUSTOM',
            displayOrder: 3,
            createdBy: admin.id,
            updatedBy: admin.id,
          },
        ],
      });
    }

    const ruleExists = await prisma.claimIdRule.findUnique({
      where: { subCategoryId: sampleSub.id },
    });
    if (!ruleExists) {
      await prisma.claimIdRule.create({
        data: {
          subCategoryId: sampleSub.id,
          startPosition: 1,
          length: 8,
          scanTarget: 'FOLDER',
          scanLocation: 'D:\\Claims\\Daily',
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
    }

    for (const claimId of ['CLM00001', 'CLM00002']) {
      const exists = await prisma.claim.findUnique({
        where: { claimId_subCategoryId: { claimId, subCategoryId: sampleSub.id } },
      });
      if (!exists) {
        await prisma.claim.create({
          data: {
            claimId,
            subCategoryId: sampleSub.id,
            workflowStatusId: defaultStatus!.id,
            createdBy: admin.id,
            updatedBy: admin.id,
          },
        });
      }
    }
    console.log(`Phase 1 claims sample data ensured under SubCategory "${sampleSub.name}".`);
  } else {
    console.log('No active SubCategory found. Skipping Phase 1 claims sample data.');
  }

  console.log('Seed completed successfully!');
  console.log(`\nAdmin credentials:`);
  console.log(`  Username: ${adminUsername}`);
  console.log(`  Password: ${adminPassword}`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
