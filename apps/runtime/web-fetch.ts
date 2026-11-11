import { lookup } from "node:dns";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import { Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

export const MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, prefix, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
blocked.addSubnet("2001::", 23, "ipv6");
blocked.addSubnet("2001:db8::", 32, "ipv6");
blocked.addSubnet("2002::", 16, "ipv6");

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function resolvePublicHost(hostname: string) {
  return new Promise<import("node:dns").LookupAddress[]>((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) return reject(error);
      if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address)))
        return reject(new Error("Only public web addresses are allowed."));
      resolve(addresses);
    });
  });
}

export function publicUrl(value: string, base?: string): URL {
  if (value.length > 8000) throw new Error("URL is too long.");
  const url = new URL(value, base);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Use a public HTTP or HTTPS URL without credentials.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(hostname) && !isPublicAddress(hostname))
    throw new Error("Only public web addresses are allowed.");
  return url;
}

export interface WebPage {
  url: string;
  contentType: string;
  body: string;
  warnings?: string[];
}

export interface WebResource {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: "GET" | "HEAD" | "POST";
  body?: string;
  followRedirects?: boolean;
  maxBytes?: number;
}

/** Shared transport for documents, search APIs, and every browser subresource.
 * DNS answers are checked once and passed directly to the connection, preventing rebinding.
 * Both compressed and decompressed response sizes are bounded.
 */
export async function requestWebResource(value: string, options: RequestOptions = {}): Promise<WebResource> {
  const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(options.signal ? [options.signal] : [])]);
  const maxBytes = options.maxBytes ?? MAX_DOWNLOAD_BYTES;
  async function visit(url: URL, redirects: number, headers: Record<string, string>): Promise<WebResource> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
        method: options.method ?? "GET",
        signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; OpenWorkbench/0.1)",
          Accept: "text/html, application/xhtml+xml, text/plain, application/json;q=0.8",
          "Accept-Encoding": "gzip, deflate, br",
          ...headers,
        },
        lookup(hostname, lookupOptions, callback) {
          resolvePublicHost(hostname).then((addresses) => {
            if (lookupOptions.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          }, (error) => callback(error, "", 4));
        },
      }, (response) => {
        response.on("error", reject);
        const status = response.statusCode ?? 0;
        if (options.followRedirects !== false && [301, 302, 303, 307, 308].includes(status)) {
          response.destroy();
          if (redirects >= 8 || !response.headers.location)
            return reject(new Error("Too many redirects or missing redirect URL."));
          // API requests carry credentials; never replay them through redirects.
          if (options.method === "POST") return reject(new Error("Unexpected search API redirect."));
          try {
            const next = publicUrl(response.headers.location, url.href);
            const nextHeaders = next.origin === url.origin ? headers : {};
            resolve(visit(next, redirects + 1, nextHeaders));
          } catch (error) { reject(error); }
          return;
        }
        if (Number(response.headers["content-length"]) > maxBytes) {
          response.destroy();
          return reject(new Error("Response exceeds the download limit."));
        }
        const chunks: Buffer[] = [];
        let wireBytes = 0;
        let decodedBytes = 0;
        const wireLimit = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          wireBytes += chunk.length;
          callback(wireBytes > maxBytes ? new Error("Response exceeds the download limit.") : null, chunk);
        } });
        const sink = new Writable({ write(chunk: Buffer, _encoding, callback) {
          decodedBytes += chunk.length;
          if (decodedBytes > maxBytes) return callback(new Error("Decompressed response exceeds the download limit."));
          chunks.push(chunk);
          callback();
        } });
        const encoding = response.headers["content-encoding"]?.toLowerCase().trim();
        const decoder = encoding === "gzip" ? createGunzip()
          : encoding === "br" ? createBrotliDecompress()
          : encoding === "deflate" ? createInflate() : undefined;
        if (encoding && encoding !== "identity" && !decoder) {
          response.destroy();
          return reject(new Error(`Unsupported content encoding: ${encoding}.`));
        }
        const completed = decoder
          ? pipeline(response, wireLimit, decoder, sink, { signal })
          : pipeline(response, wireLimit, sink, { signal });
        completed.then(() => resolve({ url: url.href, status, headers: response.headers, body: Buffer.concat(chunks) }), reject);
      });
      request.on("error", reject);
      request.end(options.body);
    });
  }
  return visit(publicUrl(value), 0, options.headers ?? {});
}

export function resourcePage(response: WebResource): WebPage {
  if (response.status < 200 || response.status >= 300)
    throw new Error(`Page request failed (HTTP ${response.status}).`);
  const contentType = response.headers["content-type"] ?? "";
  if (!/^(text\/(?:html|plain|markdown)|application\/(?:xhtml\+xml|json))(?:;|$)/i.test(contentType))
    throw new Error(`Unsupported page type: ${contentType || "unknown"}. Open HTML or text pages.`);
  const charset = /charset=["']?([^;\s"']+)/i.exec(contentType)?.[1]
    ?? /<meta[^>]+charset=["']?([^\s"'/>;]+)/i.exec(response.body.subarray(0, 1024).toString("ascii"))?.[1]
    ?? "utf-8";
  return { url: response.url, contentType, body: new TextDecoder(charset).decode(response.body) };
}

export async function fetchWebPage(value: string, signal?: AbortSignal): Promise<WebPage> {
  return resourcePage(await requestWebResource(value, { signal }));
}
