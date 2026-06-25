/**
 * DEMO SEED — end-to-end test data for ProxyURLApp.
 *
 * Run with:   npm run db:seed:demo   (from repo root or the /server workspace)
 *
 * Designed to be run against a SEPARATE test database (point server/.env
 * DATABASE_URL at your test DB before running). It is fully idempotent: every
 * row is created via upsert / find-or-create guards, so you can run it as many
 * times as you like without duplicate-key errors or duplicated data.
 *
 * What it creates (a complete, navigable hierarchy):
 *   • 3 login accounts, one per role  (admin / team lead / regular user)
 *   • 1 UserType  + 1 ProjectType     (the access "scope")
 *   • 1 Category  + 1 SubCategory      bound to that scope
 *   • Workflow statuses                New → In Progress → Verified → Closed
 *   • Document types, a Claim-ID Rule, claim Rules, and 2 proxy menu URLs
 *   • 5 sample Claims across mixed workflow + validation states, with remarks
 *
 * Demo login credentials (also printed at the end of the run):
 *   admin     / Admin@123   (ADMIN)
 *   teamlead  / Lead@1234   (TEAM_LEAD)
 *   user      / User@1234   (USER)
 */
import { PrismaClient, ValidationStatus } from '@prisma/client';
import bcrypt from 'bcrypt';

const prisma = new PrismaClient();
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const PASSWORD_POLICY = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}$/;

const DEMO_USERS = [
  { username: 'admin', password: 'Admin@123', fullName: 'Demo Administrator', role: 'ADMIN' as const },
  { username: 'teamlead', password: 'Lead@1234', fullName: 'Demo Team Lead', role: 'TEAM_LEAD' as const },
  { username: 'user', password: 'User@1234', fullName: 'Demo End User', role: 'USER' as const },
];

async function hash(pw: string): Promise<string> {
  if (!PASSWORD_POLICY.test(pw)) {
    throw new Error(`Demo password "${pw}" violates the password policy (8+ chars, upper, lower, number).`);
  }
  return bcrypt.hash(pw, BCRYPT_ROUNDS);
}

async function main() {
  console.log('Seeding DEMO data...\n');

  // ── 1. Users (one per role) ────────────────────────────────────────────────
  // forcePasswordChange=false so you can log straight in for testing.
  const users: Record<string, { id: string }> = {};
  for (const u of DEMO_USERS) {
    const passwordHash = await hash(u.password);
    const created = await prisma.user.upsert({
      where: { username: u.username },
      update: { fullName: u.fullName, role: u.role, status: 'ACTIVE', forcePasswordChange: false },
      create: {
        username: u.username,
        passwordHash,
        fullName: u.fullName,
        role: u.role,
        status: 'ACTIVE',
        forcePasswordChange: false,
      },
    });
    users[u.role] = { id: created.id };
    console.log(`  user ensured: ${u.username.padEnd(9)} (${u.role})`);
  }
  const adminId = users.ADMIN.id;
  const audit = { createdBy: adminId, updatedBy: adminId };

  // ── 2. Access scope: UserType + ProjectType ────────────────────────────────
  const userType = await prisma.userType.upsert({
    where: { name: 'Claims Officer' },
    update: {},
    create: { name: 'Claims Officer', description: 'Demo user type for claim handling', ...audit },
  });
  const projectType = await prisma.projectType.upsert({
    where: { name: 'FY2025' },
    update: {},
    create: { name: 'FY2025', description: 'Demo project / financial year', ...audit },
  });
  console.log(`  scope ensured: ${userType.name} / ${projectType.name}`);

  // ── 3. Assign Team Lead + User (and Admin) to the scope ─────────────────────
  for (const role of ['ADMIN', 'TEAM_LEAD', 'USER'] as const) {
    await prisma.userAssignment.upsert({
      where: { userId: users[role].id },
      update: { userTypeId: userType.id, projectTypeId: projectType.id },
      create: { userId: users[role].id, userTypeId: userType.id, projectTypeId: projectType.id },
    });
  }
  console.log('  assignments ensured for admin, teamlead, user');

  // ── 4. Category → SubCategory ──────────────────────────────────────────────
  const category = await prisma.category.upsert({
    where: {
      name_userTypeId_projectTypeId: {
        name: 'Vehicle Claims',
        userTypeId: userType.id,
        projectTypeId: projectType.id,
      },
    },
    update: {},
    create: {
      name: 'Vehicle Claims',
      description: 'Demo category bound to Claims Officer / FY2025',
      userTypeId: userType.id,
      projectTypeId: projectType.id,
      ...audit,
    },
  });
  const subCategory = await prisma.subCategory.upsert({
    where: { name_categoryId: { name: 'Warranty Claims', categoryId: category.id } },
    update: {},
    create: {
      name: 'Warranty Claims',
      description: 'Demo sub-category (inherits the parent scope)',
      categoryId: category.id,
      ...audit,
    },
  });
  console.log(`  category/sub-category ensured: ${category.name} → ${subCategory.name}`);

  // ── 5. Workflow statuses: New → In Progress → Verified → Closed ─────────────
  const statusDefs = [
    { name: 'New', displayOrder: 1, isDefault: true, isTerminal: false },
    { name: 'In Progress', displayOrder: 2, isDefault: false, isTerminal: false },
    { name: 'Verified', displayOrder: 3, isDefault: false, isTerminal: false },
    { name: 'Closed', displayOrder: 4, isDefault: false, isTerminal: true },
  ];
  const status: Record<string, { id: string }> = {};
  for (const s of statusDefs) {
    const row = await prisma.statusMaster.upsert({
      where: { name_subCategoryId: { name: s.name, subCategoryId: subCategory.id } },
      update: { displayOrder: s.displayOrder, isDefault: s.isDefault, isTerminal: s.isTerminal },
      create: { subCategoryId: subCategory.id, ...s, ...audit },
    });
    status[s.name] = { id: row.id };
  }
  console.log('  statuses ensured: New (default) → In Progress → Verified → Closed (terminal)');

  // ── 6. Document types ──────────────────────────────────────────────────────
  const docTypes: { name: string; category: 'GOVT' | 'CUSTOM'; govtCode?: 'AADHAR' | 'PAN'; order: number }[] = [
    { name: 'Aadhar Card', category: 'GOVT', govtCode: 'AADHAR', order: 1 },
    { name: 'PAN Card', category: 'GOVT', govtCode: 'PAN', order: 2 },
    { name: 'Invoice', category: 'CUSTOM', order: 3 },
  ];
  for (const d of docTypes) {
    await prisma.documentTypeMaster.upsert({
      where: { name_subCategoryId: { name: d.name, subCategoryId: subCategory.id } },
      update: {},
      create: {
        subCategoryId: subCategory.id,
        name: d.name,
        category: d.category,
        govtCode: d.govtCode,
        displayOrder: d.order,
        ...audit,
      },
    });
  }
  console.log('  document types ensured: Aadhar Card, PAN Card, Invoice');

  // ── 7. Claim-ID Rule (substring extraction during folder scans) ────────────
  await prisma.claimIdRule.upsert({
    where: { subCategoryId: subCategory.id },
    update: {},
    create: {
      subCategoryId: subCategory.id,
      startPosition: 1,
      length: 8,
      scanTarget: 'FOLDER',
      scanLocation: 'D:\\Claims\\Daily',
      ...audit,
    },
  });
  console.log('  claim-id rule ensured: start 1, length 8, FOLDER names, D:\\Claims\\Daily');

  // ── 8. Claim Rules (the checklist shown on the claim detail page) ──────────
  const claimRules: { name: string; field: any; operator: any; value: string; order: number }[] = [
    { name: 'At least one document', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1', order: 1 },
    { name: 'Must be assigned', field: 'ASSIGNED', operator: 'EQ', value: 'true', order: 2 },
    { name: 'Spell check passed', field: 'SPELL_STATUS', operator: 'EQ', value: 'PASSED', order: 3 },
  ];
  for (const r of claimRules) {
    const exists = await prisma.claimRule.findFirst({
      where: { subCategoryId: subCategory.id, name: r.name },
    });
    if (!exists) {
      await prisma.claimRule.create({
        data: {
          subCategoryId: subCategory.id,
          name: r.name,
          field: r.field,
          operator: r.operator,
          value: r.value,
          displayOrder: r.order,
          ...audit,
        },
      });
    }
  }
  console.log('  claim rules ensured: document count, assigned, spell passed');

  // ── 9. Proxy menu URLs (Category → SubCategory → URL) ──────────────────────
  const urls = [
    { label: 'Vehicle Lookup Portal', targetUrl: 'https://example.com/vehicle-lookup' },
    { label: 'Dealer Directory', targetUrl: 'https://example.com/dealers' },
  ];
  for (const u of urls) {
    const exists = await prisma.urlConfiguration.findFirst({
      where: { label: u.label, subCategoryId: subCategory.id },
    });
    if (!exists) {
      await prisma.urlConfiguration.create({
        data: {
          label: u.label,
          description: `Demo proxied URL: ${u.label}`,
          targetUrl: u.targetUrl,
          userTypeId: userType.id,
          projectTypeId: projectType.id,
          categoryId: category.id,
          subCategoryId: subCategory.id,
          ...audit,
        },
      });
    }
  }
  console.log('  proxy URLs ensured: Vehicle Lookup Portal, Dealer Directory');

  // ── 10. Sample claims across mixed workflow + validation states ────────────
  const P = ValidationStatus.PENDING;
  const IP = ValidationStatus.IN_PROGRESS;
  const PASS = ValidationStatus.PASSED;
  const FAIL = ValidationStatus.FAILED;

  type Demo = {
    claimId: string;
    statusName: string;
    assignTo?: string; // role key
    v: [ValidationStatus, ValidationStatus, ValidationStatus, ValidationStatus, ValidationStatus]; // spell, qr, meta, intra, full
    folderPath?: string;
    dealerName?: string;
    dealerCode?: string;
    vinNo?: string;
    customerName?: string;
    schemeType?: string;
    observationRemarks?: string;
    remark?: { text: string; by: string; from?: string; to?: string };
  };

  const demoClaims: Demo[] = [
    {
      claimId: 'CLM10001',
      statusName: 'New',
      v: [P, P, P, P, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10001',
      dealerName: 'Sunrise Motors',
      dealerCode: 'DLR001',
      vinNo: 'MAJWXY1234567890',
      customerName: 'Rahul Sharma',
      schemeType: 'Extended Warranty',
    },
    {
      claimId: 'CLM10002',
      statusName: 'In Progress',
      assignTo: 'USER',
      v: [PASS, PASS, PASS, IP, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10002',
      dealerName: 'Sunrise Motors',
      dealerCode: 'DLR001',
      vinNo: 'MAJWXY2234567890',
      customerName: 'Priya Patel',
      schemeType: 'Service Scheme',
      remark: { text: 'Picked up for review, documents look complete.', by: 'USER', from: 'New', to: 'In Progress' },
    },
    {
      claimId: 'CLM10003',
      statusName: 'Verified',
      assignTo: 'USER',
      v: [PASS, PASS, PASS, PASS, PASS],
      folderPath: 'D:\\Claims\\Daily\\CLM10003',
      dealerName: 'Highway Auto',
      dealerCode: 'DLR002',
      vinNo: 'MAJWXY3334567890',
      customerName: 'Amit Verma',
      schemeType: 'Extended Warranty',
      remark: { text: 'All checks passed. Marked as verified.', by: 'USER', from: 'In Progress', to: 'Verified' },
    },
    {
      claimId: 'CLM10004',
      statusName: 'In Progress',
      assignTo: 'TEAM_LEAD',
      v: [PASS, FAIL, PASS, FAIL, FAIL],
      folderPath: 'D:\\Claims\\Daily\\CLM10004',
      dealerName: 'Metro Cars',
      dealerCode: 'DLR003',
      vinNo: 'MAJWXY4434567890',
      customerName: 'Sneha Iyer',
      schemeType: 'Loyalty Scheme',
      observationRemarks: 'QR code does not decode; suspected forged invoice.',
      remark: { text: 'QR and consistency checks failed — escalating for manual inspection.', by: 'TEAM_LEAD', from: 'New', to: 'In Progress' },
    },
    {
      claimId: 'CLM10005',
      statusName: 'Closed',
      assignTo: 'USER',
      v: [PASS, PASS, PASS, PASS, PASS],
      folderPath: 'D:\\Claims\\Daily\\CLM10005',
      dealerName: 'Highway Auto',
      dealerCode: 'DLR002',
      vinNo: 'MAJWXY5534567890',
      customerName: 'Vikram Singh',
      schemeType: 'Service Scheme',
      remark: { text: 'Claim approved and closed.', by: 'USER', from: 'Verified', to: 'Closed' },
    },
  ];

  for (const c of demoClaims) {
    const claim = await prisma.claim.upsert({
      where: { claimId_subCategoryId: { claimId: c.claimId, subCategoryId: subCategory.id } },
      update: {
        workflowStatusId: status[c.statusName].id,
        assignedToUserId: c.assignTo ? users[c.assignTo].id : null,
        spellCheckStatus: c.v[0],
        qrStatus: c.v[1],
        metaExtractionStatus: c.v[2],
        intraClaimStatus: c.v[3],
        fullScanStatus: c.v[4],
        ...audit,
      },
      create: {
        claimId: c.claimId,
        subCategoryId: subCategory.id,
        workflowStatusId: status[c.statusName].id,
        assignedToUserId: c.assignTo ? users[c.assignTo].id : null,
        folderPath: c.folderPath,
        dealerName: c.dealerName,
        dealerCode: c.dealerCode,
        vinNo: c.vinNo,
        customerName: c.customerName,
        schemeType: c.schemeType,
        observationRemarks: c.observationRemarks,
        spellCheckStatus: c.v[0],
        qrStatus: c.v[1],
        metaExtractionStatus: c.v[2],
        intraClaimStatus: c.v[3],
        fullScanStatus: c.v[4],
        ...audit,
      },
    });

    if (c.remark) {
      const already = await prisma.claimRemark.findFirst({ where: { claimId: claim.id } });
      if (!already) {
        await prisma.claimRemark.create({
          data: {
            claimId: claim.id,
            userId: users[c.remark.by].id,
            remarkText: c.remark.text,
            statusBeforeId: c.remark.from ? status[c.remark.from].id : null,
            statusAfterId: c.remark.to ? status[c.remark.to].id : null,
          },
        });
      }
    }
  }
  console.log(`  ${demoClaims.length} sample claims ensured (mixed workflow + validation states)`);

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\nDEMO seed completed successfully!\n');
  console.log('Login at the app URL with any of these accounts:');
  console.table(DEMO_USERS.map((u) => ({ Role: u.role, Username: u.username, Password: u.password })));
}

main()
  .catch((e) => {
    console.error('Demo seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
