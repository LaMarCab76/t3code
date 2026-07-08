import type { OrchestrationThreadActivity } from "@t3tools/contracts";

export type SidebarSubchatStatus = "running" | "completed" | "failed";

export interface SidebarSubchatSummary {
  readonly id: string;
  readonly label: string;
  readonly detail: string | null;
  readonly status: SidebarSubchatStatus;
  readonly receiverThreadIds: ReadonlyArray<string>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> | null {
  return isRecord(activity.payload) ? activity.payload : null;
}

function firstReadableLine(value: unknown): string | null {
  const text = stringValue(value);
  if (!text) {
    return null;
  }
  const normalized = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function collectReceiverThreadIds(
  value: unknown,
  output = new Set<string>(),
  depth = 0,
): Set<string> {
  if (depth > 5 || !isRecord(value)) {
    return output;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (key === "receiverThreadIds" && Array.isArray(entry)) {
      for (const candidate of entry) {
        const threadId = stringValue(candidate);
        if (threadId) {
          output.add(threadId);
        }
      }
      continue;
    }
    if (isRecord(entry)) {
      collectReceiverThreadIds(entry, output, depth + 1);
    } else if (Array.isArray(entry)) {
      for (const nested of entry) {
        collectReceiverThreadIds(nested, output, depth + 1);
      }
    }
  }
  return output;
}

function stringAtPath(value: unknown, path: ReadonlyArray<string>): string | null {
  let current = value;
  for (const segment of path) {
    if (!isRecord(current)) {
      return null;
    }
    current = current[segment];
  }
  return firstReadableLine(current);
}

function subchatLabel(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): string {
  const data = payload.data;
  const candidates = [
    payload.detail,
    stringAtPath(data, ["item", "title"]),
    stringAtPath(data, ["item", "summary"]),
    stringAtPath(data, ["item", "prompt"]),
    stringAtPath(data, ["input", "description"]),
    stringAtPath(data, ["input", "prompt"]),
    stringAtPath(data, ["toolName"]),
    activity.summary.replace(/\s+started$/i, ""),
  ];
  for (const candidate of candidates) {
    const label = firstReadableLine(candidate);
    if (label && label.toLowerCase() !== "tool") {
      return label;
    }
  }
  return "Subchat";
}

function subchatDetail(payload: Record<string, unknown>): string | null {
  const data = payload.data;
  return (
    firstReadableLine(payload.detail) ??
    stringAtPath(data, ["input", "description"]) ??
    stringAtPath(data, ["input", "prompt"]) ??
    null
  );
}

function activityStatus(
  activity: OrchestrationThreadActivity,
  payload: Record<string, unknown>,
): SidebarSubchatStatus {
  const payloadStatus = stringValue(payload.status);
  if (payloadStatus === "failed" || activity.tone === "error" || activity.kind.includes("failed")) {
    return "failed";
  }
  if (payloadStatus === "completed" || activity.kind === "tool.completed") {
    return "completed";
  }
  return "running";
}

function mergeStatus(
  previous: SidebarSubchatStatus,
  next: SidebarSubchatStatus,
): SidebarSubchatStatus {
  if (previous === "failed" || next === "failed") {
    return "failed";
  }
  return next;
}

export function deriveSidebarSubchats(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<SidebarSubchatSummary> {
  const byKey = new Map<string, SidebarSubchatSummary>();

  for (const activity of activities) {
    const payload = payloadRecord(activity);
    if (payload?.itemType !== "collab_agent_tool_call") {
      continue;
    }

    const receiverThreadIds = [...collectReceiverThreadIds(payload.data)].sort();
    const label = subchatLabel(activity, payload);
    const detail = subchatDetail(payload);
    const key =
      receiverThreadIds.length > 0
        ? `receiver:${receiverThreadIds.join("|")}`
        : `label:${activity.turnId ?? "thread"}:${label}`;
    const existing = byKey.get(key);
    const nextStatus = activityStatus(activity, payload);

    if (!existing) {
      byKey.set(key, {
        id: String(activity.id),
        label,
        detail,
        status: nextStatus,
        receiverThreadIds,
        createdAt: activity.createdAt,
        updatedAt: activity.createdAt,
      });
      continue;
    }

    byKey.set(key, {
      ...existing,
      label: existing.label === "Subchat" ? label : existing.label,
      detail: existing.detail ?? detail,
      status: mergeStatus(existing.status, nextStatus),
      receiverThreadIds:
        existing.receiverThreadIds.length > 0 ? existing.receiverThreadIds : receiverThreadIds,
      updatedAt: activity.createdAt,
    });
  }

  return [...byKey.values()];
}
