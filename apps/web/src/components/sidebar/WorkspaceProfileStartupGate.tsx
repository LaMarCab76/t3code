import { useEffect, useState, type ReactNode } from "react";
import { useLocation } from "@tanstack/react-router";
import { resolveInitialWorkspaceProfileId } from "@t3tools/client-runtime/workspace-profiles";
import { ensureClientSettingsHydrated, persistClientSettingsUpdate } from "../../hooks/useSettings";
import { Button } from "../ui/button";

let startup: Promise<void> | undefined;
let initialized = false;
let landingPending = true;
export const isProfileStartupLandingPending = () => landingPending;
export const finishProfileStartupLanding = () => {
  landingPending = false;
};

function initialize() {
  if (initialized) return Promise.resolve();
  startup ??= ensureClientSettingsHydrated()
    .then(() => {
      const now = new Date();
      return persistClientSettingsUpdate((current) => ({
        ...current,
        activeWorkspaceProfileId: resolveInitialWorkspaceProfileId(current, now),
      }));
    })
    .then(() => {
      initialized = true;
    })
    .catch((cause: unknown) => {
      startup = undefined;
      throw cause;
    });
  return startup;
}

/** Holds automatic navigation until this window's one-time profile selection is confirmed. */
export function WorkspaceProfileStartupGate({ children }: { children: ReactNode }) {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [ready, setReady] = useState(initialized);
  const [error, setError] = useState(false);
  useEffect(() => {
    if (error) return;
    let mounted = true;
    void initialize()
      .then(() => {
        if (pathname !== "/") finishProfileStartupLanding();
        if (mounted) setReady(true);
      })
      .catch(() => {
        if (mounted) setError(true);
      });
    return () => {
      mounted = false;
    };
  }, [error, pathname]);
  if (ready) return children;
  if (!error) return null;
  return (
    <div className="flex h-dvh flex-col items-center justify-center gap-4">
      <p>Could not load profile preferences.</p>
      <Button
        onClick={() => {
          setError(false);
        }}
      >
        Retry
      </Button>
    </div>
  );
}
