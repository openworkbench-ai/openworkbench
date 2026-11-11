import { Readability } from "@mozilla/readability";
import { JSDOM, VirtualConsole } from "jsdom";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";
import { publicUrl, type WebPage } from "./web-fetch.js";

export interface ExtractedPage {
  url: string;
  title: string;
  text: string;
  format: "markdown" | "text";
  extraction: "main" | "readability" | "body" | "text";
  links: { title: string; url: string }[];
  warnings: string[];
  needsBrowser: boolean;
}

const markdown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
markdown.use(gfm);
markdown.remove((node) => ["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "svg", "CANVAS", "IFRAME"].includes(node.nodeName));
markdown.addRule("readableLinks", {
  filter: "a",
  replacement(content, node) {
    const href = (node as HTMLAnchorElement).getAttribute("href");
    if (!href || !content.trim()) return content;
    try { return `[${content}](${publicUrl(href).href.replace(/\)/g, "%29")})`; }
    catch { return content; }
  },
});

/** JSDOM never runs scripts or loads external resources. Only Markdown leaves this module. */
export function extractWebPage(page: WebPage): ExtractedPage {
  if (!/html/i.test(page.contentType)) return {
    url: page.url, title: "", text: page.body, format: "text", extraction: "text",
    links: [], warnings: [...(page.warnings ?? [])], needsBrowser: false,
  };
  const dom = new JSDOM(page.body, { url: page.url, virtualConsole: new VirtualConsole() });
  try {
    const doc = dom.window.document;
    const title = (doc.title || doc.querySelector("h1")?.textContent || "").trim().slice(0, 500);
    const hasScripts = !!doc.querySelector("script[src], #root, #app, #__next");
    const hasCanvas = !!doc.querySelector("canvas");
    const blocked = /^(just a moment|attention required|access denied|robot check|verify (?:you|your))/i.test(title)
      || !!doc.querySelector("#challenge-form, #challenge-running, #cf-challenge-running, form[action*='captcha']");
    doc.querySelectorAll("script,style,noscript,template,svg,canvas,iframe,[hidden],[aria-hidden='true'],[style*='display: none'],[style*='display:none']")
      .forEach((node) => node.remove());
    let content = doc.querySelector("main, [role='main']") as Element | null;
    let extraction: ExtractedPage["extraction"] = "main";
    if (!content || (content.textContent?.trim().length ?? 0) < 200) {
      const repeatedEntries = doc.querySelectorAll("article, [itemprop='text'], .h-entry").length > 1;
      const article = repeatedEntries ? null : new Readability(doc.cloneNode(true) as Document, { maxElemsToParse: 100_000 }).parse();
      if (article?.content && article.length && article.length >= 200) {
        content = doc.createElement("article");
        content.innerHTML = article.content;
        extraction = "readability";
      } else {
        content = content ?? doc.body;
        extraction = content === doc.body ? "body" : "main";
      }
    }
    content.querySelectorAll("nav,aside,footer,form,[role='navigation'],[role='banner'],[role='contentinfo']")
      .forEach((node) => node.remove());
    if (extraction !== "body") content.querySelectorAll("button").forEach((node) => node.remove());
    const links: ExtractedPage["links"] = [];
    const seen = new Set<string>();
    for (const anchor of content.querySelectorAll("a[href]")) {
      try {
        const url = publicUrl(anchor.getAttribute("href")!, page.url).href;
        anchor.setAttribute("href", url);
        const label = anchor.textContent?.replace(/\s+/g, " ").trim() ?? "";
        if (!label || url.length > 2000 || seen.has(url)) continue;
        seen.add(url);
        if (links.length < 50) links.push({ title: label.slice(0, 200), url });
      } catch { anchor.removeAttribute("href"); }
    }
    const text = markdown.turndown(content as HTMLElement).trim();
    const warnings: string[] = [...(page.warnings ?? [])];
    if (blocked) warnings.push("This page appears to be an access check or CAPTCHA; its content has not been verified.");
    if (hasCanvas) warnings.push("This page contains canvas-rendered content. Only page text is included; drawings and visual state are unavailable.");
    if (text.length < 200) warnings.push("Very little readable text was found. The page may be interactive, restricted, or still loading.");
    if (/sign in to (?:continue|view|read)|log in to (?:continue|view|read)|subscribe to (?:continue|read)/i.test(text.slice(0, 1500)))
      warnings.push("The page may require a login or subscription. Only public content is available.");
    return {
      url: page.url, title, text, format: "markdown", extraction, links, warnings,
      needsBrowser: blocked || (hasScripts && text.length < 500) || /enable javascript|javascript (?:is )?required/i.test(text.slice(0, 1000)),
    };
  } finally { dom.window.close(); }
}
