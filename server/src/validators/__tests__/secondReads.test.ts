import {
  pickImageCheckPages,
  pickUpscaleRegions,
  pickCertRescalePages,
  upscaleScale,
  layerImageMismatches,
  smallPictureUnread,
  smallPicturePages,
} from '../secondReads.js';

const H = 'INCOME TAX DEPARTMENT\nGOVT. OF INDIA\nPermanent Account Number Card\n';
const card = { width: 4, height: 4, box: { x: 0.1, y: 0.2, w: 0.8, h: 0.5 }, drawnWidthPt: 160 };
const logo = { width: 4, height: 4, box: { x: 0.05, y: 0.05, w: 0.15, h: 0.1 }, drawnWidthPt: 30 };
const small = { width: 244, height: 544, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.5 }, drawnWidthPt: 183 };

describe('pickImageCheckPages', () => {
  it('reads the picture of a text-layer ID page', () => {
    expect(pickImageCheckPages([H + 'PQRPT5678K'], [], new Map([[1, card]]))).toEqual([1]);
  });
  it('skips a picture that is only a logo', () => {
    expect(pickImageCheckPages([H + 'PQRPT5678K'], [], new Map([[1, logo]]))).toEqual([]);
  });
  it('skips a page OCR already reads', () => {
    expect(pickImageCheckPages([H + 'PQRPT5678K'], [1], new Map([[1, card]]))).toEqual([]);
  });
  it('reads a certificate page with no government class', () => {
    const cert = 'Birth Certificate\nRegistration No: MR-ABC-2025-001234';
    expect(pickImageCheckPages([cert], [], new Map([[1, card]]))).toEqual([1]);
  });
  it('skips a page that is neither ID nor certificate', () => {
    const inv = 'TAX INVOICE\nInvoice No: INV-1001\nAmount Rs 10,000';
    expect(pickImageCheckPages([inv], [], new Map([[1, card]]))).toEqual([]);
  });
  it('reads at most 6 pages of one document', () => {
    const pages = Array(8).fill(H + 'PQRPT5678K');
    const images = new Map(pages.map((_, i) => [i + 1, card] as const));
    expect(pickImageCheckPages(pages, [], images)).toEqual([1, 2, 3, 4, 5, 6]);
  });
});

describe('pickUpscaleRegions', () => {
  it('crops a small picture on a scanned page', () => {
    const images = new Map([
      [1, small],
      [2, { ...small, width: 1059, height: 1526 }],
    ]);
    expect(pickUpscaleRegions([1, 2], images)).toEqual([{ page: 1, box: small.box, scale: 6 }]);
  });
  it('crops nothing on text-layer pages', () => {
    expect(pickUpscaleRegions([], new Map([[1, small]]))).toEqual([]);
  });
});

describe('smallPicturePages', () => {
  // A small picture covering enough of a text-layer ID page for a picture read.
  const smallCard = { ...small, box: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 } };
  // Value: protects=every small-picture page a second read is meant for is listed, past the picture-read cap too; fails_when=text-layer pages or pages past MAX_IMAGE_CHECK_PAGES drop out, or large pictures or non-ID text-layer pages get in; why_new=META's skip test reaches only scanned pages; seam=none; no_claim=which of them were read (META)
  it('lists scanned small pictures and the text-layer ones a picture read checks', () => {
    const inv = 'TAX INVOICE\nInvoice No: INV-1001\nAmount Rs 10,000';
    const texts = [...Array(7).fill(H + 'PQRPT5678K'), inv, '', ''];
    const images = new Map([
      ...texts.slice(0, 8).map((_, i) => [i + 1, smallCard] as const),
      [9, small] as const,
      [10, { ...small, width: 1059, height: 1526 }] as const,
    ]);
    expect(smallPicturePages(texts, [9, 10], images)).toEqual([1, 2, 3, 4, 5, 6, 7, 9]);
  });
});

describe('upscaleScale', () => {
  it('clamps 1600 / drawn width into 2..6', () => {
    expect(upscaleScale(183)).toBe(6);
    expect(upscaleScale(444)).toBe(1600 / 444);
    expect(upscaleScale(900)).toBe(2);
  });
});

const AF = 'Government of India\nDOB: 01/01/1990\nMALE';
const CERT = 'Birth Certificate\nRegistration No: MR-ABC-2025-001234';
const RC = 'Indian Union Vehicle Registration Certificate\nRegn. Number\nMaker Name';
const GST = 'Form GST REG-06\nRegistration Certificate\nGoods and Services Tax\nRegistration Number :';
const POLICY = '\nPolicy No: 3001/12345678/00/000';

describe('layerImageMismatches', () => {
  it('flags a PAN that differs between picture and text layer', () => {
    expect(layerImageMismatches(H + 'PQRPT5678K', H + 'ABCPE1234F')).toEqual([
      { field: 'PAN', image: 'ABCPE1234F', layer: 'PQRPT5678K' },
    ]);
  });
  it('ignores an OCR misread of the same number', () => {
    expect(layerImageMismatches(H + 'ABCPE1234F', H + 'ABCPE1243F')).toEqual([]);
  });
  it('says nothing when the picture read no number', () => {
    expect(layerImageMismatches(H + 'ABCPE1234F', H + 'Signature')).toEqual([]);
  });
  it('says nothing about a number only the picture has', () => {
    expect(layerImageMismatches(H + 'Signature', H + 'ABCPE1234F')).toEqual([]);
  });
  it('ignores spacing', () => {
    expect(layerImageMismatches(AF + '\n2345 6789 0123', AF + '\n234567890123')).toEqual([]);
    expect(layerImageMismatches(AF + '\n234567890123', AF + '\n2345 6789 0123')).toEqual([]);
  });
  it('says nothing when the layer also holds the picture number', () => {
    expect(layerImageMismatches(H + 'PQRPT5678K\nABCPE1234F', H + 'ABCPE1234F')).toEqual([]);
  });
  it('ignores a partial read of a long certificate number', () => {
    expect(layerImageMismatches(CERT, 'Birth Certificate\nRegistration No: 2025-001234')).toEqual([]);
  });
  it('flags a certificate number that differs', () => {
    expect(layerImageMismatches(CERT, 'Birth Certificate\nRegistration No: 4321/2023')).toEqual([
      { field: 'CERT_REG_NO', image: '4321/2023', layer: 'MR-ABC-2025-001234' },
    ]);
  });
  it('compares field by field', () => {
    expect(layerImageMismatches(H + 'PQRPT5678K', AF + '\n2345 6789 0123')).toEqual([]);
  });
});

describe('smallPictureUnread', () => {
  it('fires on a small ID picture with no number read', () => {
    expect(smallPictureUnread(small, [AF])).toBe(true);
  });
  it('stays silent once any read has the number', () => {
    expect(smallPictureUnread(small, [AF, AF + '\n2345 6789 0123'])).toBe(false);
  });
  it('stays silent for a picture of 800 px or more', () => {
    expect(smallPictureUnread({ ...small, width: 800, height: 600 }, [AF])).toBe(false);
  });
  it('stays silent under 10% of the page', () => {
    expect(smallPictureUnread({ ...small, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.3 } }, [AF])).toBe(false);
  });
  it('stays silent for an RC picture', () => {
    expect(smallPictureUnread(small, [RC])).toBe(false);
  });
  it('still fires for a GST certificate that also reads as an RC', () => {
    expect(smallPictureUnread(small, [GST])).toBe(true);
  });
  it('does not count a policy number as an ID number', () => {
    expect(smallPictureUnread(small, [GST + POLICY])).toBe(true);
    expect(smallPictureUnread(small, [AF + POLICY])).toBe(false);
  });
  it('fires when nothing was read at all', () => {
    expect(smallPictureUnread(small, [])).toBe(true);
  });
  // A clearer copy of these still has no PAN, Aadhaar or other identifier to read.
  it('stays silent for a staff ID card, a payslip and a DMS page', () => {
    const picture = { width: 700, height: 450, box: { x: 0.2, y: 0.2, w: 0.4, h: 0.3 }, drawnWidthPt: 238 };
    const staffId = 'ABC MOTORS PVT LTD\nEMPLOYEE ID CARD\nName: RAVI KUMAR\nEmp Code: E1234\nDesignation: Sales Executive';
    const payslip = 'Salary Slip for May 2026\nBasic Pay 20000\nNet Pay 18000';
    const dms = 'Dealer Management System\nDMS Booking No: BK-2026-0042\nModel: Hatchback LXI';
    expect(smallPictureUnread(picture, [staffId])).toBe(false);
    expect(smallPictureUnread(picture, [payslip])).toBe(false);
    expect(smallPictureUnread(picture, [dms])).toBe(false);
  });
});

describe('pickCertRescalePages', () => {
  const C0 = 'Birth Certificate\nRegistration of Births and Deaths Act, 1969\nDate of Registration: 01/01/2020';
  const J = 'ftfr qrwk\nzxv mnbv\nploj trq\nwvx kjhq';
  const smallPic = { width: 244, height: 544, box: { x: 0.3, y: 0.2, w: 0.3, h: 0.5 }, drawnWidthPt: 183 };
  it('re-reads a scanned certificate page with no number parsed', () => {
    expect(pickCertRescalePages([{ page: 1, text: C0 }], new Map())).toEqual([1]);
  });
  it('skips a certificate page whose number parsed', () => {
    const t = 'Birth Certificate\nRegistration No: 4321/2023';
    expect(pickCertRescalePages([{ page: 1, text: t }], new Map())).toEqual([]);
  });
  it('skips a page that is not a civil certificate', () => {
    const inv = 'TAX INVOICE\nInvoice No: INV-1001\nAmount Rs 10,000';
    expect(pickCertRescalePages([{ page: 1, text: J }, { page: 2, text: inv }], new Map())).toEqual([]);
  });
  it('skips a page the main read left empty', () => {
    expect(pickCertRescalePages([{ page: 1, text: '' }], new Map())).toEqual([]);
  });
  it('leaves a small picture to the crop read', () => {
    expect(pickCertRescalePages([{ page: 1, text: C0 }], new Map([[1, smallPic]]))).toEqual([]);
  });
  it('re-reads at most 2 pages of one document', () => {
    const pages = [1, 2, 3].map((page) => ({ page, text: C0 }));
    expect(pickCertRescalePages(pages, new Map())).toEqual([1, 2]);
  });
});
