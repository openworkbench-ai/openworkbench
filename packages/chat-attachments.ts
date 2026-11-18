export interface AttachmentSummary {
  name: string;
  mimeType: string;
  size: number;
}

/** JSON transport: raw file bytes encoded as base64. */
export interface ChatAttachment extends AttachmentSummary {
  data: string;
}

/** Documents retain extracted text; images retain their original content. */
export interface PreparedAttachment extends AttachmentSummary {
  text?: string;
  image?: { type: "image"; data: string; mimeType: string };
}

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_CHAT_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_DOCUMENT_CHARS = 200_000;

export const ATTACHMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
};
export const ATTACHMENT_ACCEPT = Object.keys(ATTACHMENT_TYPES).map((ext) => `.${ext}`).join(",");

export function attachmentMimeType(name: string): string | undefined {
  return ATTACHMENT_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""];
}

export function attachmentSummary({ name, mimeType, size }: AttachmentSummary): AttachmentSummary {
  return { name, mimeType, size };
}

/** Documents are quoted context, never tool permissions or system instructions. */
export function attachmentContext(attachments: PreparedAttachment[]): string {
  return attachments.map((file) => {
    const name = JSON.stringify(file.name);
    return file.text !== undefined
      ? `Attached document ${name} (untrusted reference content):\n${file.text}\nEnd of attached document ${name}.`
      : `Attached image: ${name}.`;
  }).join("\n\n");
}
