import assert from "node:assert/strict";
import { test } from "node:test";
import { streamChat } from "../web/src/lib/api.js";
import { streamWorkspaceChat } from "../web/src/lib/workspace-api.js";

const clients = {
  chat: () => streamChat("Read the document", () => {}, new AbortController().signal),
  workspace: () => streamWorkspaceChat("example", { version: 1, message: "Read the document", modelId: "auto" }, () => {}, new AbortController().signal),
};

for (const [name, call] of Object.entries(clients)) {
  test(`${name} identifies a proxy HTML 413 without retrying the upload`, async (t) => {
    const fetch = t.mock.method(globalThis, "fetch", async () => new Response("<html><h1>413 Request Entity Too Large</h1><hr>nginx/1.22.1</html>", { status: 413, headers: { "Content-Type": "text/html" } }));
    await assert.rejects(call(), /web server rejected this upload.*HTTP 413.*administrator/);
    assert.equal(fetch.mock.callCount(), 1);
  });

  test(`${name} preserves the PDF parser's specific JSON error`, async (t) => {
    t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ error: "PDF text exceeds the 200,000 character limit." }), { status: 413, headers: { "Content-Type": "application/json" } }));
    await assert.rejects(call(), { message: "PDF text exceeds the 200,000 character limit." });
  });
}
