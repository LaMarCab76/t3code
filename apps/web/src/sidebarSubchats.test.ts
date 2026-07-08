import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";

import { deriveSidebarSubchats } from "./sidebarSubchats";

function activity(
  patch: Omit<Partial<OrchestrationThreadActivity>, "id" | "payload"> & {
    readonly id: string;
    readonly payload: unknown;
  },
): OrchestrationThreadActivity {
  const { id, payload, ...rest } = patch;
  return {
    id: EventId.make(id),
    tone: "tool",
    kind: "tool.completed",
    summary: "Tool",
    turnId: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    payload,
    ...rest,
  } as OrchestrationThreadActivity;
}

describe("sidebarSubchats", () => {
  it("deduplicates Codex collab activities by receiver thread ids", () => {
    const subchats = deriveSidebarSubchats([
      activity({
        id: "evt-started",
        kind: "tool.started",
        summary: "Tool started",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Investigate failing checks",
          status: "inProgress",
          data: {
            item: {
              receiverThreadIds: ["thread-child"],
            },
          },
        },
      }),
      activity({
        id: "evt-completed",
        kind: "tool.completed",
        payload: {
          itemType: "collab_agent_tool_call",
          detail: "Investigate failing checks",
          data: {
            item: {
              receiverThreadIds: ["thread-child"],
            },
          },
        },
      }),
    ]);

    expect(subchats).toEqual([
      {
        id: "evt-started",
        label: "Investigate failing checks",
        detail: "Investigate failing checks",
        status: "completed",
        receiverThreadIds: ["thread-child"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("extracts Claude subagent labels from tool input data", () => {
    const subchats = deriveSidebarSubchats([
      activity({
        id: "evt-claude",
        kind: "tool.updated",
        payload: {
          itemType: "collab_agent_tool_call",
          status: "failed",
          data: {
            toolName: "Task",
            input: {
              description: "Audit thread projection",
              prompt: "Longer prompt not shown when a description exists",
            },
          },
        },
      }),
    ]);

    expect(
      subchats.map(({ label, detail, status, receiverThreadIds }) => ({
        label,
        detail,
        status,
        receiverThreadIds,
      })),
    ).toEqual([
      {
        label: "Audit thread projection",
        detail: "Audit thread projection",
        status: "failed",
        receiverThreadIds: [],
      },
    ]);
  });
});
