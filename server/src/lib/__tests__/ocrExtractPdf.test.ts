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
});
