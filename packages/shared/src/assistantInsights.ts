import type { Nodes } from "mdast";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type AssistantInsightSegment =
  | { readonly kind: "markdown"; readonly markdown: string; readonly sourceOffset: number }
  | { readonly kind: "insight"; readonly markdown: string; readonly sourceOffset: number };

const INSIGHT_MARKER = "★ Insight";
const INSIGHT_OPENER = /^ {0,3}(`?)★ Insight[ \t]*─+[ \t]*\1[ \t]*$/u;
const INSIGHT_CLOSER = /^ {0,3}(`?)─{3,}[ \t]*\1[ \t]*$/u;
const FENCE_OPENER = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Claude's Explanatory and Learning output styles wrap asides in a
 * `` `★ Insight ───` `` line and a `` `───` `` line. Claude rarely leaves a blank
 * line before the closer, so CommonMark folds the closer, and any prose right after
 * it, into the preceding list item or paragraph. Blocks are therefore found on
 * source lines before parsing. Only top-level lines outside fenced code count.
 *
 * A block with no closer stays Markdown once the message completes, so a forgotten
 * closer cannot fold the rest of the answer away. While streaming it runs to the end.
 */
export function splitAssistantInsights(
  text: string,
  options: { readonly streaming?: boolean } = {},
): ReadonlyArray<AssistantInsightSegment> {
  if (!text.includes(INSIGHT_MARKER))
    return [{ kind: "markdown", markdown: text, sourceOffset: 0 }];

  const segments: AssistantInsightSegment[] = [];
  let cursor = 0;
  let fence: { readonly marker: string } | null = null;
  let open: { readonly start: number; readonly bodyStart: number } | null = null;
  const pushInsight = (start: number, body: string, next: number) => {
    if (start > cursor) {
      segments.push({
        kind: "markdown",
        markdown: text.slice(cursor, start),
        sourceOffset: cursor,
      });
    }
    segments.push({ kind: "insight", markdown: body, sourceOffset: start });
    cursor = next;
  };

  for (let start = 0; start < text.length;) {
    const newline = text.indexOf("\n", start);
    const next = newline === -1 ? text.length : newline + 1;
    const line = text.slice(start, newline === -1 ? text.length : newline).replace(/\r$/, "");
    const lineStart = start;
    start = next;

    if (fence) {
      const [, marker = "", rest = ""] = FENCE_OPENER.exec(line) ?? [];
      if (marker[0] === fence.marker[0] && marker.length >= fence.marker.length && !rest.trim()) {
        fence = null;
      }
      continue;
    }
    const fenceOpening = FENCE_OPENER.exec(line);
    if (fenceOpening?.[1] && !(fenceOpening[1][0] === "`" && fenceOpening[2]?.includes("`"))) {
      fence = { marker: fenceOpening[1] };
      continue;
    }
    if (INSIGHT_OPENER.test(line)) {
      open = { start: lineStart, bodyStart: next };
      continue;
    }
    if (open && INSIGHT_CLOSER.test(line)) {
      const body = text.slice(open.bodyStart, lineStart);
      if (body.trim()) pushInsight(open.start, body, next);
      open = null;
    }
  }

  if (open && options.streaming) pushInsight(open.start, text.slice(open.bodyStart), text.length);
  if (cursor < text.length) {
    segments.push({ kind: "markdown", markdown: text.slice(cursor), sourceOffset: cursor });
  }
  return segments;
}

const previewParser = unified().use(remarkParse).freeze();

function plainText(node: Nodes): string {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "image") return node.alt ?? "";
  if (node.type === "break") return " ";
  return "children" in node ? node.children.map(plainText).join("") : "";
}

function firstTextBlock(node: Nodes): Nodes | undefined {
  if (node.type === "paragraph" || node.type === "heading") return node;
  if (!("children" in node)) return undefined;
  for (const child of node.children) {
    const block = firstTextBlock(child);
    if (block) return block;
  }
  return undefined;
}

/** The first paragraph of an insight as plain text, shown while the block is collapsed. */
export function assistantInsightPreview(markdown: string): string {
  const block = firstTextBlock(previewParser.parse(markdown));
  return block ? plainText(block).replace(/\s+/g, " ").trim() : "";
}
