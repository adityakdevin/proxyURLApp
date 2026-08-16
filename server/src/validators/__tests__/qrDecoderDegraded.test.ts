import { decodeAll, isDecoderDegraded, resetDecoderDegraded } from '../qrValidator.js';

/**
 * Pins the degradation SIGNAL, not the decoder.
 *
 * Deliberately environment-agnostic. Under Jest the dynamic `import('zxing-wasm/reader')`
 * throws ("A dynamic import callback was invoked without --experimental-vm-modules"), so the
 * fallback path is the one that runs here; in the server process zxing loads from
 * node_modules and it is not. Asserting either outcome would encode one environment and fail
 * in the other, so these assert the INVARIANT instead: the flag agrees with whether a
 * fallback was actually logged.
 *
 * Worth knowing on its own — it means the QR suites exercise jsQR, not zxing.
 */
describe('QR decoder degradation signal', () => {
  jest.setTimeout(20000);

  let warn: jest.SpyInstance;
  beforeEach(() => {
    resetDecoderDegraded();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  const fellBack = () =>
    warn.mock.calls.some((c) => String(c[0]).includes('[qr] zxing decode unavailable'));

  it('starts clean', () => {
    expect(isDecoderDegraded()).toBe(false);
  });

  it('reports degraded if and only if a decode fell back to jsQR', async () => {
    // 64x64 white: no QR either way. What is under test is which decoder read it.
    await decodeAll(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
    expect(isDecoderDegraded()).toBe(fellBack());
  });

  it('resets, so one claim cannot inherit the previous claim’s verdict', async () => {
    await decodeAll(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
    resetDecoderDegraded();
    expect(isDecoderDegraded()).toBe(false);
  });
});
