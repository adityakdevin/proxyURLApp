import { mimeTypeFor, isInline } from '../mimeTypes.js';

describe('mimeTypes', () => {
  it('maps known extensions', () => {
    expect(mimeTypeFor('a.PDF')).toBe('application/pdf');
    expect(mimeTypeFor('scan.jpeg')).toBe('image/jpeg');
    expect(mimeTypeFor('x.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
  });
  it('falls back to octet-stream', () => {
    expect(mimeTypeFor('weird.xyz')).toBe('application/octet-stream');
    expect(mimeTypeFor('noext')).toBe('application/octet-stream');
  });
  it('marks pdf and images inline', () => {
    expect(isInline('application/pdf')).toBe(true);
    expect(isInline('image/png')).toBe(true);
    expect(isInline('text/plain')).toBe(false);
  });
});
