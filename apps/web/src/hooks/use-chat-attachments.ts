import { useRef, useState } from "react";
import { attachmentMimeType, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, type ChatAttachment } from "../../../../packages/chat-attachments";

export function useChatAttachments() {
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const reading = useRef(false);
  async function addFiles(files: File[]) {
    if (reading.current || files.length === 0) return;
    setError("");
    if (files.length + attachments.length > MAX_ATTACHMENTS) {
      setError("Attach at most 5 files."); return;
    }
    if (files.reduce((size, file) => size + file.size, attachments.reduce((size, file) => size + file.size, 0)) > MAX_ATTACHMENT_BYTES) {
      setError("Attachments may total at most 10 MiB."); return;
    }
    const unsupported = files.find((file) => !attachmentMimeType(file.name) || !file.size || file.name.length > 200);
    if (unsupported) { setError(`Unsupported or empty file: ${unsupported.name}. Use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, or an image.`); return; }
    reading.current = true;
    setLoading(true);
    try {
      const added = await Promise.all(files.map((file) => new Promise<ChatAttachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error(`Could not read ${file.name}.`));
        reader.onabort = () => reject(new Error(`Reading ${file.name} was interrupted.`));
        reader.onload = () => resolve({ name: file.name, size: file.size, mimeType: attachmentMimeType(file.name)!, data: String(reader.result).split(",")[1] });
        reader.readAsDataURL(file);
      })));
      setAttachments((previous) => [...previous, ...added]);
    } catch (error) { setError(error instanceof Error ? error.message : "Could not read the files."); }
    finally { reading.current = false; setLoading(false); }
  }
  return { attachments, loading, error, addFiles, remove: (index: number) => setAttachments((files) => files.filter((_, i) => i !== index)), clear: () => { setAttachments([]); setError(""); } };
}
