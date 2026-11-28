import { inlineMarkdownDelimiters } from "./inlineMarkdown.ts";
export const promptFormats = [1, 2, 3, 4, "bold", "italic"] as const;
export type PromptFormat = (typeof promptFormats)[number];
type Selection = { start: number; end: number };

function headingPrefix(value: string, start: number) {
  const at = value.slice(0, start).lastIndexOf("\n") + 1;
  return { at, prefix: /^(#{1,6})[ \t]+/.exec(value.slice(at))?.[0] ?? "" };
}

function enclosingStyle(value: string, { start, end }: Selection, format: "bold" | "italic") {
  const offset = value.slice(0, start).lastIndexOf("\n") + 1;
  const newline = value.indexOf("\n", end);
  const line = value.slice(offset, newline === -1 ? value.length : newline);
  const match = inlineMarkdownDelimiters(line).find(
    ({ mark, delimiter, from, to }) =>
      mark === format && offset + from + delimiter.length <= start && end <= offset + to,
  );
  if (match)
    return { from: offset + match.from, to: offset + match.to, delimiter: match.delimiter };
  const delimiter = format === "bold" ? "**" : "*";
  // Empty markers are intentional while a source editor waits for the first typed character.
  if (
    start === end &&
    start >= delimiter.length &&
    value.slice(start - delimiter.length, start + delimiter.length) === delimiter + delimiter
  )
    return { from: start - delimiter.length, to: start, delimiter };
  return null;
}

export function sourceFormatActive(value: string, selection: Selection, format: PromptFormat) {
  if (typeof format === "number")
    return headingPrefix(value, selection.start).prefix.trim().length === format;
  return enclosingStyle(value, selection, format) !== null;
}

export function editPromptFormat(value: string, selection: Selection, format: PromptFormat) {
  const { start, end } = selection;
  if (typeof format === "number") {
    const { at, prefix } = headingPrefix(value, start);
    const replacement = prefix.trim().length === format ? "" : "#".repeat(format) + " ";
    const shift = (pos: number) => at + replacement.length + Math.max(0, pos - at - prefix.length);
    return {
      edits: [{ from: at, to: at + prefix.length, text: replacement }],
      selection: { start: shift(start), end: shift(end) },
    };
  }
  const style = enclosingStyle(value, selection, format);
  const delimiter = style?.delimiter ?? (format === "bold" ? "**" : "*");
  const width = delimiter.length;
  if (style && start === end && style.from + width !== style.to) {
    if (start === style.from + width || end === style.to) {
      const cursor = start === style.to ? end + width : start - width;
      return { edits: [], selection: { start: cursor, end: cursor } };
    }
  }
  const removeLeft = !!style && start === style.from + width;
  const removeRight = !!style && end === style.to;
  const shift = removeLeft ? -width : width;
  return {
    // Apply right-to-left so original offsets remain valid, including an empty selection.
    edits: [
      { from: end, to: removeRight ? end + width : end, text: removeRight ? "" : delimiter },
      { from: removeLeft ? start - width : start, to: start, text: removeLeft ? "" : delimiter },
    ],
    selection: { start: start + shift, end: end + shift },
  };
}
