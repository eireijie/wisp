import { useEffect, useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { fileBlob } from "../api.ts";
import { Modal } from "./ui.tsx";
import { fileKind } from "./fileKind.ts";
import { renderMarkdown } from "../markdown.ts";

/** a text preview shows this much; the rest is in the download */
export const TEXT_PREVIEW_BYTES = 200_000;

const MIME: Record<"image" | "pdf", (name: string) => string> = {
  image: (n) => `image/${n.toLowerCase().match(/\.(\w+)$/)?.[1]?.replace("jpg", "jpeg") ?? "png"}`,
  pdf: () => "application/pdf",
};

/** Save a file the browser's way. */
export async function downloadFile(id: string, name: string, blob?: Blob) {
  const b = blob ?? (await fileBlob(id));
  // plain bytes, so nothing in it can run as part of Wisp's page
  const url = URL.createObjectURL(new Blob([b], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

type Loaded = { kind: "image" | "pdf"; url: string; blob: Blob } | { kind: "text"; text: string; cut: boolean; blob: Blob };

/** A file from a chat, opened: the picture, the PDF or the text, with Download. */
export function FilePreview({ id, name, onClose }: { id: string; name: string; onClose: () => void }) {
  const [file, setFile] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let url: string | null = null;
    let gone = false;
    const kind = fileKind(name);
    fileBlob(id).then(
      async (blob) => {
        if (gone) return;
        if (kind === "image" || kind === "pdf") {
          url = URL.createObjectURL(new Blob([blob], { type: MIME[kind](name) }));
          setFile({ kind, url, blob });
        } else {
          const text = await blob.slice(0, TEXT_PREVIEW_BYTES).text();
          if (!gone) setFile({ kind: "text", text, cut: blob.size > TEXT_PREVIEW_BYTES, blob });
        }
      },
      () => !gone && setFailed(true),
    );
    return () => {
      gone = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, name]);

  const save = async () => {
    setSaving(true);
    try {
      await downloadFile(id, name, file?.blob);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={<span className="block truncate pr-3">{name}</span>} label={name} onClose={onClose} wide>
      <div className="min-h-40 rounded-2xl bg-card overflow-hidden">
        {failed ? (
          <p className="p-5 text-sm text-muted">Couldn't open this file.</p>
        ) : !file ? (
          <div className="h-40 grid place-items-center text-muted" role="status" aria-label="Opening the file">
            <Loader2 size={20} className="animate-spin" />
          </div>
        ) : file.kind !== "text" ? (
          file.kind === "image" ? <img src={file.url} alt={name} className="block mx-auto max-h-[65vh] max-w-full object-contain" /> : <iframe src={file.url} title={name} className="block w-full h-[65vh] bg-white" />
        ) : /\.(md|markdown)$/i.test(name) ? (
          <div className="max-h-[65vh] overflow-auto p-4">
            <div className="prose-w text-[14.5px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(file.text, { stripFrontmatter: true }) }} />
            {file.cut && <p className="pt-3 text-sm text-muted">Showing the start. Download it for the rest.</p>}
          </div>
        ) : (
          <pre className="max-h-[65vh] overflow-auto p-4 text-[13px] leading-relaxed font-mono whitespace-pre-wrap break-words">
            {file.text}
            {file.cut && <span className="block pt-3 text-muted font-sans">Showing the start. Download it for the rest.</span>}
          </pre>
        )}
      </div>
      <div className="mt-4 flex justify-end">
        <button onClick={() => void save()} disabled={saving || failed} className="h-10 px-4 rounded-full border border-control-line bg-control font-medium hover:bg-hover inline-flex items-center gap-2 disabled:opacity-50">
          {saving ? <Loader2 size={16} className="animate-spin" /> : <Download size={16} />} Download
        </button>
      </div>
    </Modal>
  );
}
