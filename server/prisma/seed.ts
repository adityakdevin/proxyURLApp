import { PrismaClient } from '@prisma/client';
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

  // Phase 1 Claims sample data — attach to first ACTIVE SubCategory if no default status yet
  const sampleSub = await prisma.subCategory.findFirst({ where: { status: 'ACTIVE' } });
  if (sampleSub) {
    const existingDefault = await prisma.statusMaster.findFirst({
      where: { subCategoryId: sampleSub.id, isDefault: true },
    });
    if (!existingDefault) {
      const pending = await prisma.statusMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'Pending',
          displayOrder: 1,
          isDefault: true,
          isTerminal: false,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      await prisma.statusMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'Approved',
          displayOrder: 2,
          isTerminal: true,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      await prisma.statusMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'Rejected',
          displayOrder: 3,
          isTerminal: true,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });

      await prisma.documentTypeMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'Aadhar Card',
          category: 'GOVT',
          govtCode: 'AADHAR',
          displayOrder: 1,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      await prisma.documentTypeMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'PAN Card',
          category: 'GOVT',
          govtCode: 'PAN',
          displayOrder: 2,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      await prisma.documentTypeMaster.create({
        data: {
          subCategoryId: sampleSub.id,
          name: 'Bill',
          category: 'CUSTOM',
          displayOrder: 3,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });

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

      await prisma.claim.create({
        data: {
          claimId: 'CLM00001',
          subCategoryId: sampleSub.id,
          workflowStatusId: pending.id,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      await prisma.claim.create({
        data: {
          claimId: 'CLM00002',
          subCategoryId: sampleSub.id,
          workflowStatusId: pending.id,
          createdBy: admin.id,
          updatedBy: admin.id,
        },
      });
      console.log(`Phase 1 claims sample data seeded under SubCategory "${sampleSub.name}".`);
    } else {
      console.log('Claims sample data already present. Skipping.');
    }
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
