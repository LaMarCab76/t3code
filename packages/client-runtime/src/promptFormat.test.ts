import { expect, it } from "vite-plus/test";
import { editPromptFormat, type PromptFormat } from "./promptFormat.ts";

function apply(value: string, start: number, end: number, format: PromptFormat) {
  const edit = editPromptFormat(value, { start, end }, format);
  for (const { from, to, text } of edit.edits)
    value = value.slice(0, from) + text + value.slice(to);
  return [value, edit.selection.start, edit.selection.end];
}

it("replaces and removes only the active paragraph's heading", () => {
  expect(apply("a\n## 😀b", 6, 8, 4)).toEqual(["a\n#### 😀b", 8, 10]);
  expect(apply("a\n#### 😀b", 8, 10, 4)).toEqual(["a\n😀b", 3, 5]);
});
it("preserves the range inside emphasis and puts a caret between empty delimiters", () => {
  expect(apply("text", 0, 4, "bold")).toEqual(["**text**", 2, 6]);
  expect(apply("**text**", 2, 6, "bold")).toEqual(["text", 0, 4]);
  expect(apply("**text**", 2, 6, "italic")).toEqual(["***text***", 3, 7]);
  expect(apply("**word**", 6, 6, "bold")).toEqual(["**word**", 8, 8]);
  expect(apply("_word_", 1, 5, "italic")).toEqual(["word", 0, 4]);
  expect(apply("", 0, 0, "italic")).toEqual(["**", 1, 1]);
});
