import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";
import { snapshotComposerSend } from "../ChatView.logic";
import { useLocalDispatchState } from "./useLocalDispatchState";
import { useMultipleModelSend } from "./useMultipleModelSend";

vi.mock("../../state/use-orchestration-command", () => ({
  useOrchestrationCommand: () => async () => ({ _tag: "Success", value: undefined }),
}));

it.each(["starts", "fails preparation"] as const)(
  "leaves the current thread's dispatch busy when a detached fanout %s",
  async (outcome) => {
    const environmentId = EnvironmentId.make("fanout");
    const threadId = ThreadId.make("fanout-" + outcome);
    const target = scopeThreadRef(environmentId, threadId);
    const routeThreadKey = scopedThreadKey(target);
    const activeRoute = { current: routeThreadKey };
    const attachments = Promise.withResolvers<[]>();
    let submission: Promise<void> | undefined;
    const createdAt = "2026-11-01T00:00:00.000Z";

    function Probe() {
      const dispatch = useLocalDispatchState({
        environmentId,
        activeThread: undefined,
        activeLatestRun: null,
        latestUserMessageId: null,
        phase: "ready",
        activePendingApproval: null,
        activePendingUserInput: null,
        threadError: null,
      });
      const send = useMultipleModelSend({
        environmentId,
        routeThreadKey,
        currentRouteThreadKeyRef: activeRoute,
        draftId: null,
        composerDraftTarget: target,
        composerRef: { current: null },
        promptRef: { current: "" },
        runtimeMode: "full-access",
        startFromOrigin: false,
        worktreeRepositories: undefined,
        resetLocalDispatch: dispatch.resetLocalDispatch,
        setThreadError: () => {},
      });
      const start = () => {
        dispatch.beginLocalDispatch({ preparingWorktree: true });
        const selections = ["one", "two"].map((model) => ({
          instanceId: ProviderInstanceId.make("codex"),
          model,
        }));
        submission = send({
          threadId,
          project: {
            id: ProjectId.make("project"),
            title: "Project",
            environmentId,
            workspaceRoot: "/project",
            defaultModelSelection: null,
            scripts: [],
            createdAt,
            updatedAt: createdAt,
          },
          branch: "main",
          selections,
          targets: selections.map((selection) => ({ selection, text: "Send to both models" })),
          sendSnapshot: snapshotComposerSend({
            prompt: "Send to both models",
            images: [],
            files: [],
            terminalContexts: [],
            sendableTerminalContexts: [],
            previewAnnotations: [],
            reviewComments: [],
            threadContexts: [],
            environmentContexts: [],
            replyTo: null,
          }),
          createdAt,
          attachmentsPromise: attachments.promise,
          usesAttachmentUploads: true,
          readFileBlockReason: () => null,
          buildOutgoingMessageContext: () => undefined,
          isCurrentSend: () => true,
          draftChangedDuringPreparation: () => false,
        });
      };
      return (
        <>
          <button type="button" onClick={start}>
            Send to models
          </button>
          <button
            type="button"
            onClick={() => {
              activeRoute.current = "other-thread";
              dispatch.resetLocalDispatch();
              dispatch.beginLocalDispatch();
            }}
          >
            Send from another thread
          </button>
          <output>{dispatch.isSendBusy ? "Sending" : "Idle"}</output>
        </>
      );
    }

    await using screen = await render(<Probe />);
    await screen.getByRole("button", { name: "Send to models" }).click();
    await screen.getByRole("button", { name: "Send from another thread" }).click();
    await expect.element(screen.getByRole("status")).toHaveTextContent("Sending");
    await act(async () => {
      if (outcome === "starts") attachments.resolve([]);
      else attachments.reject(new Error("Attachment unavailable"));
      await submission;
    });
    await expect.element(screen.getByRole("status")).toHaveTextContent("Sending");
  },
);
