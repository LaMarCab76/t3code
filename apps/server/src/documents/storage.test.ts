// @effect-diagnostics nodeBuiltinImport:off -- Binary codec tests use the same async filesystem boundary as document storage.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { PDFDocument } from "pdf-lib";
import ExcelJS from "exceljs";
import {
  createWorkspaceDocument,
  readWorkspaceDocument,
  saveWorkspaceDocumentCopy,
} from "./storage.ts";
import { documentRevision, editDocument, readDocument } from "./codec.ts";
import { parseDelimitedDocument, serializeDelimitedDocument } from "./spreadsheet.ts";

const threadId = ThreadId.make("documents-test");
async function workspace<T>(
  run: (context: { root: string; attachmentPath: (id: string) => string | null }) => Promise<T>,
) {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-documents-"));
  try {
    return await run({ root, attachmentPath: () => null });
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe("document copies", () => {
  it("edits a semicolon CSV in bounded ranges, preserves the original and reopens distinct copies", async () =>
    workspace(async (context) => {
      const original = '\uFEFFName;Value\r\n"a;b";2\r\nTotal;=SUM(B2:B2)\r\n';
      await NodeFSP.writeFile(NodePath.join(context.root, "data.csv"), original);
      const source = { kind: "workspace" as const, path: "data.csv" };
      const page = await readWorkspaceDocument(context, {
        threadId,
        source,
        start: 1,
        count: 2,
        columns: 2,
      });
      expect(page.format).toBe("csv");
      if (page.format !== "csv") throw new Error("Expected CSV");
      expect(page.cells.find((cell) => cell.row === 3 && cell.column === 2)?.display).toBe("2");
      const edits = { cells: [{ sheet: "Sheet1", row: 2, column: 2, value: "4" }] };
      const first = await saveWorkspaceDocumentCopy(context, {
        threadId,
        source,
        revision: page.revision,
        edits,
      });
      const second = await saveWorkspaceDocumentCopy(context, {
        threadId,
        source,
        revision: page.revision,
        edits,
      });
      expect(first.relativePath).not.toBe(second.relativePath);
      expect(await NodeFSP.readFile(NodePath.join(context.root, "data.csv"), "utf8")).toBe(
        original,
      );
      expect(await NodeFSP.readFile(NodePath.join(context.root, first.relativePath), "utf8")).toBe(
        original.replace('"a;b";2', '"a;b";4'),
      );
      const reopened = await readWorkspaceDocument(context, {
        threadId,
        source: first.source,
        start: 2,
        count: 1,
        columns: 2,
      });
      if (reopened.format !== "csv") throw new Error("Expected CSV");
      expect(reopened.cells[1]?.display).toBe("4");
      await NodeFSP.writeFile(NodePath.join(context.root, "data.csv"), "changed");
      await expect(
        saveWorkspaceDocumentCopy(context, { threadId, source, revision: page.revision, edits }),
      ).rejects.toThrow("changed");
    }));

  it("keeps quoted punctuation out of CSV delimiter detection", async () =>
    workspace(async (context) => {
      await NodeFSP.writeFile(NodePath.join(context.root, "quoted.csv"), '"a;b;c",Value\nName,2\n');
      const page = await readWorkspaceDocument(context, {
        threadId,
        source: { kind: "workspace", path: "quoted.csv" },
        count: 2,
        columns: 2,
      });
      if (page.format !== "csv") throw new Error("Expected CSV");
      expect(page.cells.map((cell) => cell.value)).toEqual(["a;b;c", "Value", "Name", "2"]);
    }));

  it("creates a DOCX with basic formatting and edits a copy", async () =>
    workspace(async (context) => {
      const file = await createWorkspaceDocument(context, {
        threadId,
        name: "report.docx",
        format: "docx",
        contents: {
          html: [
            {
              start: 0,
              count: 0,
              contents:
                '<h1>Report</h1><p><strong>Bold</strong> and <em>italic</em> <a href="https://example.com">link</a></p><ul><li>First</li></ul><table><tr><td><p>Cell</p></td></tr></table>',
            },
          ],
        },
      });
      expect(file.relativePath.startsWith("artifacts/")).toBe(true);
      const page = await readWorkspaceDocument(context, {
        threadId,
        source: file.source,
        count: 10,
      });
      if (page.format !== "docx") throw new Error("Expected DOCX");
      expect(page.html).toContain("<h1>Report</h1>");
      expect(page.html).toContain("<strong>Bold</strong>");
      expect(page.html).toContain("<table>");
      expect(page.html).toContain("First");
      const copy = await saveWorkspaceDocumentCopy(context, {
        threadId,
        source: file.source,
        revision: page.revision,
        edits: { html: [{ start: 0, count: 1, contents: "<h1>Updated</h1>" }] },
      });
      const reopened = await readWorkspaceDocument(context, {
        threadId,
        source: copy.source,
        count: 10,
      });
      expect(reopened.format === "docx" && reopened.html).toContain("Updated");
      const original = await readWorkspaceDocument(context, {
        threadId,
        source: file.source,
        count: 1,
      });
      expect(original.format === "docx" && original.html).toContain("Report");
    }));

  it("fills PDF forms and adds notes without changing the source", async () =>
    workspace(async (context) => {
      const pdf = await PDFDocument.create();
      const page = pdf.addPage();
      pdf.getForm().createTextField("name").addToPage(page);
      pdf.getForm().createCheckBox("accepted").addToPage(page, { x: 50, y: 50 });
      const bytes = await pdf.save();
      await NodeFSP.writeFile(NodePath.join(context.root, "form.pdf"), bytes);
      const copy = await saveWorkspaceDocumentCopy(context, {
        threadId,
        source: { kind: "workspace", path: "form.pdf" },
        revision: documentRevision(bytes),
        edits: {
          fields: { name: "Ada", accepted: true },
          notes: [{ page: 1, x: 0.1, y: 0.2, text: "Reviewed" }],
        },
      });
      const reopened = await PDFDocument.load(
        await NodeFSP.readFile(NodePath.join(context.root, copy.relativePath)),
      );
      expect(reopened.getForm().getTextField("name").getText()).toBe("Ada");
      expect(reopened.getForm().getCheckBox("accepted").isChecked()).toBe(true);
      expect(await NodeFSP.readFile(NodePath.join(context.root, "form.pdf"))).toEqual(
        Buffer.from(bytes),
      );
      const viewed = await readWorkspaceDocument(context, {
        threadId,
        source: copy.source,
        count: 1,
      });
      expect(viewed.format === "pdf" && viewed.pages[0]?.text).toContain("Reviewed");
    }));

  it("rejects damaged files, traversal, foreign attachments and edits of the wrong format", async () =>
    workspace(async (context) => {
      await NodeFSP.writeFile(NodePath.join(context.root, "broken.xlsx"), "damaged");
      await expect(
        readWorkspaceDocument(context, {
          threadId,
          source: { kind: "workspace", path: "broken.xlsx" },
        }),
      ).rejects.toThrow();
      await expect(
        readWorkspaceDocument(context, { threadId, source: { kind: "workspace", path: "../" } }),
      ).rejects.toThrow("outside");
      await expect(
        readWorkspaceDocument(context, {
          threadId,
          source: { kind: "attachment", id: "foreign", name: "data.csv" },
        }),
      ).rejects.toThrow("not found");
      await expect(
        createWorkspaceDocument(context, {
          threadId,
          name: "data.csv",
          format: "csv",
          contents: { html: [{ start: 0, count: 0, contents: "invalid" }] },
        }),
      ).rejects.toThrow("not supported");
    }));
});

describe("spreadsheet calculation", () => {
  it("recalculates references, ranges and common functions and clears stale results on cycles and unsupported formulas", async () => {
    const workbook = new ExcelJS.Workbook(),
      sheet = workbook.addWorksheet("Values");
    sheet.getCell("A1").value = 2;
    sheet.getCell("A2").value = 4;
    const formulas = [
      "SUM(A1:A2)",
      "AVERAGE(A1:A2)",
      "MIN(A1:A2)",
      "MAX(A1:A2)",
      "COUNT(A1:A2)",
      "IF(A1>1,A2*2,0)",
      "B8",
      "B7",
      "UNKNOWN_FUNCTION(A1)",
    ];
    formulas.forEach((formula, index) => {
      sheet.getCell(index + 1, 2).value = { formula, result: 999 };
    });
    const bytes = new Uint8Array(await workbook.xlsx.writeBuffer());
    const page = await readDocument(bytes, "data.xlsx", { count: 9, columns: 2 });
    if (page.format !== "xlsx") throw new Error("Expected XLSX");
    const cells = page.cells.filter((cell) => cell.column === 2);
    expect(cells.slice(0, 6).map((cell) => cell.display)).toEqual(["6", "3", "2", "4", "2", "8"]);
    expect(cells.slice(6).every((cell) => cell.error && cell.display !== "999")).toBe(true);
    const saved = await editDocument(
      "xlsx",
      {
        cells: [
          {
            sheet: "Values",
            row: 1,
            column: 1,
            value: "3",
            style: { bold: true, numberFormat: "0.00" },
          },
        ],
      },
      bytes,
    );
    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.load(new Uint8Array(saved).buffer);
    expect(reopened.getWorksheet("Values")?.getCell("B1").result).toBe(7);
    expect(reopened.getWorksheet("Values")?.getCell("B7").result).toBeUndefined();
    expect(reopened.getWorksheet("Values")?.getCell("A1").font.bold).toBe(true);
  });
  it("roundtrips quoted tabs and multiline values", () => {
    const rows = [
      ["one\ttwo", "multi\nline", 'a"b'],
      ["", "tail"],
    ];
    expect(parseDelimitedDocument(serializeDelimitedDocument(rows, "\t", "\r\n"), "\t")).toEqual(
      rows,
    );
    expect(() => parseDelimitedDocument('"broken', ",")).toThrow("unclosed");
  });
});
