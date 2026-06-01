import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'Admin123!';
  const rounds = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);

  const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;
  if (!passwordRegex.test(password)) {
    throw new Error('Admin password fails policy: 8+ chars with upper/lower/number');
  }

  const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
  if (!admin) {
    throw new Error('No admin user found. Run `npm run db:seed` first.');
  }

  const passwordHash = await bcrypt.hash(password, rounds);

  await prisma.user.update({
    where: { id: admin.id },
    data: {
      passwordHash,
      status: 'ACTIVE',
      failedAttempts: 0,
      lockedUntil: null,
      forcePasswordChange: false,
    },
  });

  await prisma.session.deleteMany({ where: { userId: admin.id } });

  console.log(`Admin password reset for "${admin.username}".`);
  console.log(`  Username: ${username}`);
  console.log(`  Password: ${password}`);
}

main()
  .catch((e) => {
    console.error('Reset failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
