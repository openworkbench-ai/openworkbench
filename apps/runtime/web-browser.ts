import type { Browser, BrowserContext, Route } from "playwright";
import { MAX_DOWNLOAD_BYTES, publicUrl, requestWebResource, type WebPage } from "./web-fetch.js";
import { createWebProxy } from "./web-proxy.js";

let browserPromise: Promise<Browser> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let active = 0;
const waiters = new Set<() => void>();

async function acquire(signal: AbortSignal) {
  while (active >= 2) {
    await new Promise<void>((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(signal.reason); };
      const cleanup = () => { waiters.delete(ready); signal.removeEventListener("abort", abort); };
      waiters.add(ready);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  signal.throwIfAborted();
  active++;
  if (idleTimer) clearTimeout(idleTimer);
}

export async function closeWebBrowser() {
  if (idleTimer) clearTimeout(idleTimer);
  const pending = browserPromise;
  browserPromise = undefined;
  await pending?.then((browser) => browser.close()).catch(() => {});
}

async function getBrowser() {
  if (!browserPromise) {
    // The install script uses a package-local browser; Docker can override this path.
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= "0";
    const pending: Promise<Browser> = import("playwright").then(({ chromium }) => chromium.launch({
      headless: true,
      timeout: 15_000,
      // Contexts override this with their checked proxy. This default fails closed.
      proxy: { server: "http://127.0.0.1:9" },
      args: ["--proxy-bypass-list=<-loopback>", "--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
    })).then((browser) => {
      browser.on("disconnected", () => { if (browserPromise === pending) browserPromise = undefined; });
      return browser;
    }).catch((cause) => {
      if (browserPromise === pending) browserPromise = undefined;
      throw new Error("Browser rendering is unavailable. Run npm run browser:install -w apps/runtime, or rebuild the runtime Docker image.", { cause });
    });
    browserPromise = pending;
  }
  return browserPromise;
}

/** Renders anonymous public pages. Each call gets fresh cookies and storage.
 * Resources and script-driven APIs pass through a DNS-pinned proxy; service
 * workers, WebSockets, downloads and form submissions are disabled.
 */
export async function renderWebPage(
  value: string,
  callerSignal?: AbortSignal,
  resourceRequest: typeof requestWebResource = requestWebResource,
): Promise<WebPage> {
  publicUrl(value);
  const lifetime = new AbortController();
  const signal = AbortSignal.any([AbortSignal.timeout(45_000), lifetime.signal, ...(callerSignal ? [callerSignal] : [])]);
  await acquire(signal);
  let context: BrowserContext | undefined;
  let proxy: Awaited<ReturnType<typeof createWebProxy>> | undefined;
  const abort = () => { context?.close().catch(() => {}); };
  try {
    const browser = await getBrowser();
    signal.throwIfAborted();
    proxy = await createWebProxy(signal, resourceRequest);
    context = await browser.newContext({
      proxy: { server: proxy.url },
      acceptDownloads: false,
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
    });
    signal.addEventListener("abort", abort, { once: true });
    signal.throwIfAborted();
    let requests = 0;
    let mainError: Error | undefined;
    const page = await context.newPage();
    context.on("page", (popup) => { if (popup !== page) popup.close().catch(() => {}); });
    await context.routeWebSocket(/.*/, (socket) => socket.close());
    await context.route(/.*/, async (route: Route) => {
      const request = route.request();
      const mainDocument = request.isNavigationRequest() && request.frame() === page.mainFrame();
      try {
        signal.throwIfAborted();
        const apiPost = request.method() === "POST" && ["xhr", "fetch"].includes(request.resourceType()) && !request.isNavigationRequest();
        if (++requests > 150 || (!["GET", "HEAD"].includes(request.method()) && !apiPost)
          || (request.postDataBuffer()?.length ?? 0) > 1024 * 1024
          || ["image", "media", "font"].includes(request.resourceType())) {
          await route.abort("blockedbyclient");
          return;
        }
        publicUrl(request.url());
        await route.continue();
      } catch (error) {
        if (mainDocument) mainError = error instanceof Error ? error : new Error(String(error));
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    page.on("dialog", (dialog) => dialog.dismiss().catch(() => {}));
    try {
      const response = await page.goto(value, { waitUntil: "domcontentloaded", timeout: 30_000 });
      if (response && response.status() >= 400)
        throw proxy.failure() ?? new Error(`Page request failed (HTTP ${response.status()}).`);
    } catch (error) {
      signal.throwIfAborted();
      if (mainError) throw mainError;
      if (proxy.failure()) throw proxy.failure();
      if (/HTTP \d+/.test(String(error))) throw error;
      // A stalled analytics request need not discard a usable page.
      if (!(await page.locator("body").innerText({ timeout: 1000 }).catch(() => "")).trim()) throw error;
    }
    await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) > 150, undefined, { timeout: 10_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: 4000 }).catch(() => {});
    signal.throwIfAborted();
    // Trigger content that is deferred until the user scrolls, without crawling links.
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => {});
    const body = await page.content();
    if (Buffer.byteLength(body) > MAX_DOWNLOAD_BYTES) throw new Error("Rendered page exceeds the document limit.");
    return {
      url: publicUrl(page.url()).href, contentType: "text/html; charset=utf-8", body,
      warnings: proxy.failure() ? [`Some browser resources failed: ${proxy.failure()!.message}`] : [],
    };
  } finally {
    signal.removeEventListener("abort", abort);
    lifetime.abort();
    await context?.close().catch(() => {});
    await proxy?.close().catch(() => {});
    active--;
    waiters.values().next().value?.();
    if (!active && !waiters.size) {
      idleTimer = setTimeout(() => { void closeWebBrowser(); }, 30_000);
      idleTimer.unref();
    }
  }
}
