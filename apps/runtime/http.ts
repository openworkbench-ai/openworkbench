import type { IncomingMessage, ServerResponse } from "node:http";

export function sendJson(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

/** Best-effort client address for rate limiting; trusts Cloudflare/proxy headers because this server only listens behind the web container's proxy. */
export function clientIdOf(req: IncomingMessage): string {
  const forwarded = req.headers["cf-connecting-ip"] ?? req.headers["x-forwarded-for"];
  return (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? "unknown";
}
