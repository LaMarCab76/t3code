import { filterWorkspaceProfileThreads } from "@t3tools/client-runtime/workspace-profiles";
import { useActiveWorkspaceProfile } from "./entities";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { buildPendingNewTasks, type PendingNewTask } from "./pending-new-tasks-model";
import { flattenQueuedThreadMessages } from "./thread-outbox-model";
import { composerDraftsAtom } from "./use-composer-drafts";
import { useThreadOutboxMessages } from "./use-thread-outbox";

export type {
  PendingDraftTask,
  PendingNewTask,
  PendingQueuedTask,
} from "./pending-new-tasks-model";

export function usePendingNewTasks(): ReadonlyArray<PendingNewTask> {
  const profile = useActiveWorkspaceProfile();
  const queuedMessagesByThreadKey = useThreadOutboxMessages();
  const drafts = useAtomValue(composerDraftsAtom);
  return useMemo(
    () =>
      filterWorkspaceProfileThreads(
        buildPendingNewTasks({
          queuedMessages: flattenQueuedThreadMessages(queuedMessagesByThreadKey),
          drafts,
        }),
        profile,
      ),
    [queuedMessagesByThreadKey, drafts, profile],
  );
}
