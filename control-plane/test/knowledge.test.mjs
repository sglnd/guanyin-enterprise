import test from "node:test";
import assert from "node:assert/strict";
import { chunks, vector, cosine } from "../knowledge.mjs";
import { parseFileIsolated } from "../knowledge-isolated.mjs";
test("knowledge vectors reject corrupt dimensions and chunk without losing text", () => {
  const text = "中文测试。".repeat(1000);
  assert.equal(chunks(text).join(""), text);
  assert.ok(chunks(text).every((x) => x.length <= 1600));
  assert.throws(() => vector([Infinity]));
  assert.throws(() => vector([]));
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.throws(() => cosine([1], [1, 2]));
});
test("knowledge file parser isolates UTF8 and rejects unsupported formats", async () => {
  assert.match(
    (
      await parseFileIsolated(
        "操作说明.md",
        Buffer.from("服务异常时查看日志。"),
      )
    ).content,
    /服务异常/,
  );
  await assert.rejects(
    parseFileIsolated("bad.txt", Buffer.from([255])),
    /file_parse_failed/,
  );
  await assert.rejects(
    parseFileIsolated("scan.exe", Buffer.from("123")),
    /unsupported_file/,
  );
});
test("knowledge parser extracts DOCX paragraphs and XLSX cell locations", async () => {
  const ExcelJS = (await import("exceljs")).default,
    JSZip = (await import("jszip")).default;
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("巡检").addRow(["磁盘", "80%"]);
  const xlsx = Buffer.from(await workbook.xlsx.writeBuffer());
  assert.match(
    (await parseFileIsolated("巡检.xlsx", xlsx)).content,
    /工作表 巡检.*第 1 行/,
  );
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    "_rels/.rels",
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  zip.file(
    "word/document.xml",
    '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>磁盘巡检步骤</w:t></w:r></w:p></w:body></w:document>',
  );
  assert.match(
    (
      await parseFileIsolated(
        "说明.docx",
        await zip.generateAsync({ type: "nodebuffer" }),
      )
    ).content,
    /磁盘巡检步骤/,
  );
});

test("text PDF imports with page provenance; empty PDF requires OCR", async () => {
  function pdf(text) {
    const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let out = "%PDF-1.4\n",
      offsets = [0];
    objects.forEach((o, i) => {
      offsets.push(Buffer.byteLength(out));
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const start = Buffer.byteLength(out);
    out +=
      `xref\n0 6\n0000000000 65535 f \n` +
      offsets
        .slice(1)
        .map((x) => `${String(x).padStart(10, "0")} 00000 n \n`)
        .join("") +
      `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
  }
  assert.match(
    (await parseFileIsolated("manual.pdf", pdf("Disk usage is high."))).content,
    /Disk usage is high/,
  );
  await assert.rejects(
    parseFileIsolated("scan.pdf", pdf("")),
    /pdf_requires_ocr/,
  );
});
