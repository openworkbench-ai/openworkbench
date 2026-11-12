import { JSDOM, VirtualConsole } from "jsdom";
import { fetchWebPage, publicUrl, requestWebResource, type WebResource } from "./web-fetch.js";

export const SEARCH_URL = "https://lite.duckduckgo.com/lite/";
export interface SearchResult { title: string; url: string; snippet: string }
export interface SearchResponse {
  query: string;
  provider: "brave" | "tavily" | "duckduckgo";
  results: SearchResult[];
  warnings: string[];
}

export function parseSearchResults(html: string, limit = 5): SearchResult[] {
  const dom = new JSDOM(html, { url: SEARCH_URL, virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    if (doc.querySelector(".anomaly-modal, #challenge-form"))
      throw new Error("The search provider requested a CAPTCHA. Try again later or open a known URL.");
    const results: SearchResult[] = [];
    const seen = new Set<string>();
    for (const anchor of doc.querySelectorAll("a.result-link, a.result__a")) {
      if (anchor.closest(".result--ad")) continue;
      const href = anchor.getAttribute("href");
      if (!href) continue;
      try {
        const redirect = publicUrl(href, SEARCH_URL);
        const url = publicUrl(redirect.hostname === "duckduckgo.com" ? redirect.searchParams.get("uddg") ?? redirect.href : redirect.href).href;
        if (seen.has(url)) continue;
        let snippet = anchor.closest(".result")?.querySelector(".result__snippet")?.textContent ?? "";
        if (!snippet) {
          let row = anchor.closest("tr")?.nextElementSibling;
          for (let i = 0; row && i < 3; i++, row = row.nextElementSibling) {
            if (row.querySelector("a.result-link")) break;
            const found = row.querySelector(".result-snippet");
            if (found) { snippet = found.textContent ?? ""; break; }
          }
        }
        results.push({
          title: (anchor.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
          url, snippet: snippet.replace(/\s+/g, " ").trim().slice(0, 1200),
        });
        seen.add(url);
        if (results.length >= limit) break;
      } catch { /* Ignore malformed or private result URLs. */ }
    }
    if (!results.length && !/no results|no more results/i.test(doc.body.textContent ?? ""))
      throw new Error("Search returned no readable results. The provider may be unavailable or its page format may have changed.");
    return results;
  } finally { dom.window.close(); }
}

interface SearchOptions {
  braveApiKey?: string;
  tavilyApiKey?: string;
  request?: typeof requestWebResource;
  fetchPage?: typeof fetchWebPage;
}

function apiJson(response: WebResource): unknown {
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Search API failed (HTTP ${response.status}).`);
  return JSON.parse(response.body.toString("utf8"));
}

function cleanResults(rows: { title?: unknown; url?: unknown; description?: unknown; content?: unknown }[], limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (typeof row.url !== "string" || typeof row.title !== "string") continue;
    try {
      const url = publicUrl(row.url).href;
      if (seen.has(url)) continue;
      seen.add(url);
      const snippet = row.description ?? row.content;
      results.push({ title: row.title.slice(0, 300), url, snippet: typeof snippet === "string" ? snippet.slice(0, 1600) : "" });
      if (results.length >= limit) break;
    } catch { /* Ignore invalid result URLs. */ }
  }
  return results;
}

/** Prefer supported search APIs; keep public HTML search as a labelled fallback. */
export function createWebSearch(options: SearchOptions = {}) {
  const request = options.request ?? requestWebResource;
  const fetchPage = options.fetchPage ?? fetchWebPage;
  return async (query: string, limit: number, signal?: AbortSignal): Promise<SearchResponse> => {
    const warnings: string[] = [];
    const braveKey = options.braveApiKey ?? process.env.BRAVE_SEARCH_API_KEY;
    const tavilyKey = options.tavilyApiKey ?? process.env.TAVILY_API_KEY;
    if (braveKey) {
      try {
        const url = new URL("https://api.search.brave.com/res/v1/web/search");
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(limit));
        const data = apiJson(await request(url.href, {
          signal, headers: { Accept: "application/json", "X-Subscription-Token": braveKey }, followRedirects: false,
        })) as { web?: { results?: Parameters<typeof cleanResults>[0] } };
        if (!data || typeof data !== "object" || (!("web" in data) && !("query" in data))
          || (data.web?.results && !Array.isArray(data.web.results)))
          throw new Error("Unexpected search API response.");
        return { query, provider: "brave", results: cleanResults(data.web?.results ?? [], limit), warnings };
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`Brave search was unavailable: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
    if (tavilyKey) {
      try {
        const data = apiJson(await request("https://api.tavily.com/search", {
          signal, method: "POST", followRedirects: false,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${tavilyKey}` },
          body: JSON.stringify({ query, max_results: limit, search_depth: "advanced", include_answer: false }),
        })) as { results?: Parameters<typeof cleanResults>[0] };
        if (!data || !Array.isArray(data.results)) throw new Error("Unexpected search API response.");
        return { query, provider: "tavily", results: cleanResults(data.results, limit), warnings };
      } catch (error) {
        signal?.throwIfAborted();
        warnings.push(`Tavily search was unavailable: ${error instanceof Error ? error.message : "request failed"}`);
      }
    }
    const url = new URL(SEARCH_URL);
    url.searchParams.set("q", query);
    warnings.push("Using public HTML search, which may be rate-limited or require a CAPTCHA. Configure BRAVE_SEARCH_API_KEY or TAVILY_API_KEY for supported API search.");
    return { query, provider: "duckduckgo", results: parseSearchResults((await fetchPage(url.href, signal)).body, limit), warnings };
  };
}
