/** One page of `imagePdfPages`: paints the image with `cm` (none without), optionally inside a
 *  form XObject, optionally with Helvetica text lines and a /Rotate. */
export interface ImagePage {
  cm?: string;
  text?: string[];
  rotate?: number;
  form?: { cm: string; matrix: string };
}

/** One 200x200 pt page painting a 4x4 black DeviceGray image with `cm`. */
export function imagePdf(opts: ImagePage & { cm: string }): Buffer {
  return imagePdfPages([opts]);
}

/** 200x200 pt pages sharing one 4x4 black DeviceGray image and one font. */
export function imagePdfPages(pages: ImagePage[]): Buffer {
  const pageObj = (i: number) => 5 + 3 * i;
  const objs = [
    Buffer.from('<</Type/Catalog/Pages 2 0 R>>'),
    Buffer.from(`<</Type/Pages/Kids[${pages.map((_, i) => `${pageObj(i)} 0 R`).join(' ')}]/Count ${pages.length}>>`),
    Buffer.concat([
      Buffer.from(
        '<</Type/XObject/Subtype/Image/Width 4/Height 4/ColorSpace/DeviceGray/BitsPerComponent 8/Length 16>>\nstream\n'
      ),
      Buffer.alloc(16),
      Buffer.from('\nendstream'),
    ]),
    Buffer.from('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>'),
  ];
  pages.forEach(({ cm, text, rotate, form }, i) => {
    const paint = !cm ? '' : form ? `q ${form.cm} cm /Fm1 Do Q` : `q ${cm} cm /Im1 Do Q`;
    const lines = (text ?? []).map((t) => `(${t.replace(/[\\()]/g, '\\$&')}) Tj`).join(' 0 -40 Td ');
    const content = text?.length ? `${paint}\nBT /F1 10 Tf 10 190 Td ${lines} ET` : paint;
    const formBody = `q ${cm ?? '1 0 0 1 0 0'} cm /Im1 Do Q`;
    objs.push(
      Buffer.from(
        `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]${rotate ? `/Rotate ${rotate}` : ''}` +
          `/Resources<</XObject<</Im1 3 0 R/Fm1 ${pageObj(i) + 2} 0 R>>/Font<</F1 4 0 R>>>>/Contents ${pageObj(i) + 1} 0 R>>`
      ),
      Buffer.from(`<</Length ${content.length}>>\nstream\n${content}\nendstream`),
      Buffer.from(
        `<</Type/XObject/Subtype/Form/BBox[0 0 200 200]/Matrix[${form?.matrix ?? '1 0 0 1 0 0'}]` +
          `/Resources<</XObject<</Im1 3 0 R>>>>/Length ${formBody.length}>>\nstream\n${formBody}\nendstream`
      )
    );
  });
  const parts = [Buffer.from('%PDF-1.5\n')];
  let size = parts[0].length;
  const offsets = objs.map((o, i) => {
    const part = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`), o, Buffer.from('\nendobj\n')]);
    parts.push(part);
    size += part.length;
    return size - part.length;
  });
  parts.push(
    Buffer.from(
      `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
        offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('') +
        `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${size}\n%%EOF\n`
    )
  );
  return Buffer.concat(parts);
}

/** A PDF with one text page per content stream, in `font`; `pageExtra[i]` is added to page i's
 *  dictionary (e.g. "/Rotate 90"). */
export function textPagesPdf(
  contents: string[],
  { font = 'Helvetica', mediaBox = '0 0 200 200', pageExtra = [] as string[] } = {}
): Buffer {
  const n = contents.length;
  const objs = [
    '<</Type/Catalog/Pages 2 0 R>>',
    `<</Type/Pages/Kids[${contents.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}]/Count ${n}>>`,
    `<</Type/Font/Subtype/Type1/BaseFont/${font}>>`,
  ];
  contents.forEach((c, i) => {
    objs.push(
      `<</Type/Page/Parent 2 0 R/MediaBox[${mediaBox}]${pageExtra[i] ?? ''}/Resources<</Font<</F1 3 0 R>>>>/Contents ${5 + 2 * i} 0 R>>`
    );
    objs.push(`<</Length ${c.length}>>\nstream\n${c}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
  out += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
