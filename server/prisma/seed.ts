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

  // Check if admin already exists
  const existingAdmin = await prisma.user.findFirst({
    where: { isAdmin: true },
  });

  if (existingAdmin) {
    console.log('Admin user already exists. Skipping seed.');
    return;
  }

  // Hash password
  const passwordHash = await bcrypt.hash(adminPassword, bcryptRounds);

  // Create admin user
  const admin = await prisma.user.create({
    data: {
      username: adminUsername,
      passwordHash,
      fullName: adminFullName,
      isAdmin: true,
      status: 'ACTIVE',
      forcePasswordChange: true, // Force password change on first login
    },
  });

  console.log(`Admin user created: ${admin.username}`);

  // Create default settings
  await prisma.setting.upsert({
    where: { key: 'audit_retention_days' },
    update: {},
    create: {
      key: 'audit_retention_days',
      value: '90',
    },
  });

  console.log('Default settings created.');
  console.log('Seed completed successfully!');
  console.log(`\nAdmin credentials:`);
  console.log(`  Username: ${adminUsername}`);
  console.log(`  Password: ${adminPassword}`);
  console.log(`\nRemember to change the password on first login!`);
}

main()
  .catch((e) => {
    console.error('Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
