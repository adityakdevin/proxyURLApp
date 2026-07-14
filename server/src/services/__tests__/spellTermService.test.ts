import { PrismaClient } from '@prisma/client';
import { SpellTermService } from '../spellTermService.js';
import { getTestPrisma, disconnectTestPrisma } from '../../__tests__/helpers/testDb.js';

// DB-backed (needs TEST_DATABASE_URL, like the sibling master tests). Cleans only
// spell_terms — never the claim tables — so it can't disturb other data.
describe('SpellTermService', () => {
  let prisma: PrismaClient;
  let service: SpellTermService;
  let actorId: string;

  beforeAll(async () => {
    prisma = getTestPrisma();
    service = new SpellTermService(prisma);
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' } });
    if (!admin) throw new Error('Need at least one ADMIN user seeded to run tests');
    actorId = admin.id;
  });

  beforeEach(async () => {
    await prisma.spellTerm.deleteMany({});
  });

  afterAll(async () => {
    await prisma.spellTerm.deleteMany({});
    await disconnectTestPrisma();
  });

  it('creates a term, normalized to lowercase/trimmed', async () => {
    const t = await service.create({ term: '  Profession  ' }, actorId);
    expect(t.term).toBe('profession');
    expect(t.status).toBe('ACTIVE');
    expect(t.createdBy).toBe(actorId);
  });

  it('rejects a duplicate term (case-insensitive via normalization)', async () => {
    await service.create({ term: 'Bajaj' }, actorId);
    await expect(service.create({ term: 'bajaj' }, actorId)).rejects.toMatchObject({
      code: 'DUPLICATE_TERM',
    });
  });

  it('rejects an update that would collide with another term', async () => {
    await service.create({ term: 'engineer' }, actorId);
    const b = await service.create({ term: 'manager' }, actorId);
    await expect(service.update(b.id, { term: 'Engineer' }, actorId)).rejects.toMatchObject({
      code: 'DUPLICATE_TERM',
    });
  });

  it('setStatus deactivates and reactivates', async () => {
    const t = await service.create({ term: 'signatory' }, actorId);
    const off = await service.setStatus(t.id, 'INACTIVE', actorId);
    expect(off.status).toBe('INACTIVE');
    const on = await service.setStatus(t.id, 'ACTIVE', actorId);
    expect(on.status).toBe('ACTIVE');
  });

  it('deletes a term', async () => {
    const t = await service.create({ term: 'temporary' }, actorId);
    await service.delete(t.id);
    expect(await service.getById(t.id)).toBeNull();
  });

  it('list orders alphabetically and filters by search + status', async () => {
    await service.create({ term: 'zebra' }, actorId);
    await service.create({ term: 'alpha' }, actorId);
    const inactive = await service.create({ term: 'allowance' }, actorId);
    await service.setStatus(inactive.id, 'INACTIVE', actorId);

    const all = await service.list({});
    expect(all.data.map((t) => t.term)).toEqual(['allowance', 'alpha', 'zebra']);

    const active = await service.list({ status: 'ACTIVE' });
    expect(active.data.map((t) => t.term)).toEqual(['alpha', 'zebra']);

    const search = await service.list({ search: 'all' });
    expect(search.data.map((t) => t.term)).toEqual(['allowance']);
  });

  it('rejects NOT_FOUND on missing id for update/delete/setStatus', async () => {
    const missing = '00000000-0000-0000-0000-000000000000';
    await expect(service.update(missing, { term: 'x' }, actorId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(service.delete(missing)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(service.setStatus(missing, 'INACTIVE', actorId)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
