import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { detectAiSignals, readFileMeta } from '../fileMeta.js';

/** A minimal JPEG carrying one EXIF tag (IFD0 Make) and nothing else. */
function jpegWithMake(make: string): Buffer {
  const val = Buffer.from(`${make}\0`, 'latin1');
  const tiff = Buffer.alloc(26);
  tiff.write('II', 0, 'latin1');
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4); // IFD0 offset
  tiff.writeUInt16LE(1, 8); // one entry
  tiff.writeUInt16LE(0x010f, 10); // Make
  tiff.writeUInt16LE(2, 12); // ASCII
  tiff.writeUInt32LE(val.length, 14);
  tiff.writeUInt32LE(tiff.length, 18); // value sits right after the IFD
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff, val]);
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length + 2);
  return Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), len, body, Buffer.from([0xff, 0xd9])]);
}

describe('readFileMeta', () => {
  // exifr's own path reader fails on Node 26 ("options argument must be of type object"),
  // which the catch turned into empty metadata — and it leaked the file handle it opened,
  // which Node 26 escalates to a process crash on the next GC.
  it('reads EXIF from a JPEG on disk', async () => {
    const file = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'filemeta-')), 'card.jpg');
    await fs.writeFile(file, jpegWithMake('Canon'));
    const meta = await readFileMeta(file, 'image/jpeg');
    expect(meta.make).toBe('Canon');
    expect(meta.hasCameraData).toBe(true);
  });
});

describe('detectAiSignals (AI-origin heuristic)', () => {
  it('flags a known AI generator named in software/producer/creatorTool', () => {
    expect(detectAiSignals({ software: 'Made with Gemini' })).toHaveLength(1);
    expect(detectAiSignals({ producer: 'DALL-E 3' }).length).toBeGreaterThan(0);
    expect(detectAiSignals({ creatorTool: 'Midjourney v6' }).length).toBeGreaterThan(0);
  });

  it('flags a JPEG with no camera make/model', () => {
    const sig = detectAiSignals({ mimeType: 'image/jpeg' });
    expect(sig.some((s) => /no camera/.test(s))).toBe(true);
  });

  it('does NOT flag a normal camera JPEG', () => {
    expect(
      detectAiSignals({ mimeType: 'image/jpeg', make: 'Canon', model: 'EOS 5D', software: 'Adobe Photoshop' })
    ).toHaveLength(0);
  });

  it('does NOT apply the no-camera rule to non-JPEG images', () => {
    expect(detectAiSignals({ mimeType: 'image/png' })).toHaveLength(0);
  });
});
