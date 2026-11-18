import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { parseChatImages, MAX_CHAT_IMAGE_BYTES } from "../../packages/chat-images.js";
import { createPiAgentBackend } from "./backends/pi.js";

const image = { name: "photo.png", mimeType: "image/png", data: "aGVsbG8=" };

test("image attachments validate count, type, encoding and decoded size", () => {
  assert.deepEqual(parseChatImages(undefined), []);
  assert.deepEqual(parseChatImages([image]), [image]);
  assert.throws(() => parseChatImages(null), /up to 4/);
  assert.throws(() => parseChatImages(Array(5).fill(image)), /up to 4/);
  for (const invalid of [null, {}, { ...image, name: "" }, { ...image, mimeType: "image/svg+xml" },
    { ...image, data: "" }, { ...image, data: "a===b" }, { ...image, data: "data:image/png;base64,aGVsbG8=" }]) {
    assert.throws(() => parseChatImages([invalid]));
  }
  const largest = Buffer.alloc(MAX_CHAT_IMAGE_BYTES).toString("base64");
  assert.equal(parseChatImages([{ ...image, data: largest }])[0].data, largest);
  // These lengths have identical encoded sizes: enforce the decoded limit too.
  const oversized = Buffer.alloc(MAX_CHAT_IMAGE_BYTES + 1).toString("base64");
  assert.throws(() => parseChatImages([{ ...image, data: oversized }]), /5 MB/);
});

test("chat forwards image-only and text prompts to the SDK, and rejects text-only models", async (t) => {
  const oldKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = "test-key";
  t.after(() => {
    if (oldKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = oldKey;
  });
  const prompt = t.mock.method(AgentSession.prototype, "prompt", async () => {});
  const backend = await createPiAgentBackend();
  assert.equal(backend.supportsImages?.(), true, "the default model accepts images");
  await backend.prompt("", () => {}, [image]);
  assert.deepEqual(prompt.mock.calls[0].arguments, ["", { images: [{ type: "image", data: image.data, mimeType: image.mimeType }] }]);
  await backend.prompt("Hello", () => {});
  assert.deepEqual(prompt.mock.calls[1].arguments, ["Hello", { images: [] }]);
  const textOnly = await createPiAgentBackend(undefined, "z-ai/glm-5.3");
  assert.equal(textOnly.supportsImages?.(), false);
  await assert.rejects(textOnly.prompt("Look at this", () => {}, [image]), /does not support images/);
  assert.equal(prompt.mock.callCount(), 2, "unsupported images never reach the SDK");
});
