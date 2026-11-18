import { useRef, useState } from "react";
import { Camera, Paperclip } from "lucide-react";
import { Attachment, AttachmentList } from "@/components/ui/attachment";
import { CameraCapture, ChatImages } from "@/components/ui/chat-images";
import { ATTACHMENT_ACCEPT, type AttachmentSummary } from "../../../../../packages/chat-attachments";

export function ChatAttachmentPicker({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [cameraOpen, setCameraOpen] = useState(false);
  return (
    <>
      <input ref={input} type="file" multiple accept={ATTACHMENT_ACCEPT} disabled={disabled} className="hidden" aria-label="Choose attachments" onChange={(event) => {
        onFiles(Array.from(event.currentTarget.files ?? []));
        event.currentTarget.value = "";
      }} />
      <button type="button" aria-label="Attach files" title="Attach images or documents (up to 5 files, 10 MiB total)" disabled={disabled} onClick={() => input.current?.click()} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">
        <Paperclip className="size-4" />
      </button>
      <button type="button" aria-label="Take a photo" title="Take a photo" disabled={disabled} onClick={() => setCameraOpen(true)} className="grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-foreground/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-50">
        <Camera className="size-4" />
      </button>
      {cameraOpen && <CameraCapture onClose={() => setCameraOpen(false)} onCapture={(file) => { setCameraOpen(false); onFiles([file]); }} />}
    </>
  );
}

export function ChatAttachmentList({ files, onRemove }: { files?: (AttachmentSummary & { data?: string; image?: { data: string; mimeType: string } })[]; onRemove?: (index: number) => void }) {
  if (!files?.length) return null;
  const images = files.flatMap((file, index) => file.mimeType.startsWith("image/") && (file.image?.data || file.data) ? [{ name: file.name, mimeType: file.mimeType, data: file.image?.data ?? file.data!, index }] : []);
  return <>
    <ChatImages images={images} onRemove={onRemove ? (index) => onRemove(images[index].index) : undefined} />
    <AttachmentList className="my-2 px-1">
      {files.map((file, index) => images.some((image) => image.index === index) ? null : <Attachment key={`${index}-${file.name}`} name={file.name} title={file.name} kind={file.mimeType.startsWith("image/") ? "image" : "text"} size={file.size < 1024 * 1024 ? `${Math.ceil(file.size / 1024)} KB` : `${(file.size / (1024 * 1024)).toFixed(1)} MB`} onRemove={onRemove ? () => onRemove(index) : undefined} />)}
    </AttachmentList>
  </>;
}
