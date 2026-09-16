import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { createPasswordAuth } from "./auth.js";

function request(cookie?: string, forwardedProto?: string): IncomingMessage {
  return {
    headers: { cookie, ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}) },
    socket: {},
  } as IncomingMessage;
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

test("verifies the configured password", () => {
  const auth = createPasswordAuth("correct horse battery staple");
  assert.equal(auth.verifyPassword("correct horse battery staple"), true);
  assert.equal(auth.verifyPassword("wrong"), false);
});

test("issues, validates, and expires signed sessions", () => {
  let now = 1_700_000_000_000;
  const auth = createPasswordAuth("showcase", { sessionTtlSeconds: 60, now: () => now });
  const cookie = cookieValue(auth.createSessionCookie(request()));

  assert.equal(auth.isAuthenticated(request(cookie)), true);

  now += 61_000;
  assert.equal(auth.isAuthenticated(request(cookie)), false);
});

test("rejects tampered sessions and sessions signed with an old password", () => {
  const first = createPasswordAuth("first");
  const second = createPasswordAuth("second");
  const cookie = cookieValue(first.createSessionCookie(request()));

  assert.equal(first.isAuthenticated(request(`${cookie}x`)), false);
  assert.equal(second.isAuthenticated(request(cookie)), false);
});

test("marks cookies secure behind an HTTPS proxy", () => {
  const auth = createPasswordAuth("showcase");
  assert.match(auth.createSessionCookie(request(undefined, "https")), /; Secure;/);
  assert.doesNotMatch(auth.createSessionCookie(request()), /; Secure;/);
});

