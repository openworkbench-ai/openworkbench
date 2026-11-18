import { useRef } from "react";
import { Paperclip } from "lucide-react";
import { Attachment, AttachmentList } from "@/components/ui/attachment";
import { ATTACHMENT_ACCEPT, type AttachmentSummary } from "../../../../../packages/chat-attachments";

export function ChatAttachmentPicker({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <input ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT} disabled={disabled} className="hidden" aria-label="Choose attachments" onChange={(event) => {
        onFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      <button type="button" aria-label="Attach files" title="Attach images or documents (up to 5 files, 10 MiB total)" disabled={disabled} onClick={() => input.current?.click()} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">
        <Paperclip className="size-4" />
      </button>
    </>
  );
}

export function ChatAttachmentList({ files, onRemove }: { files?: AttachmentSummary[]; onRemove?: (index: number) => void }) {
  if (!files?.length) return null;
  return <AttachmentList className="my-2 px-1">
    {files.map((file, index) => <Attachment key={`${index}-${file.name}`} name={file.name} title={file.name} kind={file.mimeType.startsWith("image/") ? "image" : "text"} size={file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`} onRemove={onRemove ? () => onRemove(index) : undefined} />)}
  </AttachmentList>;
}
