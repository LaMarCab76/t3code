import type {
  DocumentEdits,
  DocumentFormat,
  DocumentPage,
  DocumentReadInput,
} from "@t3tools/contracts";
import { parse, HTMLElement, TextNode } from "node-html-parser";
import type ExcelJS from "exceljs";
import * as NodeCrypto from "node:crypto";
import {
  parseDelimitedDocument,
  recalculateWorkbook,
  serializeDelimitedDocument,
  spreadsheetValue,
} from "./spreadsheet.ts";

export const documentRevision = (bytes: Uint8Array) =>
  NodeCrypto.createHash("sha256").update(bytes).digest("hex");
export function documentFormat(name: string): DocumentFormat {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (
    extension === "pdf" ||
    extension === "docx" ||
    extension === "xlsx" ||
    extension === "csv" ||
    extension === "tsv"
  )
    return extension;
  throw new Error("Supported document formats are PDF, DOCX, XLSX, CSV and TSV.");
}

async function docxHtml(bytes: Uint8Array) {
  const mammoth = await import("mammoth");
  const result = await mammoth.convertToHtml(
    { buffer: Buffer.from(bytes) },
    { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) },
  );
  const root = parse(result.value);
  root.querySelectorAll("img,script,style").forEach((element) => element.remove());
  return root.childNodes
    .filter((node) => node instanceof HTMLElement)
    .map((node) => node.toString());
}

async function exportDocx(html: string): Promise<Uint8Array> {
  const d = await import("docx");
  const inline = (
    nodes: readonly (HTMLElement | TextNode | import("node-html-parser").Node)[],
    marks: { bold?: boolean; italics?: boolean } = {},
  ): (InstanceType<typeof d.TextRun> | InstanceType<typeof d.ExternalHyperlink>)[] =>
    nodes.flatMap((node) => {
      if (node instanceof TextNode) return [new d.TextRun({ text: node.text, ...marks })];
      if (!(node instanceof HTMLElement)) return [];
      const tag = node.tagName.toLowerCase();
      if (tag === "br") return [new d.TextRun({ break: 1 })];
      const children = inline(node.childNodes, {
        ...marks,
        ...(tag === "strong" || tag === "b" ? { bold: true } : {}),
        ...(tag === "em" || tag === "i" ? { italics: true } : {}),
      });
      const href = node.getAttribute("href");
      return tag === "a" && href && /^(https?:\/\/|mailto:)/i.test(href)
        ? [new d.ExternalHyperlink({ link: href, children })]
        : children;
    });
  const blocks = (
    nodes: readonly import("node-html-parser").Node[],
    list?: "bullet" | "ordered",
    level = 0,
  ): (InstanceType<typeof d.Paragraph> | InstanceType<typeof d.Table>)[] =>
    nodes.flatMap((node) => {
      if (!(node instanceof HTMLElement))
        return node.text.trim() ? [new d.Paragraph({ children: inline([node]) })] : [];
      const tag = node.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol")
        return blocks(node.childNodes, tag === "ul" ? "bullet" : "ordered", level);
      if (tag === "li") {
        const nested = node.childNodes.filter(
          (child) => child instanceof HTMLElement && /^(UL|OL)$/.test(child.tagName),
        );
        const content = node.childNodes.filter((child) => !nested.includes(child));
        return [
          new d.Paragraph({
            children: inline(content),
            ...(list === "ordered"
              ? { numbering: { reference: "ordered", level: Math.min(level, 8) } }
              : { bullet: { level: Math.min(level, 8) } }),
          }),
          ...blocks(nested, list, Math.min(level + 1, 8)),
        ];
      }
      if (tag === "table")
        return [
          new d.Table({
            rows: node.querySelectorAll("tr").map(
              (row) =>
                new d.TableRow({
                  children: row.childNodes
                    .filter(
                      (cell): cell is HTMLElement =>
                        cell instanceof HTMLElement && /^(TD|TH)$/.test(cell.tagName),
                    )
                    .map(
                      (cell) =>
                        new d.TableCell({
                          children: blocks(cell.childNodes).length
                            ? blocks(cell.childNodes)
                            : [new d.Paragraph("")],
                        }),
                    ),
                }),
            ),
          }),
        ];
      if (!/^(p|h[1-6]|blockquote|pre)$/.test(tag)) return blocks(node.childNodes, list, level);
      const heading = {
        h1: d.HeadingLevel.HEADING_1,
        h2: d.HeadingLevel.HEADING_2,
        h3: d.HeadingLevel.HEADING_3,
        h4: d.HeadingLevel.HEADING_4,
        h5: d.HeadingLevel.HEADING_5,
        h6: d.HeadingLevel.HEADING_6,
      }[tag];
      return [
        new d.Paragraph({
          children: inline(node.childNodes),
          ...(heading ? { heading } : {}),
          ...(list === "bullet"
            ? { bullet: { level } }
            : list === "ordered"
              ? { numbering: { reference: "ordered", level } }
              : {}),
        }),
      ];
    });
  const document = new d.Document({
    sections: [{ children: blocks(parse(html).childNodes) }],
    numbering: {
      config: [
        {
          reference: "ordered",
          levels: Array.from({ length: 9 }, (_, level) => ({
            level,
            format: d.LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: d.AlignmentType.START,
          })),
        },
      ],
    },
  });
  return d.Packer.toBuffer(document);
}

async function loadSpreadsheet(format: DocumentFormat, bytes?: Uint8Array) {
  const { default: Excel } = await import("exceljs");
  const workbook = new Excel.Workbook();
  let delimiter = format === "tsv" ? "\t" : ",";
  let newline = "\n",
    bom = false,
    trailingNewline = false;
  if (bytes && format === "xlsx") await workbook.xlsx.load(new Uint8Array(bytes).buffer);
  else {
    const sheet = workbook.addWorksheet("Sheet1");
    if (bytes) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      newline = text.includes("\r\n") ? "\r\n" : "\n";
      trailingNewline = /[\r\n]$/.test(text);
      if (format === "csv") {
        let quoted = false,
          commas = 0,
          semicolons = 0;
        for (let index = 0; index < text.length; index++) {
          const char = text[index];
          if (char === '"') {
            if (quoted && text[index + 1] === '"') index++;
            else quoted = !quoted;
          } else if (!quoted) {
            if (char === "\r" || char === "\n") break;
            if (char === ",") commas++;
            if (char === ";") semicolons++;
          }
        }
        if (semicolons > commas) delimiter = ";";
      }
      parseDelimitedDocument(text, delimiter).forEach((row, index) =>
        row.forEach((value, col) => {
          sheet.getCell(index + 1, col + 1).value = value.startsWith("=")
            ? { formula: value.slice(1) }
            : value;
        }),
      );
    }
  }
  let cells = 0;
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell(() => {
        if (++cells > 200000)
          throw new Error("This spreadsheet exceeds the 200,000-cell editing limit.");
      }),
    ),
  );
  return { workbook, delimiter, newline, bom, trailingNewline };
}

export async function readDocument(
  bytes: Uint8Array,
  name: string,
  input: Pick<DocumentReadInput, "start" | "count" | "sheet" | "column" | "columns" | "edits">,
): Promise<DocumentPage> {
  const format = documentFormat(name),
    start = input.start ?? 0;
  validateDocumentEdits(format, input.edits ?? {}, bytes !== undefined);
  const count = input.count ?? (format === "pdf" ? 1 : 40);
  const base = {
    name,
    revision: documentRevision(bytes),
    start,
    count,
    limitations: [] as string[],
  };
  if (format === "docx") {
    const blocks = await docxHtml(bytes);
    const html = blocks.slice(start, start + count).join("");
    if (html.length > 200000)
      throw new Error("This section is too large to edit. Request fewer document blocks.");
    return {
      ...base,
      format,
      total: blocks.length,
      count: Math.max(0, Math.min(count, blocks.length - start)),
      html,
      limitations: [
        "DOCX editing preserves basic text, headings, emphasis, links, lists and tables. Advanced layout, images, comments and tracked changes may be lost in the saved copy.",
      ],
    };
  }
  if (format === "pdf") {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const worker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    // Supply the in-process worker explicitly so bundled servers and executables
    // do not look for a sibling pdf.worker.mjs on the host filesystem.
    (globalThis as typeof globalThis & { pdfjsWorker?: typeof worker }).pdfjsWorker = worker;
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 500) throw new Error("This PDF exceeds the 500-page editing limit.");
      const pages = [];
      for (let index = start; index < Math.min(start + count, pdf.numPages); index++) {
        const page = await pdf.getPage(index + 1),
          viewport = page.getViewport({ scale: 1 });
        const text = (await page.getTextContent()).items
          .map((item) => ("str" in item ? item.str : ""))
          .join(" ");
        pages.push({
          page: index + 1,
          width: viewport.width,
          height: viewport.height,
          text: text.slice(0, 100000),
        });
      }
      const p = await import("pdf-lib"),
        document = await p.PDFDocument.load(bytes);
      const fields = document
        .getForm()
        .getFields()
        .map((field) => {
          const common = {
            name: field.getName(),
            readOnly: field.isReadOnly(),
            options: [] as string[],
          };
          if (field instanceof p.PDFTextField)
            return { ...common, type: "text" as const, value: field.getText() ?? "" };
          if (field instanceof p.PDFCheckBox)
            return { ...common, type: "checkbox" as const, value: field.isChecked() };
          if (field instanceof p.PDFDropdown || field instanceof p.PDFOptionList)
            return {
              ...common,
              type: "choice" as const,
              options: field.getOptions(),
              value: field.getSelected().join(", "),
            };
          if (field instanceof p.PDFRadioGroup)
            return {
              ...common,
              type: "choice" as const,
              options: field.getOptions(),
              value: field.getSelected() ?? "",
            };
          return { ...common, type: "unsupported" as const, value: "" };
        });
      if (
        fields.length > 1000 ||
        JSON.stringify(fields).length > 200000 ||
        pages.reduce((sum, page) => sum + page.text.length, 0) > 200000
      )
        throw new Error("This PDF range is too large. Request fewer pages.");
      return {
        ...base,
        format,
        total: pdf.numPages,
        count: pages.length,
        pages,
        fields,
        limitations: [
          "PDF edits add notes and fill existing forms. Original page text remains unchanged.",
        ],
      };
    } finally {
      await task.destroy();
    }
  }
  const { workbook } = await loadSpreadsheet(format, bytes);
  const sheet = input.sheet ? workbook.getWorksheet(input.sheet) : workbook.worksheets[0];
  if (!sheet) throw new Error("Worksheet not found.");
  applyCellEdits(workbook, input.edits ?? {}, format, true);
  const total = Math.max(sheet.rowCount, 1),
    totalColumns = Math.max(sheet.columnCount, 1);
  const calculated = await recalculateWorkbook(workbook, format !== "xlsx"),
    cells = [];
  let textSize = 0;
  const firstColumn = input.column ?? 1;
  for (let row = start + 1; row <= start + count; row++)
    for (
      let column = firstColumn;
      column < Math.min(1001, firstColumn + (input.columns ?? 12));
      column++
    ) {
      const cell = sheet.getCell(row, column),
        formula = cell.formula;
      const key = calculated.keyOf(sheet.name, row, column),
        error = calculated.errors.get(key);
      const value = formula ? `=${formula}` : cell.text;
      const rawResult =
        calculated.results.get(key) ??
        (typeof cell.value === "number" || typeof cell.value === "boolean"
          ? cell.value
          : cell.text);
      const display = error ?? calculated.formatValue(cell.numFmt, rawResult);
      textSize += value.length + display.length;
      if (value.length > 8192 || textSize > 200000)
        throw new Error("This range is too large. Request fewer rows or columns.");
      cells.push({
        sheet: sheet.name,
        row,
        column,
        value,
        display,
        ...(error ? { error } : {}),
        style: {
          bold: cell.font?.bold ?? false,
          italic: cell.font?.italic ?? false,
          numberFormat: cell.numFmt,
        },
      });
    }
  return {
    ...base,
    format,
    total,
    totalColumns,
    sheet: sheet.name,
    sheets: workbook.worksheets.map((entry) => entry.name),
    cells,
    limitations: [
      "Basic cell formatting and common formulas are supported. Unsupported formulas show an error instead of their previous cached result. Advanced Office features and macros are outside this editor's scope.",
    ],
  };
}

export async function editDocument(
  format: DocumentFormat,
  edits: DocumentEdits,
  bytes?: Uint8Array,
): Promise<Uint8Array> {
  validateDocumentEdits(format, edits, bytes !== undefined);
  if (format === "docx") {
    const blocks = bytes ? await docxHtml(bytes) : [];
    for (const patch of [...(edits.html ?? [])].sort((a, b) => b.start - a.start))
      blocks.splice(patch.start, patch.count, patch.contents);
    return exportDocx(blocks.join(""));
  }
  if (format === "pdf") {
    const p = await import("pdf-lib");
    const pdf = bytes ? await p.PDFDocument.load(bytes) : await p.PDFDocument.create();
    if (pdf.getPageCount() === 0) pdf.addPage();
    const font = await pdf.embedFont(p.StandardFonts.Helvetica);
    const notes = [...(edits.notes ?? [])];
    if (!bytes && edits.html) {
      const text = parse(edits.html.map((chunk) => chunk.contents).join("")).text;
      const lines = text.match(/.{1,80}(?:\s|$)|.{1,80}/g) ?? [];
      lines.forEach((line, index) =>
        notes.push({
          page: Math.floor(index / 45) + 1,
          x: 0.08,
          y: 0.08 + (index % 45) * 0.019,
          text: line.trim(),
        }),
      );
    }
    for (const note of notes) {
      if (note.page > 500 || note.x < 0 || note.x > 1 || note.y < 0 || note.y > 1)
        throw new Error("Invalid PDF note position.");
      if (bytes && note.page > pdf.getPageCount()) throw new Error("PDF page not found.");
      while (pdf.getPageCount() < note.page) pdf.addPage();
      const page = pdf.getPage(note.page - 1),
        { width, height } = page.getSize();
      page.drawText(note.text, {
        x: width * note.x,
        y: height * (1 - note.y) - 12,
        size: 12,
        font,
        maxWidth: Math.max(20, width * (1 - note.x)),
      });
    }
    const form = pdf.getForm();
    for (const [name, value] of Object.entries(edits.fields ?? {})) {
      const field = form.getField(name);
      if (field.isReadOnly()) throw new Error(`PDF field ${name} is read-only.`);
      if (field instanceof p.PDFTextField && typeof value === "string") field.setText(value);
      else if (field instanceof p.PDFCheckBox && typeof value === "boolean") {
        if (value) field.check();
        else field.uncheck();
      } else if (
        (field instanceof p.PDFDropdown ||
          field instanceof p.PDFOptionList ||
          field instanceof p.PDFRadioGroup) &&
        typeof value === "string"
      )
        field.select(value);
      else throw new Error(`PDF field ${name} cannot be edited with this value.`);
    }
    return pdf.save();
  }
  const { workbook, delimiter, newline, bom, trailingNewline } = await loadSpreadsheet(
    format,
    bytes,
  );
  applyCellEdits(workbook, edits, format, bytes !== undefined);
  await recalculateWorkbook(workbook, format !== "xlsx");
  if (format === "xlsx") return new Uint8Array(await workbook.xlsx.writeBuffer());
  const sheet = workbook.worksheets[0]!;
  const rows = Array.from({ length: sheet.rowCount }, (_, row) =>
    Array.from({ length: sheet.columnCount }, (_, col) => {
      const cell = sheet.getCell(row + 1, col + 1);
      return cell.formula ? `=${cell.formula}` : cell.text;
    }),
  );
  return new TextEncoder().encode(
    `${bom ? "\uFEFF" : ""}${serializeDelimitedDocument(rows, delimiter, newline)}${trailingNewline ? newline : ""}`,
  );
}

function applyCellEdits(
  workbook: ExcelJS.Workbook,
  edits: DocumentEdits,
  format: DocumentFormat,
  existing: boolean,
) {
  for (const edit of edits.cells ?? []) {
    let sheet = workbook.getWorksheet(edit.sheet);
    if (!sheet && !existing) {
      if (workbook.worksheets.length === 1 && workbook.worksheets[0]!.rowCount === 0) {
        sheet = workbook.worksheets[0]!;
        sheet.name = edit.sheet || "Sheet1";
      } else sheet = workbook.addWorksheet(edit.sheet || "Sheet1");
    }
    if (!sheet) throw new Error(`Worksheet ${edit.sheet} not found.`);
    const cell = sheet.getCell(edit.row, edit.column);
    cell.value =
      format === "xlsx"
        ? spreadsheetValue(edit.value)
        : edit.value.startsWith("=")
          ? { formula: edit.value.slice(1) }
          : edit.value;
    if (edit.style) {
      cell.font = {
        ...cell.font,
        ...(edit.style.bold !== undefined ? { bold: edit.style.bold } : {}),
        ...(edit.style.italic !== undefined ? { italic: edit.style.italic } : {}),
      };
      if (edit.style.numberFormat !== undefined) cell.numFmt = edit.style.numberFormat;
    }
  }
}

function validateDocumentEdits(format: DocumentFormat, edits: DocumentEdits, existing: boolean) {
  if (JSON.stringify(edits).length > 1000000)
    throw new Error("Document edits exceed the 1 MiB limit. Save smaller batches.");
  const spreadsheet = format === "xlsx" || format === "csv" || format === "tsv";
  if (
    (!spreadsheet && edits.cells?.length) ||
    (spreadsheet &&
      (edits.html?.length || edits.notes?.length || Object.keys(edits.fields ?? {}).length)) ||
    (format === "docx" && (edits.notes?.length || Object.keys(edits.fields ?? {}).length)) ||
    (format === "pdf" && existing && edits.html?.length)
  )
    throw new Error("These edits are not supported for this document format.");
}
