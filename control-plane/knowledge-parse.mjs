// Adapted from the Guanzhi file importer; worker-isolated parsing only.
import { KnowledgeError as HttpError } from "./knowledge.mjs";
import mammoth from "mammoth";
import ExcelJS from "exceljs";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
export async function parseFile(filename, bytes) {
  const ext = filename.split(".").pop().toLowerCase(),
    parts = [],
    locations = [];
  const add = (location, text) => {
    if (!text.trim()) return;
    parts.push("[" + location + "]\n" + text);
    locations.push({ location });
    if (parts.join("\n\n").length > 18000)
      throw new HttpError(413, "extracted_text_too_long");
  };
  try {
    if (ext === "docx") {
      const { value } = await mammoth.extractRawText({ buffer: bytes });
      value.split(/\n\s*\n/).forEach((p, i) => add("段落 " + (i + 1), p));
    } else if (ext === "xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(bytes);
      for (const sheet of workbook.worksheets) {
        if (sheet.rowCount > 10000 || sheet.columnCount > 1000)
          throw new HttpError(413, "spreadsheet_too_large");
        sheet.eachRow((row) => {
          const cells = [];
          row.eachCell((cell) => {
            if (cell.type === ExcelJS.ValueType.Formula) {
              cells.push(
                cell.address + ": " + (cell.result ?? "[公式无缓存结果]"),
              );
            } else cells.push(cell.address + ": " + cell.text);
          });
          add(
            "工作表 " + sheet.name + " · 第 " + row.number + " 行",
            cells.join(" | "),
          );
        });
      }
    } else if (ext === "pdf") {
      if (bytes.subarray(0, 5).toString() !== "%PDF-")
        throw new HttpError(400, "invalid_file");
      const task = getDocument({
        data: new Uint8Array(bytes),
        isEvalSupported: false,
        useSystemFonts: true,
        disableFontFace: true,
      });
      const pdf = await task.promise;
      try {
        if (pdf.numPages > 200) throw new HttpError(413, "pdf_too_many_pages");
        for (let page = 1; page <= pdf.numPages; page++) {
          const text = await (await pdf.getPage(page)).getTextContent();
          const content = text.items
            .map((x) => x.str + (x.hasEOL ? "\n" : " "))
            .join("");
          if (!content.trim()) throw new HttpError(422, "pdf_requires_ocr");
          add("第 " + page + " 页", content);
        }
      } finally {
        await task.destroy();
      }
    } else if (["txt", "md"].includes(ext)) {
      add("全文", new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } else throw new HttpError(415, "unsupported_file");
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(422, "file_parse_failed");
  }
  if (!parts.length) throw new HttpError(422, "empty_document");
  return { content: parts.join("\n\n"), locations };
}
