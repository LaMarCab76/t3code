import type ExcelJS from "exceljs";

const MAX_CELLS = 200000;

/** Recalculate through dependencies, clearing cached results even when evaluation fails. */
export async function recalculateWorkbook(workbook: ExcelJS.Workbook, coerceNumericText = false) {
  const { default: FormulaParser } = await import("fast-formula-parser");
  const parsers: InstanceType<typeof FormulaParser>[] = [];
  const results = new Map<string, string | number | boolean>();
  const errors = new Map<string, string>();
  const visiting = new Set<string>();
  let evaluations = 0;
  const keyOf = (sheet: string, row: number, col: number) => `${sheet}:${row}:${col}`;
  const valueAt = (sheet: string, row: number, col: number): string | number | boolean => {
    const key = keyOf(sheet, row, col);
    if (visiting.has(key)) {
      for (const pending of visiting) errors.set(pending, "#CYCLE!");
      throw new FormulaParser.FormulaError("#CYCLE!");
    }
    if (errors.has(key)) throw new FormulaParser.FormulaError(errors.get(key)!);
    const cached = results.get(key);
    if (cached !== undefined) return cached;
    const worksheet = workbook.getWorksheet(sheet);
    if (!worksheet || row < 1 || col < 1) throw FormulaParser.FormulaError.REF;
    const cell = worksheet.getCell(row, col);
    const formula = cell.formula;
    if (!formula) {
      const value = cell.value;
      if (
        coerceNumericText &&
        typeof value === "string" &&
        value.trim() &&
        Number.isFinite(Number(value))
      )
        return Number(value);
      return typeof value === "number" || typeof value === "boolean" ? value : cell.text;
    }
    if (++evaluations > MAX_CELLS || visiting.size > 256)
      throw new FormulaParser.FormulaError("#LIMIT!");
    visiting.add(key);
    cell.value = { formula };
    try {
      const depth = visiting.size - 1;
      const parser = parsers[depth] ?? (parsers[depth] = new FormulaParser(parserOptions));
      const result = parser.parse(formula, { sheet, row, col });
      if (errors.has(key)) throw new FormulaParser.FormulaError(errors.get(key)!);
      if (result instanceof Error) throw result;
      if (typeof result !== "string" && typeof result !== "boolean" && typeof result !== "number")
        throw FormulaParser.FormulaError.VALUE;
      if (typeof result === "number" && !Number.isFinite(result))
        throw FormulaParser.FormulaError.VALUE;
      results.set(key, result);
      cell.value = { formula, result };
      return result;
    } catch (cause) {
      const error =
        errors.get(key) ??
        (cause instanceof Error && cause.name.startsWith("#") ? cause.name : "#VALUE!");
      errors.set(key, error);
      cell.value = { formula };
      throw new FormulaParser.FormulaError(error);
    } finally {
      visiting.delete(key);
    }
  };
  const extreme = (minimum: boolean, args: unknown[]) => {
    const numbers: number[] = [];
    FormulaParser.FormulaHelpers.flattenParams(args, FormulaParser.Types.NUMBER, true, (value) => {
      if (typeof value === "number") numbers.push(value);
    });
    return numbers.length
      ? numbers.reduce((result, value) =>
          minimum ? Math.min(result, value) : Math.max(result, value),
        )
      : 0;
  };
  const parserOptions = {
    functions: {
      MIN: (...args: unknown[]) => extreme(true, args),
      MAX: (...args: unknown[]) => extreme(false, args),
    },
    onCell: ({ sheet, row, col }: { sheet: string; row: number; col: number }) =>
      valueAt(sheet, row, col),
    onRange: ({
      sheet,
      from,
      to,
    }: {
      sheet: string;
      from: { row: number; col: number };
      to: { row: number; col: number };
    }) => {
      const worksheet = workbook.getWorksheet(sheet);
      if (!worksheet) throw FormulaParser.FormulaError.REF;
      const lastRow = Math.min(to.row, Math.max(worksheet.rowCount, from.row));
      const lastCol = Math.min(to.col, Math.max(worksheet.columnCount, from.col));
      if ((lastRow - from.row + 1) * (lastCol - from.col + 1) > MAX_CELLS)
        throw new FormulaParser.FormulaError("#LIMIT!");
      return Array.from({ length: lastRow - from.row + 1 }, (_, row) =>
        Array.from({ length: lastCol - from.col + 1 }, (_, col) =>
          valueAt(sheet, from.row + row, from.col + col),
        ),
      );
    },
  };
  workbook.eachSheet((sheet) =>
    sheet.eachRow((row) =>
      row.eachCell((cell) => {
        if (!cell.formula) return;
        try {
          valueAt(sheet.name, Number(cell.row), Number(cell.col));
        } catch {
          /* The grid exposes errors instead of cached values. */
        }
      }),
    ),
  );
  workbook.calcProperties.fullCalcOnLoad = true;
  return {
    results,
    errors,
    keyOf,
    formatValue: (format: string | undefined, value: string | number | boolean) => {
      try {
        return format ? FormulaParser.SSF.format(format, value) : String(value);
      } catch {
        return String(value);
      }
    },
  };
}

export function parseDelimitedDocument(text: string, delimiter: string) {
  const rows: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false;
  let cells = 0;
  for (let index = text.charCodeAt(0) === 0xfeff ? 1 : 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' && (quoted || cell === "")) {
      if (quoted && text[index + 1] === '"') {
        cell += '"';
        index++;
      } else quoted = !quoted;
    } else if (!quoted && (char === delimiter || char === "\n" || char === "\r")) {
      row.push(cell);
      cell = "";
      if (++cells > MAX_CELLS)
        throw new Error("This spreadsheet exceeds the 200,000-cell editing limit.");
      if (char !== delimiter) {
        rows.push(row);
        row = [];
        if (char === "\r" && text[index + 1] === "\n") index++;
      }
    } else {
      cell += char;
    }
  }
  if (quoted) throw new Error("This delimited file has an unclosed quoted field.");
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

export function serializeDelimitedDocument(
  rows: readonly (readonly string[])[],
  delimiter: string,
  newline: string,
) {
  return rows
    .map((row) =>
      row
        .map((cell) =>
          /["\r\n]/.test(cell) || cell.includes(delimiter)
            ? `"${cell.replaceAll('"', '""')}"`
            : cell,
        )
        .join(delimiter),
    )
    .join(newline);
}

export function spreadsheetValue(value: string): ExcelJS.CellValue {
  if (value.startsWith("=")) return { formula: value.slice(1) };
  if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) && Number.isFinite(Number(value)))
    return Number(value);
  if (/^(true|false)$/i.test(value)) return value.toLowerCase() === "true";
  return value.startsWith("'") ? value.slice(1) : value;
}
