import { useState } from "react";
import type { WorkspaceProfile } from "@t3tools/contracts";
import {
  formatWorkspaceProfileSchedule,
  removeWorkspaceProfile,
} from "@t3tools/client-runtime/workspace-profiles";
import { persistClientSettingsUpdate, useClientSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";
import { SettingsPageContainer, SettingsSection, SettingsRow } from "./settingsLayout";
import { SettingsGroup } from "./SettingsGroup";
import { WorkspaceProfileAvatar } from "../sidebar/WorkspaceProfileMenu";
import { WorkspaceProfileDialog } from "../sidebar/WorkspaceProfileDialog";
import { reportWorkspaceProfileError } from "../sidebar/useWorkspaceProfileNavigation";
import { requestConfirmDialog } from "../../confirmDialog";

export function ProfilesSettings() {
  const settings = useClientSettings();
  const [editing, setEditing] = useState<WorkspaceProfile | null | undefined>();
  const defaultId = settings.defaultWorkspaceProfileId;
  const defaultLabel =
    defaultId === undefined
      ? "Last used"
      : defaultId === null
        ? "All"
        : (settings.workspaceProfiles.find((profile) => profile.id === defaultId)?.name ?? "All");
  return (
    <SettingsPageContainer>
      <SettingsSection title="Startup" id="profile-startup">
        <SettingsGroup>
          <SettingsRow
            title="Default profile"
            description="Used when no schedule matches. Profiles and schedules are saved only on this device."
            control={
              <div className="w-full sm:w-48">
                <Select
                  value={
                    defaultId === undefined ? "last-used" : defaultId === null ? "all" : defaultId
                  }
                  onValueChange={(value) => {
                    if (typeof value !== "string") return;
                    void persistClientSettingsUpdate((current) => {
                      if (value === "last-used") {
                        const { defaultWorkspaceProfileId: _removed, ...rest } = current;
                        return rest;
                      }
                      return {
                        ...current,
                        defaultWorkspaceProfileId: value === "all" ? null : value,
                      };
                    }).catch(reportWorkspaceProfileError);
                  }}
                >
                  <SelectTrigger size="sm" aria-label="Default profile">
                    <SelectValue>{defaultLabel}</SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    <SelectItem value="last-used">Last used</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                    {settings.workspaceProfiles.map((profile) => (
                      <SelectItem key={profile.id} value={profile.id}>
                        <span className="min-w-0 truncate">{profile.name}</span>
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            }
          />
        </SettingsGroup>
      </SettingsSection>
      <SettingsSection
        title="Profiles"
        id="workspace-profiles"
        headerAction={
          <Button size="sm" variant="outline" onClick={() => setEditing(null)}>
            Create profile
          </Button>
        }
      >
        <p className="px-3 text-sm text-muted-foreground">
          Schedules apply only at startup, using this device’s local time. Edit a profile to change
          its projects or schedules.
        </p>
        <SettingsGroup>
          <div className="flex min-w-0 items-center gap-3 p-4">
            <WorkspaceProfileAvatar profile={null} />
            <span className="min-w-0 flex-1">All</span>
            <span className="text-xs text-muted-foreground">All projects</span>
          </div>
          {settings.workspaceProfiles.map((profile) => (
            <div key={profile.id} className="flex min-w-0 flex-wrap items-center gap-3 p-4">
              <WorkspaceProfileAvatar profile={profile} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{profile.name}</p>
                <p className="text-xs text-muted-foreground">
                  {profile.projects.length} {profile.projects.length === 1 ? "project" : "projects"}
                  {defaultId === profile.id ? " · Default" : ""}
                </p>
                {profile.schedules?.map((schedule) => (
                  <p
                    key={
                      schedule.id ?? `${schedule.days.join(",")}-${schedule.start}-${schedule.end}`
                    }
                    className="text-xs text-muted-foreground"
                  >
                    {formatWorkspaceProfileSchedule(schedule)}
                  </p>
                ))}
              </div>
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setEditing(profile)}>
                  Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void (async () => {
                      if (
                        !(await requestConfirmDialog(
                          `Delete ${profile.name} and its schedules? Projects and threads will stay available.`,
                          { variant: "destructive" },
                        ))
                      )
                        return;
                      await persistClientSettingsUpdate((current) => ({
                        ...current,
                        ...removeWorkspaceProfile(current, profile.id),
                      }));
                    })().catch(reportWorkspaceProfileError);
                  }}
                >
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </SettingsGroup>
        {!settings.workspaceProfiles.length ? (
          <p className="px-3 text-sm text-muted-foreground">
            Create a profile to organize your projects.
          </p>
        ) : null}
      </SettingsSection>
      {editing !== undefined ? (
        <WorkspaceProfileDialog
          key={editing?.id ?? "new"}
          profile={editing}
          onClose={() => setEditing(undefined)}
        />
      ) : null}
    </SettingsPageContainer>
  );
}
