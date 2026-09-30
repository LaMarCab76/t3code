import { Tabs } from "@base-ui/react/tabs";
import { useId, useState } from "react";

import { cn } from "../../lib/utils";
import { hexToHsv, hsvToHex, type HsvColor } from "../../lib/color";
import { ColorHueSlider, ColorSaturationValuePlane } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

const PROFILE_EMOJIS = [
  ["💼", "Briefcase"],
  ["🏠", "Home"],
  ["👤", "Person"],
  ["👥", "People"],
  ["🧑‍💻", "Developer"],
  ["🎯", "Target"],
  ["🚀", "Rocket"],
  ["⭐", "Star"],
  ["💡", "Idea"],
  ["🧠", "Brain"],
  ["📚", "Books"],
  ["📝", "Notes"],
  ["📊", "Chart"],
  ["📁", "Folder"],
  ["🗂️", "Files"],
  ["🛠️", "Tools"],
  ["⚙️", "Settings"],
  ["💻", "Laptop"],
  ["⌨️", "Keyboard"],
  ["📱", "Phone"],
  ["🎨", "Art"],
  ["📷", "Camera"],
  ["🎬", "Film"],
  ["🎵", "Music"],
  ["🎮", "Games"],
  ["🧩", "Puzzle"],
  ["🔬", "Science"],
  ["🔒", "Lock"],
  ["🔑", "Key"],
  ["🧭", "Compass"],
  ["🌐", "Globe"],
  ["🌎", "Earth"],
  ["☀️", "Sun"],
  ["🌙", "Moon"],
  ["⚡", "Lightning"],
  ["🔥", "Fire"],
  ["🌈", "Rainbow"],
  ["☁️", "Cloud"],
  ["🌊", "Wave"],
  ["🏔️", "Mountain"],
  ["🌳", "Tree"],
  ["🌱", "Seedling"],
  ["🌵", "Cactus"],
  ["🌸", "Flower"],
  ["🐱", "Cat"],
  ["🐶", "Dog"],
  ["🦊", "Fox"],
  ["🐻", "Bear"],
  ["🐼", "Panda"],
  ["🦁", "Lion"],
  ["🦉", "Owl"],
  ["🦋", "Butterfly"],
  ["🐝", "Bee"],
  ["🐙", "Octopus"],
  ["🐢", "Turtle"],
  ["🦄", "Unicorn"],
  ["☕", "Coffee"],
  ["🍕", "Pizza"],
  ["🍎", "Apple"],
  ["⚽", "Football"],
  ["🏀", "Basketball"],
  ["🏆", "Trophy"],
  ["🎒", "Backpack"],
  ["✈️", "Airplane"],
] as const;

const PROFILE_COLORS = [
  ["#64748b", "Slate"],
  ["#6b7280", "Gray"],
  ["#ef4444", "Red"],
  ["#f97316", "Orange"],
  ["#f59e0b", "Amber"],
  ["#eab308", "Yellow"],
  ["#84cc16", "Lime"],
  ["#22c55e", "Green"],
  ["#10b981", "Emerald"],
  ["#14b8a6", "Teal"],
  ["#06b6d4", "Cyan"],
  ["#3b82f6", "Blue"],
  ["#6366f1", "Indigo"],
  ["#8b5cf6", "Violet"],
  ["#d946ef", "Fuchsia"],
  ["#ec4899", "Pink"],
] as const;

function ProfileBackgroundColorPanel({
  color,
  onColorChange,
}: {
  color: string;
  onColorChange: (color: string) => void;
}) {
  const inputId = useId();
  const [hsv, setHsv] = useState(() => hexToHsv(color));
  const [hexDraft, setHexDraft] = useState<string | null>(null);
  const commitHsv = (next: HsvColor) => {
    setHsv(next);
    onColorChange(hsvToHex(next.h, next.s, next.v));
  };

  return (
    <div className="grid min-w-0 gap-3">
      <div
        role="group"
        aria-label="Preset background colors"
        className="grid grid-cols-6 gap-1 sm:grid-cols-8"
      >
        {PROFILE_COLORS.map(([value, name]) => (
          <button
            key={value}
            type="button"
            aria-label={name}
            aria-pressed={color.toLowerCase() === value}
            className="flex h-8 min-w-0 items-center justify-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => {
              setHexDraft(null);
              setHsv(hexToHsv(value));
              onColorChange(value);
            }}
          >
            <span
              aria-hidden
              className={cn(
                "size-6 rounded-full",
                color.toLowerCase() === value &&
                  "ring-2 ring-foreground ring-offset-2 ring-offset-popover",
              )}
              style={{ backgroundColor: value }}
            />
          </button>
        ))}
      </div>
      <ColorSaturationValuePlane label="Profile background" value={hsv} onChange={commitHsv} />
      <ColorHueSlider
        label="Profile background hue"
        value={hsv.h}
        onChange={(h) => commitHsv({ ...hsv, h })}
      />
      <div className="grid min-w-0 gap-2">
        <Label htmlFor={inputId}>Hex color</Label>
        <Input
          id={inputId}
          nativeInput
          size="compact"
          font="mono"
          maxLength={7}
          spellCheck={false}
          value={hexDraft ?? color}
          onChange={(event) => {
            const next = event.currentTarget.value;
            setHexDraft(next);
            if (!/^#[\da-f]{6}$/i.test(next)) return;
            setHsv(hexToHsv(next));
            onColorChange(next.toLowerCase());
          }}
          onBlur={() => setHexDraft(null)}
        />
      </div>
    </div>
  );
}

/** Edits the profile draft; saving or cancelling remains owned by the dialog. */
export function WorkspaceProfileAvatarPicker({
  emoji,
  color,
  onEmojiChange,
  onColorChange,
}: {
  emoji: string;
  color: string;
  onEmojiChange: (emoji: string) => void;
  onColorChange: (color: string) => void;
}) {
  const inputId = useId();
  const [emojiDraft, setEmojiDraft] = useState<string | null>(null);

  return (
    <Popover>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label="Change profile emoji and background color"
            className="flex size-12 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full text-2xl outline-none ring-offset-background hover:ring-2 hover:ring-ring/50 hover:ring-offset-2 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            style={{ backgroundColor: color }}
          />
        }
      >
        <span aria-hidden>{emoji}</span>
      </PopoverTrigger>
      <PopoverPopup width="md" align="start" sideOffset={8} aria-label="Profile icon">
        <Tabs.Root defaultValue="emoji" className="min-w-0">
          <Tabs.List aria-label="Profile icon options" className="mb-3 flex border-b border-border">
            {[
              ["emoji", "Emoji"],
              ["color", "Background color"],
            ].map(([value, label]) => (
              <Tabs.Tab
                key={value}
                value={value}
                className="flex-1 cursor-pointer border-b-2 border-transparent px-2 py-2 text-sm font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-active:border-primary data-active:text-foreground"
              >
                {label}
              </Tabs.Tab>
            ))}
          </Tabs.List>
          <Tabs.Panel value="emoji" className="grid min-w-0 gap-3">
            <div
              role="group"
              aria-label="Choose a profile emoji"
              className="grid max-h-48 grid-cols-6 gap-1 overflow-y-auto overscroll-contain p-1 sm:grid-cols-8"
            >
              {PROFILE_EMOJIS.map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={name}
                  aria-pressed={emoji === value}
                  className={cn(
                    "flex h-8 min-w-0 items-center justify-center rounded-md text-xl outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
                    emoji === value && "bg-accent ring-1 ring-ring",
                  )}
                  onClick={() => {
                    setEmojiDraft(null);
                    onEmojiChange(value);
                  }}
                >
                  <span aria-hidden>{value}</span>
                </button>
              ))}
            </div>
            <div className="grid min-w-0 gap-2">
              <Label htmlFor={inputId}>Other emoji</Label>
              <Input
                id={inputId}
                size="compact"
                value={emojiDraft ?? emoji}
                maxLength={32}
                placeholder="Paste an emoji"
                onChange={(event) => {
                  const next = event.currentTarget.value;
                  setEmojiDraft(next);
                  if (next.trim()) onEmojiChange(next.trim());
                }}
                onBlur={() => setEmojiDraft(null)}
              />
            </div>
          </Tabs.Panel>
          <Tabs.Panel value="color">
            <ProfileBackgroundColorPanel color={color} onColorChange={onColorChange} />
          </Tabs.Panel>
        </Tabs.Root>
      </PopoverPopup>
    </Popover>
  );
}
