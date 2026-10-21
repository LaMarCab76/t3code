import { describe, expect, it } from "vite-plus/test";

import { assistantInsightPreview, splitAssistantInsights } from "./assistantInsights.ts";

const OPEN = "`★ Insight ─────────────────────────────────────`";
const CLOSE = "`─────────────────────────────────────────────────`";

describe("splitAssistantInsights", () => {
  it("cuts at the closer line even when prose follows without a blank line", () => {
    const text = `Intro\n\n${OPEN}\n- **First** point\n- Second point\n${CLOSE}\nDone: the commit is pushed.`;

    expect(splitAssistantInsights(text)).toEqual([
      { kind: "markdown", markdown: "Intro\n\n", sourceOffset: 0 },
      {
        kind: "insight",
        markdown: "- **First** point\n- Second point\n",
        sourceOffset: text.indexOf(OPEN),
      },
      {
        kind: "markdown",
        markdown: "Done: the commit is pushed.",
        sourceOffset: text.indexOf("Done"),
      },
    ]);
  });

  it("splits every insight in a message and accepts the unquoted form", () => {
    const text = `${OPEN}\nOne\n${CLOSE}\n\nBetween\n\n★ Insight ─────\nTwo\n─────\n`;

    expect(splitAssistantInsights(text).map(({ kind, markdown }) => ({ kind, markdown }))).toEqual([
      { kind: "insight", markdown: "One\n" },
      { kind: "markdown", markdown: "\nBetween\n\n" },
      { kind: "insight", markdown: "Two\n" },
    ]);
  });

  it.each([
    ["inside fenced code", `\`\`\`md\n${OPEN}\nExample\n${CLOSE}\n\`\`\``],
    ["inside a tilde fence", `~~~\n${OPEN}\nExample\n${CLOSE}\n~~~`],
    ["mentioned inline", `The \`★ Insight\` blocks look like ${OPEN}\nExample\n${CLOSE}`],
    ["nested in a list", `- Item\n\n    ${OPEN}\n    Example\n    ${CLOSE}`],
    ["empty", `${OPEN}\n\n${CLOSE}`],
  ])("leaves an insight %s as Markdown", (_label, text) => {
    expect(splitAssistantInsights(text)).toEqual([
      { kind: "markdown", markdown: text, sourceOffset: 0 },
    ]);
  });

  it("keeps an unclosed insight as Markdown once complete but folds it while streaming", () => {
    const text = `Intro\n\n${OPEN}\n- Still writing`;

    expect(splitAssistantInsights(text)).toEqual([
      { kind: "markdown", markdown: text, sourceOffset: 0 },
    ]);
    expect(splitAssistantInsights(text, { streaming: true })).toEqual([
      { kind: "markdown", markdown: "Intro\n\n", sourceOffset: 0 },
      { kind: "insight", markdown: "- Still writing", sourceOffset: 7 },
    ]);
  });

  it("lets a later opener replace one that never closed", () => {
    const text = `${OPEN}\nOrphan\n\n${OPEN}\nKept\n${CLOSE}`;

    expect(splitAssistantInsights(text)).toEqual([
      { kind: "markdown", markdown: `${OPEN}\nOrphan\n\n`, sourceOffset: 0 },
      { kind: "insight", markdown: "Kept\n", sourceOffset: text.lastIndexOf(OPEN) },
    ]);
  });

  it("reads CRLF line endings", () => {
    const text = `${OPEN}\r\nWindows line\r\n${CLOSE}\r\nAfter`;

    expect(splitAssistantInsights(text).map((segment) => segment.kind)).toEqual([
      "insight",
      "markdown",
    ]);
  });
});

describe("assistantInsightPreview", () => {
  it("reads the first point as plain text", () => {
    expect(
      assistantInsightPreview("- **La regla clave** es la `HOST_TIPO`\n  concordancia\n- Otra"),
    ).toBe("La regla clave es la HOST_TIPO concordancia");
  });
});
