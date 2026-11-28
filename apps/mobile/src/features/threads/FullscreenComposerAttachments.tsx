import { useGT } from "gt-react-native";
import type { ChatAttachment, EnvironmentId } from "@t3tools/contracts";
import { Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { FilePreviewSource } from "../../components/ui/FilePreviewModal";
import { composerImageGallery } from "../../lib/composerImageGallery";
import type { ComposerDocumentAttachment } from "../../lib/composerContext";
import type {
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerImages";
import { isPdfFile } from "../../lib/filePreview";
import { videoMimeType } from "@t3tools/shared/video";

export function FullscreenComposerAttachments(props: {
  environmentId: EnvironmentId;
  attachments: readonly DraftComposerAttachment[];
  queued: readonly ChatAttachment[];
  onPreview: (source: FilePreviewSource) => void;
  onVideo: (attachment: DraftComposerFileAttachment, identifier: string) => void;
  onDocument: (attachment: ComposerDocumentAttachment) => void;
}) {
  const gt = useGT();
  const files = [
    ...props.attachments.map((file) => ({
      id: file.id,
      name: file.name,
      image: file.mimeType.startsWith("image/"),
      open: () => {
        const image = composerImageGallery([file])[0];
        if (image) props.onPreview(image);
        else if (file.type === "file" && videoMimeType(file))
          props.onVideo(file, `draft-video:${file.id}`);
        else if (file.type === "file" && isPdfFile(file))
          props.onPreview({ kind: "pdf", name: file.name, attachment: file });
        else
          props.onDocument({
            attachmentId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            sizeBytes: file.sizeBytes,
          });
      },
    })),
    ...props.queued.map((file) => ({
      id: file.id,
      name: file.name,
      image: file.mimeType.startsWith("image/"),
      open: () =>
        props.onPreview({
          environmentId: props.environmentId,
          name: file.name,
          mimeType: file.mimeType,
          kind: file.mimeType.startsWith("image/") ? "image" : isPdfFile(file) ? "pdf" : "document",
          resource: {
            _tag: "attachment",
            attachmentId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            disposition: "inline",
          },
        }),
    })),
  ];
  return (
    <View className="absolute right-2 top-12 z-10 max-h-[45%] w-64 max-w-full rounded-xl border border-border bg-screen p-1">
      <ScrollView keyboardShouldPersistTaps="always">
        {files.map((file) => (
          <Pressable
            key={file.id}
            accessibilityRole="button"
            accessibilityLabel={gt("Open {name}", { name: file.name })}
            onPress={file.open}
            className="min-h-[44px] flex-row items-center gap-2 rounded-lg px-3 active:bg-subtle"
          >
            <SymbolView
              name={file.image ? "photo" : "doc"}
              size={18}
              tintColorClassName="accent-foreground-muted"
            />
            <AppText numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
              {file.name}
            </AppText>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
