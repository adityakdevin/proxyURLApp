import { TesseractOcrPort } from '../ocr.js';
import { rasterizePdf } from '../pdfExtractor.js';

// A worker that reads every image as the same poor text, so each page asks for a retry.
jest.mock('tesseract.js', () => ({
  createWorker: async () => ({
    recognize: async () => ({ data: { text: 'zz qq' } }),
    setParameters: async () => undefined,
    terminate: async () => undefined,
  }),
}));
jest.mock('../pdfExtractor.js', () => ({
  ...jest.requireActual('../pdfExtractor.js'),
  rasterizePdf: jest.fn(),
}));

describe('TesseractOcrPort.extractPdf', () => {
  beforeEach(() => jest.spyOn(console, 'log').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('keeps the first look of a page whose high-res retry fails', async () => {
    const raster = rasterizePdf as jest.MockedFunction<typeof rasterizePdf>;
    raster
      .mockResolvedValueOnce([{ page: 1, png: Buffer.from('page'), width: 100, height: 100, totalPages: 1 }])
      .mockRejectedValueOnce(new Error('pixdata_malloc fail'));
    const port = new TesseractOcrPort();
    try {
      const r = await port.extractPdf('/claims/scan.pdf', [1]);
      expect(raster).toHaveBeenCalledTimes(2);
      expect(r).toMatchObject({ text: 'zz qq', unreadPages: [] });
    } finally {
      await port.close();
    }
  });

  // Value: protects=both OCR reads compare META's deadline with the monotonic clock it was set on; fails_when=extractPdf or extractPdfRegions read Date.now (every page past the deadline, or a backward wall-clock step starting reads past META's timeout); why_new=META's deadline moved to performance.now; seam=Date.now spy; no_claim=queue time (pdfExtractor.test.ts)
  it('reads the deadline on the monotonic clock, whatever the wall clock does', async () => {
    const raster = rasterizePdf as jest.MockedFunction<typeof rasterizePdf>;
    raster.mockResolvedValue([{ page: 1, png: Buffer.from('page'), width: 100, height: 100, totalPages: 1 }]);
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() - 3_600_000);
    const port = new TesseractOcrPort();
    try {
      const ahead = performance.now() + 60_000;
      const region = { page: 1, box: { x: 0, y: 0, w: 1, h: 1 }, scale: 2 };
      expect(await port.extractPdf('/claims/scan.pdf', [1], { deadline: ahead })).toMatchObject({ unreadPages: [] });
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region], { deadline: ahead })).not.toContain(null);
      const passed = performance.now() - 1;
      expect(await port.extractPdf('/claims/scan.pdf', [1], { deadline: passed })).toMatchObject({ unreadPages: [1] });
      expect(await port.extractPdfRegions('/claims/scan.pdf', [region], { deadline: passed })).toEqual([null]);
    } finally {
      await port.close();
    }
  });
});
