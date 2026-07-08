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
 *   • 1 Project     (the access "scope")
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

  // ── 2. Access scope: Project ───────────────────────────────────────────
  const project = await prisma.project.upsert({
    where: { name: 'FY2025' },
    update: {},
    create: { name: 'FY2025', description: 'Demo project / financial year', ...audit },
  });
  console.log(`  scope ensured: ${project.name}`);

  // ── 3. Assign Team Lead + User (and Admin) to the scope ─────────────────────
  for (const role of ['ADMIN', 'TEAM_LEAD', 'USER'] as const) {
    await prisma.userAssignment.upsert({
      where: { userId: users[role].id },
      update: { projectId: project.id },
      create: { userId: users[role].id, projectId: project.id },
    });
  }
  console.log('  assignments ensured for admin, teamlead, user');

  // ── 4. Category → SubCategory ──────────────────────────────────────────────
  const category = await prisma.category.upsert({
    where: {
      name_projectId: {
        name: 'Vehicle Claims',
        projectId: project.id,
      },
    },
    update: {},
    create: {
      name: 'Vehicle Claims',
      description: 'Demo category bound to FY2025',
      projectId: project.id,
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

  // ── 4b. Grant granular sub-category access (drives menu/URL + claims scope) ──
  // Admins bypass scope, so only Team Lead + User need an explicit grant.
  for (const role of ['TEAM_LEAD', 'USER'] as const) {
    await prisma.userSubCategory.upsert({
      where: {
        userId_subCategoryId: { userId: users[role].id, subCategoryId: subCategory.id },
      },
      update: {},
      create: { userId: users[role].id, subCategoryId: subCategory.id },
    });
  }
  console.log('  sub-category access granted to teamlead, user');

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
      where: { name: s.name },
      update: { displayOrder: s.displayOrder, isDefault: s.isDefault, isTerminal: s.isTerminal },
      create: { ...s, ...audit },
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
  const docTypeIds: Record<string, string> = {};
  for (const d of docTypes) {
    const row = await prisma.documentTypeMaster.upsert({
      where: { name: d.name },
      update: {},
      create: {
        name: d.name,
        category: d.category,
        govtCode: d.govtCode,
        displayOrder: d.order,
        ...audit,
      },
    });
    docTypeIds[d.name] = row.id;
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
  // One rule per RuleField so the demo exercises EVERY option in the "Field"
  // dropdown. Across the 5 sample claims these produce a full mix of pass/fail.
  //   • numeric fields (DOCUMENT_COUNT, REMARK_COUNT) accept EQ/NEQ/GTE/LTE/GT/LT
  //   • every other field accepts only EQ/NEQ
  //   • status values must match the ValidationStatus enum exactly (e.g. PASSED)
  const claimRules: { name: string; field: any; operator: any; value: string; order: number }[] = [
    { name: 'At least one document', field: 'DOCUMENT_COUNT', operator: 'GTE', value: '1', order: 1 },
    { name: 'Has a remark logged', field: 'REMARK_COUNT', operator: 'GTE', value: '1', order: 2 },
    { name: 'Must be assigned', field: 'ASSIGNED', operator: 'EQ', value: 'true', order: 3 },
    { name: 'Invoice attached', field: 'HAS_DOCUMENT_TYPE', operator: 'EQ', value: 'Invoice', order: 4 },
    { name: 'Work has started (not New)', field: 'WORKFLOW_STATUS', operator: 'NEQ', value: 'New', order: 5 },
    { name: 'Spell check passed', field: 'SPELL_STATUS', operator: 'EQ', value: 'PASSED', order: 6 },
    { name: 'QR check passed', field: 'QR_STATUS', operator: 'EQ', value: 'PASSED', order: 7 },
    { name: 'Metadata check passed', field: 'META_STATUS', operator: 'EQ', value: 'PASSED', order: 8 },
    { name: 'Intra-claim consistency passed', field: 'INTRA_STATUS', operator: 'EQ', value: 'PASSED', order: 9 },
    { name: 'Full scan passed', field: 'FULL_STATUS', operator: 'EQ', value: 'PASSED', order: 10 },
  ];
  for (const r of claimRules) {
    const exists = await prisma.claimRule.findFirst({ where: { name: r.name } });
    if (!exists) {
      await prisma.claimRule.create({
        data: {
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
  console.log(`  claim rules ensured: ${claimRules.length} rules, one per field (all dropdown options)`);

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
          projectId: project.id,
          categoryId: category.id,
          subCategoryId: subCategory.id,
          ...audit,
        },
      });
    }
  }
  console.log('  proxy URLs ensured: Vehicle Lookup Portal, Dealer Directory');

  // ── 10. Sample claims across mixed workflow + validation states ────────────
  // Live & honest demo: every check starts PENDING. The real Spell/QR/Meta/Intra/Full
  // results are computed only when the presenter clicks Validate (or on upload/sync),
  // so the badges can never contradict what the documents actually contain.
  const P = ValidationStatus.PENDING;

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
    docs?: { file: string; type: string | null }[]; // type = document-type name, or null (untyped)
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
      v: [P, P, P, P, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10002',
      dealerName: 'Sunrise Motors',
      dealerCode: 'DLR001',
      vinNo: 'MAJWXY2234567890',
      customerName: 'Priya Patel',
      schemeType: 'Service Scheme',
      docs: [
        { file: 'MZBFB812LSN565854 OK (Emp. ID).jpg', type: 'Invoice' },
        { file: 'MZBFB812LSN552928 Same Photo (Emp card).jpg', type: 'Aadhar Card' },
      ],
      remark: { text: 'Picked up for review, documents look complete.', by: 'USER', from: 'New', to: 'In Progress' },
    },
    {
      claimId: 'CLM10003',
      statusName: 'Verified',
      assignTo: 'USER',
      v: [P, P, P, P, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10003',
      dealerName: 'Highway Auto',
      dealerCode: 'DLR002',
      vinNo: 'MAJWXY3334567890',
      customerName: 'Amit Verma',
      schemeType: 'Extended Warranty',
      docs: [
        { file: 'MZBEP812LSN709192 Same policy no..pdf', type: 'Invoice' },
        { file: 'MZBEP812LSN709538 Same policy no..pdf', type: 'PAN Card' },
        { file: 'MZBFB812LSN555495 Same Photo (Emp card).jpg', type: 'Aadhar Card' },
      ],
      remark: { text: 'All checks passed. Marked as verified.', by: 'USER', from: 'In Progress', to: 'Verified' },
    },
    {
      claimId: 'CLM10004',
      statusName: 'In Progress',
      assignTo: 'TEAM_LEAD',
      v: [P, P, P, P, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10004',
      dealerName: 'Metro Cars',
      dealerCode: 'DLR003',
      vinNo: 'MAJWXY4434567890',
      customerName: 'Sneha Iyer',
      schemeType: 'Loyalty Scheme',
      observationRemarks: 'QR code does not decode; suspected forged invoice.',
      docs: [
        { file: 'MZBB6814LSN024292 Same QR.pdf', type: 'Aadhar Card' }, // no Invoice → "Invoice attached" rule fails
        { file: 'MZBB6814MSN022501 Same QR.pdf', type: null }, // duplicate QR code across two docs
        { file: 'MZBFB812LSN534536 Spelling errors (Emp. card).jpg', type: null },
      ],
      remark: { text: 'QR and consistency checks failed — escalating for manual inspection.', by: 'TEAM_LEAD', from: 'New', to: 'In Progress' },
    },
    {
      claimId: 'CLM10005',
      statusName: 'Closed',
      assignTo: 'USER',
      v: [P, P, P, P, P],
      folderPath: 'D:\\Claims\\Daily\\CLM10005',
      dealerName: 'Highway Auto',
      dealerCode: 'DLR002',
      vinNo: 'MAJWXY5534567890',
      customerName: 'Vikram Singh',
      schemeType: 'Service Scheme',
      docs: [
        { file: 'MZBFB812LSN538764 Spelling errors (Salary slip).jpg', type: 'Invoice' },
        { file: 'MZBFB812LSN555495 Spelling errors (Emp. card).jpg', type: 'PAN Card' },
      ],
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

    // Documents — feed the DOCUMENT_COUNT / HAS_DOCUMENT_TYPE claim rules.
    // Reset the demo claim's docs each run so re-seeding heals stale rows.
    // Source is SCANNED (they mirror the folder): only SCANNED docs are served via
    // CLAIMS_SCAN_ROOT, so this is what makes "open document" work on macOS.
    // storagePath mirrors the claim's folderPath so it lines up with folder syncs.
    await prisma.document.deleteMany({ where: { claimId: claim.id } });
    for (const d of c.docs ?? []) {
      const storagePath = c.folderPath ? `${c.folderPath}\\${d.file}` : d.file;
      const ext = d.file.toLowerCase().split('.').pop();
      const mimeType =
        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'png' ? 'image/png'
        : ext === 'pdf' ? 'application/pdf'
        : 'application/octet-stream';
      await prisma.document.create({
        data: {
          claimId: claim.id,
          documentTypeId: d.type ? docTypeIds[d.type] : null,
          source: 'SCANNED',
          fileName: d.file,
          storagePath,
          mimeType,
          createdBy: adminId,
        },
      });
    }
  }
  console.log(`  ${demoClaims.length} sample claims ensured (mixed workflow + validation states, with documents)`);

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
