import { describe, expect, it } from "vite-plus/test";

import { resolveTimelineMinimapPreview } from "./timelineMinimapItems";

const preview = (assistantText: string) =>
  resolveTimelineMinimapPreview({ id: "turn", rowIndex: 0, userText: null, assistantText })
    ?.assistantText;

describe("resolveTimelineMinimapPreview", () => {
  it("summarizes the answer without its insight asides", () => {
    expect(preview("`★ Insight ─────`\n- Aside\n`─────`\nThe **answer**.")).toBe("The answer.");
  });

  it("falls back to the insight when the reply is only an aside", () => {
    expect(preview("`★ Insight ─────`\n- Aside\n`─────`")).toBe("Aside");
  });
});
