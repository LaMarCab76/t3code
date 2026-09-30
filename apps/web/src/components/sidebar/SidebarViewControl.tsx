import { resolveSidebarViewMode } from "@t3tools/client-runtime/workspace-profiles";
import type { SidebarViewMode } from "@t3tools/contracts";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";

export function SidebarViewControl() {
  const settings = useClientSettings();
  const update = useUpdateClientSettings();
  return (
    <label className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
      View
      <select
        aria-label="Sidebar view"
        className="rounded-md bg-transparent py-1 text-foreground"
        value={resolveSidebarViewMode(settings)}
        onChange={(event) => {
          void update({ sidebarViewMode: event.target.value as SidebarViewMode });
        }}
      >
        <option value="status">By status</option>
        <option value="projects">By project</option>
        <option value="combined">Combined</option>
      </select>
    </label>
  );
}
