import { rotateBox, unrotateBox } from '../bbox.js';

describe('quarter-turn boxes', () => {
  it('turns a box a quarter turn and back', () => {
    const b = { x: 0.1, y: 0.2, w: 0.3, h: 0.05 };
    const u90 = unrotateBox(b, 90);
    expect(u90.x).toBeCloseTo(0.75, 9);
    expect(u90.y).toBeCloseTo(0.1, 9);
    expect(u90.w).toBeCloseTo(0.05, 9);
    expect(u90.h).toBeCloseTo(0.3, 9);
    const u270 = unrotateBox(b, 270);
    expect(u270.x).toBeCloseTo(0.2, 9);
    expect(u270.y).toBeCloseTo(0.6, 9);
    expect(u270.w).toBeCloseTo(0.05, 9);
    expect(u270.h).toBeCloseTo(0.3, 9);
    const back = rotateBox(u90, 90);
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(back[k]).toBeCloseTo(b[k], 9);
    for (const t of [0, 90, 180, 270]) {
      const r = rotateBox(unrotateBox(b, t), t);
      for (const k of ['x', 'y', 'w', 'h'] as const) expect(r[k]).toBeCloseTo(b[k], 9);
    }
  });
});
