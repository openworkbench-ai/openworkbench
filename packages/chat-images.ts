/** Shared upload contract. Data is raw base64, without a data URL prefix. */
export interface ChatImage {
  name: string;
  mimeType: string;
  data: string;
}

export const CHAT_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
// Four base64-encoded 5 MiB images, plus JSON and the message.
export const MAX_CHAT_BODY_BYTES = 28 * 1024 * 1024;

export function chatImageUrl(image: ChatImage): string {
  return `data:${image.mimeType};base64,${image.data}`;
}

/** Validate untrusted JSON before passing it into the model SDK. */
export function parseChatImages(value: unknown): ChatImage[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_CHAT_IMAGES)
    throw new Error(`Attach up to ${MAX_CHAT_IMAGES} images per message.`);
  return value.map((image: unknown) => {
    if (!image || typeof image !== "object") throw new Error("Invalid image attachment.");
    const { name, mimeType, data } = image as Record<string, unknown>;
    if (typeof name !== "string" || !name.trim() || name.length > 255 ||
        typeof mimeType !== "string" || !CHAT_IMAGE_TYPES.includes(mimeType) ||
        typeof data !== "string" || !data.length)
      throw new Error("Images must be JPEG, PNG, WebP or GIF files with a name.");
    if (data.length > Math.ceil(MAX_CHAT_IMAGE_BYTES / 3) * 4)
      throw new Error("Each image must be 5 MB or smaller.");
    if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
      throw new Error("Invalid image encoding.");
    const size = data.length / 4 * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
    if (size > MAX_CHAT_IMAGE_BYTES) throw new Error("Each image must be 5 MB or smaller.");
    return { name, mimeType, data };
  });
}
