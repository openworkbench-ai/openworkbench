import { JSDOM } from "jsdom";
import { unzipSync } from "fflate";
import { fileURLToPath } from "node:url";
import {
  attachmentMimeType,
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_DOCUMENT_CHARS,
  type PreparedAttachment,
} from "../../packages/chat-attachments.js";

export class AttachmentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

function xmlDocument(bytes: Uint8Array): Document {
  return new JSDOM(new TextDecoder("utf-8", { fatal: true }).decode(bytes), { contentType: "text/xml" }).window.document;
}

function officeText(bytes: Uint8Array, extension: string): string {
  let expanded = 0;
  let entries = 0;
  // Inspect declared sizes before decompressing any archive entry.
  unzipSync(bytes, { filter: (entry) => {
    expanded += entry.originalSize;
    if (++entries > 2000 || expanded > 32 * 1024 * 1024) {
      throw new AttachmentError("This document is too large when unpacked.", 413);
    }
    return false;
  } });
  const files = unzipSync(bytes, { filter: (entry) =>
    extension === "docx" ? entry.name === "word/document.xml"
      : extension === "pptx" ? /^ppt\/slides\/slide\d+\.xml$/.test(entry.name)
        : /^xl\/(sharedStrings\.xml|worksheets\/sheet\d+\.xml)$/.test(entry.name),
  });
  if (extension === "xlsx") {
    const shared = files["xl/sharedStrings.xml"]
      ? Array.from(xmlDocument(files["xl/sharedStrings.xml"]).getElementsByTagNameNS("*", "si"), (item) => item.textContent ?? "") : [];
    return Object.keys(files).filter((name) => name.startsWith("xl/worksheets/"))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name) => `${name}\n` + Array.from(xmlDocument(files[name]).getElementsByTagNameNS("*", "row"), (row) =>
        Array.from(row.getElementsByTagNameNS("*", "c"), (cell) => {
          const value = cell.getElementsByTagNameNS("*", "v")[0]?.textContent ?? "";
          const text = cell.getAttribute("t") === "s" ? shared[Number(value)] ?? ""
            : cell.getAttribute("t") === "inlineStr" ? cell.textContent ?? "" : value;
          return `${cell.getAttribute("r") ?? ""}: ${text}`;
        }).join("\t"),
      ).join("\n")).join("\n\n");
  }
  return Object.keys(files).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .map((name) => Array.from(xmlDocument(files[name]).getElementsByTagNameNS("*", "p"), (paragraph) =>
      Array.from(paragraph.getElementsByTagNameNS("*", "t"), (node) => node.textContent ?? "").join(""),
    ).join("\n")).join("\n\n");
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({
    data: bytes, useSystemFonts: false, disableFontFace: true,
    standardFontDataUrl: fileURLToPath(new URL("../../standard_fonts/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))),
    cMapUrl: fileURLToPath(new URL("../../cmaps/", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"))),
    cMapPacked: true,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 150) throw new AttachmentError("PDFs can contain at most 150 pages.", 413);
    let text = "";
    for (let page = 1; page <= pdf.numPages; page++) {
      const content = await (await pdf.getPage(page)).getTextContent();
      text += content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("") + "\n";
      if (text.length > MAX_DOCUMENT_CHARS) throw new AttachmentError("PDF text exceeds the 200,000 character limit.", 413);
    }
    if (!text.trim()) throw new AttachmentError("This PDF has no readable text. For scanned documents, upload the pages as images.");
    return text;
  } finally { await task.destroy(); }
}

export async function prepareAttachments(input: unknown): Promise<PreparedAttachment[]> {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > MAX_ATTACHMENTS) throw new AttachmentError("Attach at most 5 files.");
  const decoded = input.map((value) => {
    if (!value || typeof value !== "object" || typeof value.name !== "string" || !value.name.trim() || value.name.length > 200 || /[\x00-\x1f]/.test(value.name)) {
      throw new AttachmentError("Invalid attachment filename.");
    }
    const mimeType = attachmentMimeType(value.name);
    if (!mimeType) throw new AttachmentError(`Unsupported file type: ${value.name}. Use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV, JSON, or an image.`);
    if (typeof value.data !== "string" || !value.data.length || value.data.length > Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 || value.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data)) {
      throw new AttachmentError(`Invalid or oversized attachment: ${value.name}.`);
    }
    const bytes = Buffer.from(value.data, "base64");
    if (bytes.toString("base64") !== value.data) throw new AttachmentError(`Invalid attachment encoding: ${value.name}.`);
    if (!bytes.length || bytes.length > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachments may total at most 10 MiB.", 413);
    return { name: value.name, mimeType, bytes };
  });
  if (decoded.reduce((size, file) => size + file.bytes.length, 0) > MAX_ATTACHMENT_BYTES) throw new AttachmentError("Attachments may total at most 10 MiB.", 413);
  const prepared: PreparedAttachment[] = [];
  let totalText = 0;
  for (const file of decoded) {
    try {
      const result: PreparedAttachment = { name: file.name, mimeType: file.mimeType, size: file.bytes.length };
      if (file.mimeType.startsWith("image/")) {
        const header = file.bytes.subarray(0, 12);
        const valid = file.mimeType === "image/png" ? header.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
          : file.mimeType === "image/jpeg" ? header[0] === 255 && header[1] === 216 && header[2] === 255
            : file.mimeType === "image/gif" ? /^GIF8[79]a/.test(header.toString("ascii"))
              : header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP";
        if (!valid) throw new AttachmentError(`Invalid image: ${file.name}.`);
        result.image = { type: "image", data: file.bytes.toString("base64"), mimeType: file.mimeType };
      } else {
        const extension = file.name.split(".").at(-1)!.toLowerCase();
        result.text = extension === "pdf" ? await pdfText(new Uint8Array(file.bytes))
          : ["docx", "xlsx", "pptx"].includes(extension) ? officeText(file.bytes, extension)
            : new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
        if (!result.text.trim() || result.text.includes("\0")) throw new AttachmentError(`No readable text in ${file.name}.`);
        totalText += result.text.length;
        if (totalText > MAX_DOCUMENT_CHARS) throw new AttachmentError("Attached documents may total at most 200,000 characters of text.", 413);
      }
      prepared.push(result);
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new AttachmentError(`Could not read ${file.name}. The file may be damaged, encrypted, or in an unsupported format.`);
    }
  }
  return prepared;
}
