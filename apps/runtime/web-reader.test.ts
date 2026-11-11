import assert from "node:assert/strict";
import { test } from "node:test";
import { extractWebPage } from "./web-extract.js";
import { createWebTools, readWebPage } from "./web-tools.js";

const html = (body: string, url = "https://example.com/docs") => ({ url, contentType: "text/html", body });
const main = `<main><h1>API reference</h1><p>${"Useful documentation. ".repeat(30)}</p>
  <h2>Example</h2><pre><code class="language-js">const answer = 42;\nconsole.log(answer);</code></pre>
  <table><thead><tr><th>Name</th><th>Type</th></tr></thead><tbody><tr><td>answer</td><td>number</td></tr></tbody></table>
  <p><a href="/more">Read more</a></p></main>`;

function decode(result: Awaited<ReturnType<ReturnType<typeof createWebTools>[number]["execute"]>>) {
  assert.ok(result.content[0].type === "text");
  return JSON.parse(result.content[0].text);
}

test("main content extraction preserves headings, fenced code, tables and absolute links", () => {
  const page = extractWebPage(html(`<title>Reference</title><nav>Navigation noise</nav>${main}<footer>Footer noise</footer>`));
  assert.equal(page.extraction, "main");
  assert.equal(page.format, "markdown");
  assert.match(page.text, /# API reference/);
  assert.match(page.text, /```js\nconst answer = 42;/);
  assert.match(page.text, /\| Name \| Type \|/);
  assert.match(page.text, /\[Read more\]\(https:\/\/example.com\/more\)/);
  assert.doesNotMatch(page.text, /Navigation noise|Footer noise/);
});

test("reader flags JavaScript shells, access checks and login walls", () => {
  assert.equal(extractWebPage(html('<title>App</title><div id="root"></div><script src="/app.js"></script>')).needsBrowser, true);
  assert.match(extractWebPage(html('<title>Just a moment...</title><form id="challenge-form">Verify</form>')).warnings.join(), /access check/);
  assert.match(extractWebPage(html('<main>Sign in to continue</main>')).warnings.join(), /login/);
  assert.equal(extractWebPage(html(main)).needsBrowser, false);
  assert.match(extractWebPage(html(`<canvas></canvas>${main}`)).warnings.join(), /canvas-rendered/);
});

test("continuation reads the same cached snapshot rather than re-fetching", async () => {
  let fetches = 0;
  const tools = createWebTools({ fetchPage: async (url) => {
    fetches++;
    return { url, contentType: "text/plain", body: "0123456789".repeat(3000) };
  } });
  const call = (args: object) => tools[1].execute("open", { url: "https://example.com/", max_chars: 1000, ...args }, undefined, undefined, {} as never);
  const first = decode(await call({}));
  const second = decode(await call({ offset: first.next_offset }));
  assert.equal(fetches, 1);
  assert.equal(first.content_length, 30_000);
  assert.equal(second.offset, 1000);
  assert.equal(second.next_offset, 2000);
  assert.equal(decode(await call({ offset: 29_000 })).next_offset, null);
  assert.equal(readWebPage({ url: "https://example.com", contentType: "text/plain", body: "x".repeat(40_000) }, 99_999).text.length, 32_000);
});

test("auto renders a JavaScript shell; never skips rendering; always forces rendering", async () => {
  let fetches = 0;
  let renders = 0;
  const signal = new AbortController().signal;
  const tools = createWebTools({
    fetchPage: async () => { fetches++; return html('<div id="root"></div><script src="/app.js"></script>'); },
    renderPage: async (_url, received) => { assert.equal(received, signal); renders++; return html(main); },
  });
  const call = (render: string) => tools[1].execute("open", { url: "https://example.com/", render }, signal, undefined, {} as never);
  assert.equal(decode(await call("auto")).rendered, true);
  assert.equal(decode(await call("never")).rendered, false);
  assert.match(decode(await call("never")).warnings.join(), /rendering was disabled/);
  assert.equal(decode(await call("always")).rendered, true);
  assert.equal(fetches, 2);
  assert.equal(renders, 2);
});

test("render failures preserve static content with an explicit incompleteness warning", async () => {
  const tools = createWebTools({
    fetchPage: async () => html('<div id="root">Loading</div>'),
    renderPage: async () => { throw new Error("Browser unavailable"); },
  });
  const page = decode(await tools[1].execute("open", { url: "https://example.com/" }, undefined, undefined, {} as never));
  assert.equal(page.rendered, false);
  assert.match(page.warnings.join(), /Browser fallback failed.*incomplete/);
  await assert.rejects(tools[1].execute("open", { url: "https://example.com/", render: "always" }, undefined, undefined, {} as never), /Browser unavailable/);
});

test("cancellation and forbidden URLs never trigger a browser fallback", async () => {
  let renders = 0;
  const controller = new AbortController();
  const tools = createWebTools({
    fetchPage: async () => { controller.abort(); controller.signal.throwIfAborted(); return html(""); },
    renderPage: async () => { renders++; return html(main); },
  });
  await assert.rejects(tools[1].execute("open", { url: "https://example.com/" }, controller.signal, undefined, {} as never), { name: "AbortError" });
  await assert.rejects(tools[1].execute("open", { url: "http://127.0.0.1/" }, undefined, undefined, {} as never), /Only public/);
  assert.equal(renders, 0);
});
