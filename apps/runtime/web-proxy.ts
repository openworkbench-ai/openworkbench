import { createServer } from "node:http";
import { connect, type Socket } from "node:net";
import { publicUrl, requestWebResource, resolvePublicHost } from "./web-fetch.js";

const MAX_TRAFFIC = 40 * 1024 * 1024;

/** A per-read proxy. Chromium handles TLS and redirects normally; connections
 * are pinned to checked public DNS answers, including redirects and subresources.
 * HTTPS byte budgets count encrypted traffic; rendered HTML has its own limit.
 */
export async function createWebProxy(signal: AbortSignal, requestResource = requestWebResource) {
  const sockets = new Set<Socket>();
  let bytes = 0;
  let requests = 0;
  let failure: Error | undefined;
  function fail(error: unknown) {
    failure = error instanceof Error ? error : new Error(String(error));
    return failure;
  }
  function count(chunk: Buffer) {
    bytes += chunk.length;
    if (bytes > MAX_TRAFFIC) {
      fail(new Error("Browser response traffic exceeds the 40 MiB limit."));
      for (const socket of sockets) socket.destroy();
    }
  }
  const server = createServer(async (request, response) => {
    try {
      signal.throwIfAborted();
      if (++requests > 150 || !["GET", "HEAD", "POST"].includes(request.method ?? ""))
        throw new Error("Browser request budget exceeded or method blocked.");
      const url = publicUrl(request.url ?? "");
      const headers: Record<string, string> = {};
      for (const key of ["accept", "accept-language", "origin", "referer", "cookie", "range", "user-agent", "content-type"])
        if (typeof request.headers[key] === "string") headers[key] = request.headers[key];
      const chunks: Buffer[] = [];
      let bodyBytes = 0;
      for await (const chunk of request) {
        bodyBytes += chunk.length;
        if (bodyBytes > 1024 * 1024) throw new Error("Browser API request body exceeds 1 MiB.");
        chunks.push(chunk);
      }
      const result = await requestResource(url.href, {
        signal, headers, followRedirects: false,
        method: request.method as "GET" | "HEAD" | "POST",
        body: chunks.length ? Buffer.concat(chunks).toString("utf8") : undefined,
      });
      count(result.body);
      if (bytes > MAX_TRAFFIC) throw failure;
      const responseHeaders = { ...result.headers };
      for (const key of ["content-encoding", "content-length", "transfer-encoding", "connection", "alt-svc"])
        delete responseHeaders[key];
      response.writeHead(result.status, responseHeaders);
      response.end(result.body);
    } catch (error) {
      fail(error);
      response.writeHead(502, { "Content-Type": "text/plain" });
      response.end("Public web proxy blocked or failed this request.");
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("connect", async (request, client, head) => {
    try {
      signal.throwIfAborted();
      if (++requests > 150) throw new Error("Browser connection budget exceeded.");
      const url = publicUrl(`https://${request.url}`);
      const addresses = await resolvePublicHost(url.hostname.replace(/^\[|\]$/g, ""));
      signal.throwIfAborted();
      if (client.destroyed) return;
      const upstream = connect({
        host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 443),
        autoSelectFamily: true,
        lookup(_hostname, options, callback) {
          // Happy Eyeballs can try IPv4 and IPv6, using only the checked answers.
          if (options.all) callback(null, addresses);
          else callback(null, addresses[0].address, addresses[0].family);
        },
      });
      sockets.add(upstream);
      upstream.setTimeout(20_000, () => upstream.destroy(new Error("Browser connection timed out.")));
      upstream.on("error", (error) => { fail(error); client.destroy(); });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => { sockets.delete(upstream); client.destroy(); });
      upstream.once("connect", () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        upstream.on("data", count);
        client.on("data", count);
        upstream.pipe(client);
        client.pipe(upstream);
      });
    } catch (error) {
      fail(error);
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  const close = async () => {
    signal.removeEventListener("abort", abort);
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const abort = () => { for (const socket of sockets) socket.destroy(); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    signal.throwIfAborted();
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to start the web proxy.");
    return { url: `http://127.0.0.1:${address.port}`, close, failure: () => failure };
  } catch (error) { await close(); throw error; }
}
