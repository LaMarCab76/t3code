import {
  type PromptFormat,
  promptFormats,
  editPromptFormat,
  sourceFormatActive,
} from "@t3tools/client-runtime/prompt-format";
import { type Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { useEditorState } from "@tiptap/react";
import { T, useGT } from "gt-react";
import { ArrowUpIcon, BoldIcon, FileIcon, ItalicIcon, PaperclipIcon, XIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { MARKDOWN_SOURCE_MARK } from "@t3tools/client-runtime/inline-markdown";
import { collapseShownMarkdownSource } from "~/composer-markdown-source";
import {
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
} from "~/composer-rich-text-doc";

export interface FullscreenPromptControls {
  onClose: () => void;
  onSend: (event: React.MouseEvent<HTMLButtonElement>) => void;
  disabled: boolean;
  error: string | null;
  attachments: ReadonlyArray<{
    id: string;
    name: string;
    previewUrl?: string | undefined;
    open?: () => void;
  }>;
  attach: ReactNode;
  preview: ReactNode;
  suggestions: ReactNode;
}

function sourceSelection(editor: Editor) {
  const map = serializeEditorDoc(editor.state.doc);
  const at = (pos: number) => flatToMarkdown(map, pmToFlat(map, pos));
  return {
    map,
    selection: { start: at(editor.state.selection.from), end: at(editor.state.selection.to) },
  };
}

function applyEditorFormat(editor: Editor, format: PromptFormat, rich: boolean) {
  if (!editor.isEditable) return;
  editor.view.focus();
  if (rich) {
    const chain = editor.chain().command(collapseShownMarkdownSource);
    if (typeof format === "number") {
      if (editor.state.selection.$from.depth === 1 && editor.state.selection.$to.depth === 1)
        chain.toggleHeading({ level: format }).run();
    } else if (!editor.isActive("codeBlock")) chain.toggleMark(format).run();
    return;
  }
  const { map, selection } = sourceSelection(editor);
  const edit = editPromptFormat(map.value, selection, format);
  const pos = (at: number) => flatToPm(map, markdownToFlat(map, at));
  const tr = editor.state.tr;
  for (const { from, to, text } of edit.edits) tr.insertText(text, pos(from), pos(to));
  const next = serializeEditorDoc(tr.doc);
  const nextPos = (at: number) => flatToPm(next, markdownToFlat(next, at));
  editor.view.dispatch(
    tr
      .setSelection(
        TextSelection.create(tr.doc, nextPos(edit.selection.start), nextPos(edit.selection.end)),
      )
      .scrollIntoView(),
  );
}

export function FullscreenPromptEditor({
  editor,
  rich,
  controls,
  children,
}: {
  editor: Editor;
  rich: boolean;
  controls: FullscreenPromptControls;
  children: ReactNode;
}) {
  const gt = useGT();
  const [showFiles, setShowFiles] = useState(false);
  const filesOpen = showFiles && controls.attachments.length > 0;
  const toolbar = useEditorState({
    editor,
    selector: ({ editor }) => {
      const source =
        !rich || editor.isActive(MARKDOWN_SOURCE_MARK) ? sourceSelection(editor) : null;
      return {
        canMark: editor.isEditable && (!rich || !editor.isActive("codeBlock")),
        canHead:
          editor.isEditable &&
          (!rich ||
            (editor.state.selection.$from.depth === 1 &&
              editor.state.selection.$to.depth === 1 &&
              !editor.isActive("codeBlock"))),
        active: promptFormats.map((format) => {
          if (rich && typeof format === "number")
            return editor.isActive("heading", { level: format });
          if (source && sourceFormatActive(source.map.value, source.selection, format)) return true;
          return rich && typeof format === "string" && editor.isActive(format);
        }),
      };
    },
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && filesOpen) setShowFiles(false);
        else if (!open) controls.onClose();
      }}
    >
      <DialogPopup
        data-fullscreen-prompt=""
        variant="fullscreen"
        showCloseButton={false}
        initialFocus={() => {
          editor.view.focus();
          return false;
        }}
        finalFocus={() => {
          if (!editor.isDestroyed) editor.view.focus();
          return false;
        }}
      >
        <header className="relative flex shrink-0 items-center gap-2 border-b px-4 py-2">
          <DialogTitle size="sm" className="me-auto">
            <T>Edit prompt</T>
          </DialogTitle>
          {controls.attachments.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={gt("Attachments ({count})", { count: controls.attachments.length })}
              aria-expanded={filesOpen}
              onClick={() => setShowFiles(!filesOpen)}
            >
              <PaperclipIcon />
              {controls.attachments.length}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={gt("Close prompt editor")}
            onClick={controls.onClose}
          >
            <XIcon />
          </Button>
          {filesOpen && (
            <div className="absolute end-3 top-full z-10 grid max-h-[50dvh] w-72 max-w-full gap-1 overflow-y-auto rounded-xl border bg-popover p-2 text-popover-foreground shadow-lg">
              <div className="px-2 py-1 text-xs font-medium">
                <T>Attachments</T>
              </div>
              {controls.attachments.map((file) => (
                <button
                  type="button"
                  key={file.id}
                  className="flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent disabled:opacity-60"
                  aria-busy={!file.open || undefined}
                  disabled={!file.open}
                  onClick={file.open}
                >
                  {file.previewUrl ? (
                    <img src={file.previewUrl} alt="" className="size-8 rounded object-cover" />
                  ) : (
                    <FileIcon className="mx-2 size-4 shrink-0" />
                  )}
                  <span className="truncate">{file.name}</span>
                </button>
              ))}
            </div>
          )}
        </header>
        {controls.preview}
        <div
          className="scrollbar-gutter-both relative min-h-0 flex-1 overflow-y-auto"
          onPointerDown={() => setShowFiles(false)}
        >
          <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col p-5 sm:p-8">
            {children}
          </div>
        </div>
        {controls.suggestions}
        {controls.error && (
          <div role="alert" className="px-4 py-1 text-sm text-destructive">
            {controls.error}
          </div>
        )}
        <footer className="flex shrink-0 flex-wrap items-center gap-1 border-t bg-card px-2 py-2 sm:px-4">
          {controls.attach}
          {promptFormats.map((format, index) => {
            const label =
              typeof format === "number"
                ? gt("Heading {level}", { level: format })
                : format === "bold"
                  ? gt("Bold")
                  : gt("Italic");
            return (
              <Button
                key={format}
                type="button"
                size="icon-sm"
                variant={toolbar.active[index] ? "secondary" : "ghost"}
                disabled={typeof format === "number" ? !toolbar.canHead : !toolbar.canMark}
                aria-pressed={toolbar.active[index]}
                aria-label={label}
                title={label}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => applyEditorFormat(editor, format, rich)}
              >
                {typeof format === "number" ? (
                  `H${format}`
                ) : format === "bold" ? (
                  <BoldIcon />
                ) : (
                  <ItalicIcon />
                )}
              </Button>
            );
          })}
          <div className="ms-auto flex items-center gap-3">
            <span className="hidden text-xs text-muted-foreground sm:inline">
              <T>Enter for a new line</T>
            </span>
            <Button type="button" size="sm" disabled={controls.disabled} onClick={controls.onSend}>
              <T>Send</T>
              <ArrowUpIcon />
            </Button>
          </div>
        </footer>
      </DialogPopup>
    </Dialog>
  );
}
