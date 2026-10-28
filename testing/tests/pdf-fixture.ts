/**
 * A tiny PDF writer, used to test the PDF import path without depending on
 * any external tool. Produces a valid one- or multi-page PDF with a standard
 * font and no compression.
 */
export function makePdf(pages: string[]): Buffer {
  const objects: string[] = [];
  const push = (body: string): number => {
    objects.push(body);
    return objects.length; // object numbers are 1-based
  };

  const fontNum = push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageNums: number[] = [];
  const contentNums: number[] = [];
  for (const text of pages) {
    const lines = text.split('\n');
    const stream = ['BT', '/F1 12 Tf', '72 720 Td', '14 TL'];
    for (const line of lines) {
      stream.push(`(${line.replace(/([()\\])/g, '\\$1')}) Tj T*`);
    }
    stream.push('ET');
    contentNums.push(push(`<< /Length ${stream.join('\n').length} >>\nstream\n${stream.join('\n')}\nendstream`));
  }
  const pagesNum = objects.length + pages.length + 1;
  for (let i = 0; i < pages.length; i++) {
    pageNums.push(
      push(
        `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNums[i]} 0 R >>`,
      ),
    );
  }
  const realPagesNum = push(
    `<< /Type /Pages /Count ${pages.length} /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] >>`,
  );
  const catalogNum = push(`<< /Type /Catalog /Pages ${realPagesNum} 0 R >>`);

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  return Buffer.from(out, 'latin1');
}
