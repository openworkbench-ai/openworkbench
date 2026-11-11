import assert from "node:assert/strict";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { test } from "node:test";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { fetchWebPage, requestWebResource } from "./web-fetch.js";

test("transport handles compression, redirects, charset and size limits with real HTTP streams", async (t) => {
  const requests: { path: string; auth?: string }[] = [];
  const text = "Readable compressed content. ".repeat(50);
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url!, auth: request.headers.authorization });
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (request.url === "/gzip") {
      response.setHeader("Content-Encoding", "gzip"); response.end(gzipSync(text));
    } else if (request.url === "/br") {
      response.setHeader("Content-Encoding", "br"); response.end(brotliCompressSync(Buffer.from(text)));
    } else if (request.url === "/deflate") {
      response.setHeader("Content-Encoding", "deflate"); response.end(deflateSync(text));
    } else if (request.url === "/bomb") {
      response.setHeader("Content-Encoding", "gzip"); response.end(gzipSync("x".repeat(10_000)));
    } else if (request.url === "/large") {
      response.end("x".repeat(10_000));
    } else if (request.url === "/redirect") {
      response.writeHead(302, { Location: "/final" }); response.end();
    } else if (request.url === "/cross-origin") {
      response.writeHead(302, { Location: "http://other.example/final" }); response.end();
    } else if (request.url === "/private") {
      response.writeHead(302, { Location: "http://127.0.0.1/secret" }); response.end();
    } else if (request.url === "/charset") {
      response.setHeader("Content-Type", "text/plain; charset=windows-1252"); response.end(Buffer.from([0x63, 0x61, 0x66, 0xe9]));
    } else if (request.url === "/unsupported") {
      response.setHeader("Content-Type", "application/pdf"); response.end("PDF");
    } else response.end("Final content");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const nativeRequest = http.request;
  // Redirect the already-validated public transport to the fixture server.
  const mock = t.mock.method(http, "request", ((url: URL, options: object, callback: (response: http.IncomingMessage) => void) =>
    nativeRequest(`http://127.0.0.1:${address.port}${url.pathname}`, options, callback)) as typeof http.request);
  syncBuiltinESMExports();
  t.after(async () => {
    mock.mock.restore(); syncBuiltinESMExports();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  for (const path of ["gzip", "br", "deflate"])
    assert.equal((await fetchWebPage(`http://fixture.example/${path}`)).body, text);
  assert.equal((await fetchWebPage("http://fixture.example/charset")).body, "café");
  assert.equal((await fetchWebPage("http://fixture.example/redirect")).url, "http://fixture.example/final");
  await requestWebResource("http://fixture.example/cross-origin", { headers: { Authorization: "fixture-secret" } });
  assert.equal(requests.at(-1)?.auth, undefined, "cross-origin redirect must not forward credentials");
  assert.equal((await requestWebResource("http://fixture.example/redirect", { followRedirects: false })).status, 302);
  await assert.rejects(requestWebResource("http://fixture.example/bomb", { maxBytes: 1000 }), /Decompressed response exceeds/);
  await assert.rejects(requestWebResource("http://fixture.example/large", { maxBytes: 1000 }), /download limit/);
  await assert.rejects(fetchWebPage("http://fixture.example/private"), /public web/);
  assert.ok(!requests.some(({ path }) => path === "/secret"));
  await assert.rejects(fetchWebPage("http://fixture.example/unsupported"), /Unsupported page type/);
});
