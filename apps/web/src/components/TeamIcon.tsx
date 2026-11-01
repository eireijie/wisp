import { useRef, useState, type ReactNode } from "react";
import { Check, Image } from "lucide-react";
import { api, uploadFile } from "../api.ts";
import { useStore, type ChannelInfo } from "../store.ts";
import { ChatAvatar } from "./ChatList.tsx";
import { Modal, cx } from "./ui.tsx";

const ICON_SIDE = 512;

/** The middle square of a picture, small enough to load quickly in every chat row. */
async function squareIcon(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = Math.min(side, ICON_SIDE);
  canvas.getContext("2d")!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, "image/png"));
  if (!blob) throw new Error("no image");
  return new File([blob], "team-icon.png", { type: "image/png" });
}

/** Pick what a team's icon shows: its first two agents, or an image. */
export function TeamIconDialog({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const chosen = channel.settings?.iconFileId;

  const save = async (iconFileId: string | null) => {
    await api("PATCH", `/api/channels/${channel.id}`, { settings: { iconFileId } });
    await useStore.getState().refreshChannels();
    onClose();
  };
  const run = async (work: () => Promise<void>, failed: string) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch {
      setError(failed);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title="Team icon" onClose={onClose}>
      <div className="space-y-1">
        <Option selected={!chosen} disabled={busy} onClick={() => void run(() => save(null), "Couldn't change the icon. Try again.")} art={<ChatAvatar chat={{ kind: "team", agent: null, channel }} size={44} ghostsOnly />} title="First two agents" />
        <Option selected={!!chosen} disabled={busy} onClick={() => input.current?.click()} art={chosen ? <ChatAvatar chat={{ kind: "team", agent: null, channel }} size={44} /> : <span className="grid size-11 place-items-center rounded-full bg-chip"><Image size={19} strokeWidth={1.8} aria-hidden /></span>} title={busy ? "Uploading…" : chosen ? "Choose another image" : "Choose image"} />
      </div>
      {error && <p className="mt-2 px-2 text-sm text-bad" role="alert">{error}</p>}
      <input
        ref={input}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        aria-label="Team image"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void run(async () => save((await uploadFile(await squareIcon(file), channel.id)).id), "Couldn't use that image. Try another one.");
        }}
      />
    </Modal>
  );
}

function Option({ selected, disabled, onClick, art, title }: { selected: boolean; disabled: boolean; onClick: () => void; art: ReactNode; title: string }) {
  return (
    <button onClick={onClick} disabled={disabled} className={cx("flex min-h-16 w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left disabled:opacity-60", selected ? "bg-chip" : "hover:bg-chip")}>
      {art}
      <span className="min-w-0 flex-1 text-body font-medium">{title}</span>
      {selected && <Check size={18} aria-label="Selected" />}
    </button>
  );
}
