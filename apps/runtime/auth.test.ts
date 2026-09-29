import assert from "node:assert/strict";
import type { IncomingMessage } from "node:http";
import { test } from "node:test";
import { AuthError, createAttemptLimiter, createAuth, normalizeEmail } from "./auth.js";
import { hashPassword, verifyPassword } from "./password.js";
import { createUserStore } from "./user-store.js";

function request(cookie?: string, forwardedProto?: string): IncomingMessage {
  return {
    headers: { cookie, ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}) },
    socket: {},
  } as IncomingMessage;
}

function cookieValue(setCookie: string): string {
  return setCookie.split(";", 1)[0];
}

function setup(options: { allowSignup?: boolean; sessionTtlSeconds?: number; now?: () => number } = {}) {
  const store = createUserStore(":memory:", options.now);
  const auth = createAuth(store, { allowSignup: options.allowSignup ?? true, sessionTtlSeconds: options.sessionTtlSeconds });
  return { store, auth };
}

async function rejects(promise: Promise<unknown>, status: number) {
  await assert.rejects(promise, (error) => error instanceof AuthError && error.status === status);
}

test("hashes passwords with a per-hash salt and verifies them", async () => {
  const a = await hashPassword("correct horse battery staple");
  const b = await hashPassword("correct horse battery staple");
  assert.notEqual(a, b);
  assert.equal(await verifyPassword("correct horse battery staple", a), true);
  assert.equal(await verifyPassword("wrong", a), false);
  assert.equal(await verifyPassword("anything", "not-a-hash"), false);
});

test("normalizes and validates emails", () => {
  assert.equal(normalizeEmail("  Ada@Example.COM "), "ada@example.com");
  assert.equal(normalizeEmail("nope"), null);
  assert.equal(normalizeEmail("a b@example.com"), null);
  assert.equal(normalizeEmail(42), null);
});

test("registers a user, starts a session, and resolves it from the cookie", async () => {
  const { auth } = setup();
  const { user, token, firstUser } = await auth.register("Ada@Example.com", "analytical-engine");
  assert.equal(user.email, "ada@example.com");
  assert.equal(firstUser, true);

  const cookie = cookieValue(auth.sessionCookie(request(), token));
  assert.equal(auth.authenticate(request(cookie))?.id, user.id);
  assert.equal(auth.authenticate(request()), null);
  assert.equal(auth.authenticate(request("owb_session=forged")), null);
});

test("rejects bad registrations", async () => {
  const { auth } = setup();
  await rejects(auth.register("not-an-email", "long-enough-pw"), 400);
  await rejects(auth.register("a@example.com", "short"), 400);
  await rejects(auth.register("a@example.com", "x".repeat(129)), 400);
  await auth.register("a@example.com", "long-enough-pw");
  await rejects(auth.register("A@example.com", "another-long-pw"), 409);
});

test("logs in with the right password only", async () => {
  const { auth } = setup();
  await auth.register("ada@example.com", "analytical-engine");

  const { user, token } = await auth.login(" ADA@example.com", "analytical-engine");
  assert.equal(user.email, "ada@example.com");
  assert.ok(token);
  assert.equal("passwordHash" in user, false);

  await rejects(auth.login("ada@example.com", "wrong-password"), 401);
  await rejects(auth.login("nobody@example.com", "analytical-engine"), 401);
  await rejects(auth.login("ada@example.com", ""), 401);
  await rejects(auth.login(undefined, undefined), 401);
});

test("logout ends the session server-side", async () => {
  const { auth } = setup();
  const { token } = await auth.register("ada@example.com", "analytical-engine");
  const cookie = cookieValue(auth.sessionCookie(request(), token));
  assert.ok(auth.authenticate(request(cookie)));

  auth.logout(request(cookie));
  assert.equal(auth.authenticate(request(cookie)), null);
});

test("sessions expire", async () => {
  let now = 1_700_000_000_000;
  const { auth } = setup({ sessionTtlSeconds: 60, now: () => now });
  const { token } = await auth.register("ada@example.com", "analytical-engine");
  const cookie = cookieValue(auth.sessionCookie(request(), token));

  assert.ok(auth.authenticate(request(cookie)));
  now += 61_000;
  assert.equal(auth.authenticate(request(cookie)), null);
});

test("closed sign-up still admits the first account, then refuses more", async () => {
  const { auth } = setup({ allowSignup: false });
  assert.equal(auth.signupOpen(), true);
  await auth.register("owner@example.com", "owner-password");
  assert.equal(auth.signupOpen(), false);
  await rejects(auth.register("intruder@example.com", "intruder-password"), 403);
});

test("session cookies are HttpOnly and Secure behind https", () => {
  const { auth } = setup();
  const plain = auth.sessionCookie(request(), "t");
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.doesNotMatch(plain, /Secure/);
  assert.match(auth.sessionCookie(request(undefined, "https"), "t"), /Secure/);
  assert.match(auth.clearCookie(request()), /Max-Age=0/);
});

test("attempt limiter blocks after the threshold and resets after the window", () => {
  let now = 0;
  const limiter = createAttemptLimiter(3, 1000, () => now);
  for (let i = 0; i < 3; i++) limiter.fail("ip");
  assert.equal(limiter.retryAfter("ip"), 1);
  assert.equal(limiter.retryAfter("other"), 0);
  now = 1001;
  assert.equal(limiter.retryAfter("ip"), 0);

  limiter.fail("ip");
  limiter.reset("ip");
  assert.equal(limiter.retryAfter("ip"), 0);
});
