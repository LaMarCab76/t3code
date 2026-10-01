import { Menu } from "@base-ui/react/menu";
import { CheckIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { WorkspaceProfile } from "@t3tools/contracts";
import { useClientSettings } from "../../hooks/useSettings";
import { useActiveWorkspaceProfile } from "../../state/entities";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { WorkspaceProfileDialog } from "./WorkspaceProfileDialog";
import {
  reportWorkspaceProfileError,
  useWorkspaceProfileNavigation,
} from "./useWorkspaceProfileNavigation";

export function WorkspaceProfileAvatar({ profile }: { profile: WorkspaceProfile | null }) {
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-full text-base"
      style={{ backgroundColor: profile?.color ?? "#64748b" }}
    >
      {profile?.emoji ?? "🌐"}
    </span>
  );
}

/** This feature owns its black menu surface without changing the app's theme. */
export function WorkspaceProfileMenu() {
  const settings = useClientSettings();
  const active = useActiveWorkspaceProfile();
  const selectProfile = useWorkspaceProfileNavigation();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <Menu.Root>
        <Tooltip>
          <TooltipTrigger
            render={
              <Menu.Trigger
                render={
                  <button
                    type="button"
                    aria-label={`Workspace profile: ${active?.name ?? "All"}`}
                    className="flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              />
            }
          >
            <WorkspaceProfileAvatar profile={active} />
          </TooltipTrigger>
          <TooltipPopup side="top">{active?.name ?? "All"}</TooltipPopup>
        </Tooltip>
        <Menu.Portal>
          <Menu.Positioner
            side="top"
            align="start"
            sideOffset={8}
            className="z-[130] max-w-[calc(100vw-2rem)]"
          >
            <Menu.Popup
              aria-label="Workspace profiles"
              className="w-64 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-white/15 bg-black p-1 text-white shadow-xl outline-none [-webkit-app-region:no-drag]"
            >
              <div className="max-h-[min(24rem,var(--available-height))] overflow-y-auto overscroll-contain">
                <Menu.RadioGroup
                  value={active?.id ?? ""}
                  onValueChange={(id) => {
                    void selectProfile(id || null).catch(reportWorkspaceProfileError);
                  }}
                >
                  {[null, ...settings.workspaceProfiles].map((profile) => (
                    <Menu.RadioItem
                      key={profile?.id ?? "all"}
                      value={profile?.id ?? ""}
                      className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none data-highlighted:bg-white/15"
                    >
                      <WorkspaceProfileAvatar profile={profile} />
                      <span className="min-w-0 flex-1 truncate">{profile?.name ?? "All"}</span>
                      <Menu.RadioItemIndicator>
                        <CheckIcon aria-hidden className="size-4 shrink-0" />
                      </Menu.RadioItemIndicator>
                    </Menu.RadioItem>
                  ))}
                </Menu.RadioGroup>
              </div>
              <Menu.Separator className="my-1 h-px bg-white/15" />
              <Menu.Item
                className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none data-highlighted:bg-white/15"
                onClick={() => setCreating(true)}
              >
                <PlusIcon aria-hidden className="size-4" />
                Create profile
              </Menu.Item>
              <Menu.Item
                className="flex min-h-10 cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-sm outline-none data-highlighted:bg-white/15"
                onClick={() => {
                  void navigate({ to: "/settings/profiles" });
                }}
              >
                <SettingsIcon aria-hidden className="size-4" />
                Manage profiles
              </Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
      {creating ? (
        <WorkspaceProfileDialog profile={null} onClose={() => setCreating(false)} />
      ) : null}
    </>
  );
}
