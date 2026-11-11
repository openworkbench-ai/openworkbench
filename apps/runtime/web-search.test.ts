import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebSearch } from "./web-search.js";
import type { WebResource } from "./web-fetch.js";

function json(body: unknown, status = 200): WebResource {
  return { url: "https://api.example/", status, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(body)) };
}

test("Brave search uses its supported API and filters unsafe or duplicate results", async () => {
  const search = createWebSearch({
    braveApiKey: "fixture-key", tavilyApiKey: "",
    request: async (url, options) => {
      assert.equal(new URL(url).searchParams.get("q"), "types & tools");
      assert.equal(new URL(url).searchParams.get("count"), "2");
      assert.equal(options?.headers?.["X-Subscription-Token"], "fixture-key");
      assert.equal(options?.followRedirects, false);
      return json({ web: { results: [
        { title: "Docs", url: "https://example.com/", description: "Official docs" },
        { title: "Duplicate", url: "https://example.com/" },
        { title: "Private", url: "http://127.0.0.1/" },
      ] } });
    },
  });
  const result = await search("types & tools", 2);
  assert.equal(result.provider, "brave");
  assert.deepEqual(result.results, [{ title: "Docs", url: "https://example.com/", snippet: "Official docs" }]);
});

test("API errors fail over to Tavily with visible warnings and the same cancellation signal", async () => {
  const signal = new AbortController().signal;
  const search = createWebSearch({
    braveApiKey: "fixture-brave", tavilyApiKey: "fixture-tavily",
    request: async (url, options) => {
      assert.equal(options?.signal, signal);
      if (url.includes("brave.com")) return json({}, 429);
      assert.equal(url, "https://api.tavily.com/search");
      assert.equal(options?.method, "POST");
      assert.equal(options?.headers?.Authorization, "Bearer fixture-tavily");
      assert.equal(JSON.parse(options!.body!).query, "docs");
      return json({ results: [{ title: "Docs", url: "https://example.com/", content: "Page excerpt" }] });
    },
  });
  const result = await search("docs", 5, signal);
  assert.equal(result.provider, "tavily");
  assert.match(result.warnings.join(), /Brave.*429/);
  assert.equal(result.results[0].snippet, "Page excerpt");
});

test("no configured API uses a labelled public search fallback", async () => {
  const search = createWebSearch({
    braveApiKey: "", tavilyApiKey: "",
    fetchPage: async (url) => ({ url, contentType: "text/html", body: '<div class="result"><a class="result__a" href="https://example.com/">Docs</a><span class="result__snippet">Excerpt</span></div>' }),
  });
  const result = await search("docs", 5);
  assert.equal(result.provider, "duckduckgo");
  assert.match(result.warnings.join(), /public HTML search/);
  assert.equal(result.results[0].snippet, "Excerpt");
});

test("cancellation does not continue to another search provider", async () => {
  const controller = new AbortController();
  let requests = 0;
  const search = createWebSearch({
    braveApiKey: "fixture-brave", tavilyApiKey: "fixture-tavily",
    request: async () => { requests++; controller.abort(); controller.signal.throwIfAborted(); return json({}); },
  });
  await assert.rejects(search("docs", 5, controller.signal), { name: "AbortError" });
  assert.equal(requests, 1);
});
