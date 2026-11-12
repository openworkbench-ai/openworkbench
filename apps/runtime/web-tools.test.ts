import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebTools, fetchWebPage, isPublicAddress, parseSearchResults, readWebPage } from "./web-tools.js";

const searchHtml = `<table>
  <tr><td><a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs%3Fa%3D1%26b%3D2&amp;rut=abc" class='result-link'>Example &amp; docs</a></td></tr>
  <tr><td class='result-snippet'>Read the <b>official</b> documentation. &#x1F4DA;</td></tr>
  <tr><td><a class="result-link" href="https://example.org/">Second result</a></td></tr>
  <tr><td class="result-snippet">Another page</td></tr>
  <tr><td><a class="result-link" href="https://example.org/">Duplicate</a></td></tr>
  <tr><td><a class="result-link" href="http://127.0.0.1/secret">Private</a></td></tr>
</table>`;

test("search extracts titles, destination URLs and snippets, skipping duplicates and private URLs", () => {
  assert.deepEqual(parseSearchResults(searchHtml), [
    { title: "Example & docs", url: "https://example.com/docs?a=1&b=2", snippet: "Read the official documentation. 📚" },
    { title: "Second result", url: "https://example.org/", snippet: "Another page" },
  ]);
  assert.equal(parseSearchResults(searchHtml, 1).length, 1);
});

test("search distinguishes no matches from blocked or unrecognized responses", () => {
  assert.deepEqual(parseSearchResults("<p>No results found</p>"), []);
  assert.throws(() => parseSearchResults('<form id="challenge-form">Verify</form>'), /CAPTCHA/);
  assert.throws(() => parseSearchResults("<h1>Service unavailable</h1>"), /no readable results/);
});

test("page reader strips executable markup, resolves links and reports truncation", () => {
  const page = readWebPage({
    url: "https://example.com/docs/start",
    contentType: "text/html; charset=utf-8",
    body: `<html><head><title>Docs &amp; help</title><style>secret-style</style></head>
      <body><!-- secret-comment --><script>secret-script</script><h1>Hello</h1>
      <p>A &lt;tag&gt; &amp; &#169; &nbsp; &#99999999;</p>
      <a href="../guide?a=1&amp;b=2">Read <b>guide</b></a>
      <a href="javascript:alert(1)">Run</a><a href="http://192.168.1.1/">Private</a>
      <a href="../guide?a=1&amp;b=2">Repeated link</a></body></html>`,
  });
  assert.equal(page.title, "Docs & help");
  assert.match(page.text, /A.*tag.*& ©/);
  assert.doesNotMatch(page.text, /secret-/);
  assert.deepEqual(page.links, [{ title: "Read guide", url: "https://example.com/guide?a=1&b=2" }]);
  const longPage = { url: "https://example.com/", contentType: "text/plain", body: "x".repeat(20_000) };
  assert.equal(readWebPage(longPage).text.length, 12_000);
  assert.equal(readWebPage(longPage, 999_999).text.length, 20_000);
  assert.equal(readWebPage(longPage).truncated, true);
  assert.deepEqual(readWebPage({ ...longPage, body: "plain <text>" }).links, []);
  assert.equal(readWebPage({ ...longPage, body: "plain <text>" }).text, "plain <text>");
});

test("address checks reject loopback, private, metadata, mapped IPv6 and reserved networks", () => {
  for (const address of [
    "127.0.0.1", "0.0.0.0", "10.1.2.3", "172.16.1.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "198.18.0.1", "192.0.2.1", "224.0.0.1", "255.255.255.255",
    "::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2002:7f00:1::", "invalid",
  ]) assert.equal(isPublicAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "2606:4700:4700::1111"])
    assert.equal(isPublicAddress(address), true, address);
});

test("network requests reject unsafe schemes, credentials, encoded loopback and local DNS", async () => {
  for (const url of [
    "file:///etc/passwd", "ftp://example.com/", "http://user:password@example.com/",
    "http://2130706433/", "http://0x7f000001/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://localhost/", "http://169.254.169.254/latest/meta-data/",
  ]) await assert.rejects(fetchWebPage(url), /public.*(?:HTTP|web)/i, url);
});

test("already cancelled web requests do not start a connection", async () => {
  await assert.rejects(fetchWebPage("https://example.com/", AbortSignal.abort()), { name: "AbortError" });
});

test("agent tools encode queries, forward cancellation, and return search-to-page results", async () => {
  const signal = new AbortController().signal;
  const requests: string[] = [];
  const tools = createWebTools({ fetchPage: async (url, receivedSignal) => {
    assert.equal(receivedSignal, signal);
    requests.push(url);
    return {
      url,
      contentType: "text/html",
      body: requests.length === 1 ? searchHtml : "<title>Example</title><p>Documentation content</p>",
    };
  } });
  const search = await tools[0].execute("search-1", { query: "types & tools?", limit: 1 }, signal, undefined, {} as never);
  assert.ok(search.content[0].type === "text");
  const results = JSON.parse(search.content[0].text!);
  assert.equal(new URL(requests[0]).searchParams.get("q"), "types & tools?");
  assert.equal(results.results.length, 1);
  const opened = await tools[1].execute("open-1", { url: results.results[0].url }, signal, undefined, {} as never);
  assert.ok(opened.content[0].type === "text");
  assert.equal(JSON.parse(opened.content[0].text!).title, "Example");
  assert.match(JSON.parse(opened.content[0].text!).text, /Documentation content/);
  await assert.rejects(tools[0].execute("empty", { query: " " }, signal, undefined, {} as never), /Enter a search query/);
});
