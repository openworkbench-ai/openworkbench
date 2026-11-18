import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { prepareAttachments, AttachmentError } from "./chat-attachments.js";
import { attachmentContext, MAX_ATTACHMENT_BYTES } from "../../packages/chat-attachments.js";
import { textPdf as pdf } from "./test-fixtures/pdf.js";

const file = (name: string, content: string | Uint8Array) => ({
  name, mimeType: "application/octet-stream", size: 1,
  data: Buffer.from(content).toString("base64"),
});

test("extracts text from a real PDF without sending it to an external service", async () => {
  const [result] = await prepareAttachments([file("requirements.pdf", pdf("Build the inventory tracker"))]);
  assert.match(result.text!, /Build the inventory tracker/);
  assert.equal(result.mimeType, "application/pdf");
  assert.equal(result.image, undefined);
});

test("extracts Word paragraphs, spreadsheet shared strings/cells, and PowerPoint slide text", async () => {
  const docx = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Kundenübersicht</w:t></w:r></w:p><w:p><w:r><w:t>Persist real records.</w:t></w:r></w:p></w:body></w:document>') });
  const xlsx = zipSync({
    "xl/sharedStrings.xml": strToU8('<sst xmlns="urn:excel"><si><t>Revenue</t></si></sst>'),
    "xl/worksheets/sheet1.xml": strToU8('<worksheet xmlns="urn:excel"><sheetData><row><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1250</v></c></row></sheetData></worksheet>'),
  });
  const pptx = zipSync({ "ppt/slides/slide1.xml": strToU8('<p:sld xmlns:p="urn:powerpoint" xmlns:a="urn:drawing"><a:p><a:r><a:t>Project goals</a:t></a:r></a:p></p:sld>') });
  const results = await prepareAttachments([file("spec.docx", docx), file("budget.xlsx", xlsx), file("slides.pptx", pptx)]);
  assert.equal(results[0].text, "Kundenübersicht\nPersist real records.");
  assert.match(results[1].text!, /A1: Revenue\tB1: 1250/);
  assert.equal(results[2].text, "Project goals");
  assert.ok(results.every((item) => !("data" in item)), "raw office archives are not retained in the transcript");
});

test("normalizes UTF-8 text files, counts real bytes, and preserves image content", async () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jg1sAAAAASUVORK5CYII=";
  const results = await prepareAttachments([file("notes.MD", "Grüße\n# Requirements"), { ...file("photo.png", ""), data: png }]);
  assert.equal(results[0].text, "Grüße\n# Requirements");
  assert.equal(results[0].size, Buffer.byteLength("Grüße\n# Requirements"));
  assert.equal(results[1].image?.data, png);
  assert.equal(results[1].image?.type, "image");
  assert.match(attachmentContext(results), /untrusted reference content/);
});

test("rejects malformed, unsupported, oversized, and unreadable files", async () => {
  await assert.rejects(prepareAttachments({}), AttachmentError);
  await assert.rejects(prepareAttachments(Array(6).fill(file("notes.txt", "hi"))), /at most 5/);
  await assert.rejects(prepareAttachments([file("program.exe", "hello")]), /Unsupported file type/);
  await assert.rejects(prepareAttachments([{ ...file("notes.txt", "hi"), data: "%%%" }]), /Invalid/);
  await assert.rejects(prepareAttachments([file("image.png", "not an image")]), /Invalid image/);
  await assert.rejects(prepareAttachments([file("broken.pdf", "broken pdf")]), /Could not read/);
  await assert.rejects(prepareAttachments([file("scan.pdf", pdf(""))]), /no readable text/);
  await assert.rejects(prepareAttachments([file("large.txt", "x".repeat(200001))]), /200,000/);
  await assert.rejects(prepareAttachments([file("large.txt", new Uint8Array(MAX_ATTACHMENT_BYTES + 1))]), /oversized|10 MiB/);
  const zipBomb = zipSync({ "word/document.xml": new Uint8Array(33 * 1024 * 1024) });
  await assert.rejects(prepareAttachments([file("too-large.docx", zipBomb)]), /too large when unpacked/);
});
