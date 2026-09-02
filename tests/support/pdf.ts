/** Minimal single-page PDF with one text line, readable by pdftotext. */
export function pdfBytes(line: string): Buffer {
  const stream = `BT /F1 12 Tf 72 720 Td (${line}) Tj ET`;
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]"
      + " /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n",
    "4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
    `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`,
  ];
  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(document.length);
    document += object;
  }
  const xrefAt = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}

/**
 * A multi-page PDF built from one PDF content stream per page. Pass an empty
 * string for a page to leave it with no text layer (image-only fallback
 * tests); pass a `Tj` drawing stream for a page with real text.
 */
export function multiPagePdfBytes(pageContents: string[]): Buffer {
  const fontId = 3 + pageContents.length * 2;
  const objects: string[] = [];
  const kids = pageContents.map((_, index) => `${3 + index * 2} 0 R`).join(" ");
  objects.push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  objects.push(
    `2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pageContents.length} >>\nendobj\n`,
  );
  pageContents.forEach((stream, index) => {
    const pageId = 3 + index * 2;
    const contentsId = pageId + 1;
    objects.push(
      `${pageId} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 150]`
        + ` /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentsId} 0 R >>\nendobj\n`,
    );
    objects.push(`${contentsId} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  });
  objects.push(`${fontId} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);

  let document = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const object of objects) {
    offsets.push(document.length);
    document += object;
  }
  const xrefAt = document.length;
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    document += `${String(offset).padStart(10, "0")} 00000 n \n`;
  }
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`
    + `startxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(document, "latin1");
}
