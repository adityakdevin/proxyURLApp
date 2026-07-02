import { detectAiSignals } from '../fileMeta.js';

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
