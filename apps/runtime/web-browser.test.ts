import assert from "node:assert/strict";
import { after, test } from "node:test";
import { closeWebBrowser, renderWebPage } from "./web-browser.js";
import { extractWebPage } from "./web-extract.js";
import { requestWebResource, type WebResource } from "./web-fetch.js";

after(closeWebBrowser);

function response(url: string, body: string, type = "text/html", status = 200, headers = {}): WebResource {
  return { url, status, headers: { "content-type": type, ...headers }, body: Buffer.from(body) };
}
const prose = "This article was loaded by JavaScript after a public API request. ".repeat(10);

test("Chromium renders external scripts and asynchronous API content without direct browser network access", async () => {
  const seen: string[] = [];
  const page = await renderWebPage("http://fixture.example/start", undefined, async (url, options) => {
    seen.push(url);
    if (url.endsWith("/start")) return response(url, '<title>Client app</title><div id="root"></div><script src="/app.js"></script>');
    if (url.endsWith("/app.js")) return response(url, `setTimeout(async () => {
      const data = await fetch('/data', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({query:'readArticle'})}).then(r => r.json());
      document.getElementById('root').innerHTML = '<main><h1>Dynamic article</h1><p>' + data.text + '</p></main>';
    }, 100);`, "application/javascript");
    if (url.endsWith("/data")) {
      assert.equal(options?.method, "POST");
      assert.equal(JSON.parse(options!.body!).query, "readArticle");
      return response(url, JSON.stringify({ text: prose }), "application/json");
    }
    throw new Error(`Unexpected resource: ${url}`);
  });
  assert.match(extractWebPage(page).text, /# Dynamic article/);
  assert.match(extractWebPage(page).text, /loaded by JavaScript/);
  assert.ok(seen.some((url) => url.endsWith("/app.js")));
  assert.ok(seen.some((url) => url.endsWith("/data")));
});

test("browser re-checks redirects and resolves the final page URL", async () => {
  const page = await renderWebPage("http://fixture.example/redirect", undefined, async (url) => {
    if (url.endsWith("/redirect")) return response(url, "", "text/html", 302, { location: "/destination" });
    assert.equal(url, "http://fixture.example/destination");
    return response(url, `<title>Redirected</title><main>${prose}</main>`);
  });
  assert.equal(page.url, "http://fixture.example/destination");
  await assert.rejects(renderWebPage("http://fixture.example/private", undefined, async (url) =>
    response(url, "", "text/html", 302, { location: "http://127.0.0.1/secret" })), /public web/);
});

test("browser blocks private subresources, mutation methods, form submissions and WebSockets", async () => {
  const seen: string[] = [];
  const page = await renderWebPage("http://fixture.example/", undefined, async (url, options) => {
    seen.push(url);
    if (new URL(url).hostname === "localhost") return requestWebResource(url, options);
    assert.equal(url, "http://fixture.example/");
    return response(url, `<main>${prose}</main><script>
      fetch('http://127.0.0.1/secret').catch(() => {});
      fetch('http://localhost/secret').catch(() => {});
      fetch('/write', {method:'DELETE'}).catch(() => {});
      const iframe = document.createElement('iframe'); iframe.name='blocked-frame'; document.body.append(iframe);
      const form = document.createElement('form'); form.method='POST'; form.action='/submit'; form.target='blocked-frame'; document.body.append(form); form.submit();
      const ws = new WebSocket('wss://fixture.example/socket'); ws.onerror = () => {};
    </script>`);
  });
  assert.match(extractWebPage(page).text, /loaded by JavaScript/);
  assert.ok(seen.includes("http://localhost/secret"), "hostname routes must reach DNS validation");
  assert.ok(!seen.some((url) => /127\.0\.0\.1|\/write|\/submit|\/socket/.test(url)));
});

test("browser cancellation closes the context and releases its slot", async () => {
  const controller = new AbortController();
  const pending = renderWebPage("http://fixture.example/slow", controller.signal, async (url) => {
    controller.abort();
    return response(url, "<div id='root'></div>");
  });
  await assert.rejects(pending);
  const page = await renderWebPage("http://fixture.example/after", undefined, async (url) => response(url, `<main>${prose}</main>`));
  assert.match(page.body, /loaded by JavaScript/);
});
