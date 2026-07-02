import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import QRCode from 'qrcode';
import { qrValidator } from '../qrValidator.js';
import { ValidatorContext, ValidatorDoc } from '../types.js';

const doc = (over: Partial<ValidatorDoc>): ValidatorDoc => ({
  id: 'd',
  fileName: 'q.png',
  storagePath: 'p',
  readablePath: 'p',
  mimeType: 'image/png',
  source: 'UPLOADED',
  documentTypeId: null,
  ...over,
});
function ctx(documents: ValidatorDoc[]): ValidatorContext {
  return {
    claim: { id: 'c', claimId: 'C1', subCategoryId: 's' },
    documents,
    prisma: {} as never,
    ocr: { extractImageText: async () => '' },
    shared: new Map(),
    wordBoxes: new Map(),
  };
}

describe('qrValidator', () => {
  let dir: string;
  let qrPath: string;
  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'qr-'));
    qrPath = path.join(dir, 'q.png');
    await QRCode.toFile(qrPath, 'CLAIM-PAYLOAD', { width: 256 });
  });
  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('decodes a real QR png', async () => {
    const out = await qrValidator.run(ctx([doc({ readablePath: qrPath })]));
    expect(out.status).toBe('PASSED');
    expect((out.details as { values: string[] }).values).toContain('CLAIM-PAYLOAD');
  });
  it('PASSES (N/A) when there are no image documents', async () => {
    expect((await qrValidator.run(ctx([doc({ mimeType: 'application/pdf' })]))).status).toBe('PASSED');
  });
});
