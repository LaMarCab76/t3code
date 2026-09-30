declare module "fast-formula-parser" {
  interface CellReference {
    sheet: string;
    row: number;
    col: number;
  }
  interface RangeReference {
    sheet: string;
    from: { row: number; col: number };
    to: { row: number; col: number };
  }
  export default class FormulaParser {
    constructor(options: {
      functions?: Record<string, (...args: unknown[]) => unknown>;
      onCell: (ref: CellReference) => unknown;
      onRange: (ref: RangeReference) => unknown[][];
    });
    parse(formula: string, position: CellReference): unknown;
    static FormulaHelpers: {
      flattenParams(
        args: unknown[],
        type: number | null,
        allowLiteral: boolean,
        callback: (item: unknown) => void,
      ): void;
    };
    static Types: { NUMBER: number };
    static SSF: { format(format: string, value: string | number | boolean): string };
    static FormulaError: { new (error: string): Error; REF: Error; VALUE: Error };
  }
}

declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}
