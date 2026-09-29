import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import type { AuthProvider } from "./auth-provider.js";
import { createPasswordProvider } from "./password-provider.js";
import { createUserStore } from "./user-store.js";

/** A minimal host: the provider's routes first, then a "protected" endpoint gated on authenticate(). */
async function withProvider(provider: AuthProvider, run: (base: string) => Promise<void>) {
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    if (await provider.handleRoute?.(req, res, url)) return;
    const user = await provider.authenticate(req);
    res.writeHead(user ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ user }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    server.close();
  }
}

function post(base: string, path: string, body: unknown, cookie?: string) {
  return fetch(base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const cookieOf = (res: Response) => res.headers.get("set-cookie")!.split(";", 1)[0];

test("register, authenticate via cookie, logout", async () => {
  const provider = createPasswordProvider(createUserStore(":memory:"), { allowSignup: true });
  await withProvider(provider, async (base) => {
    const registered = await post(base, "/api/auth/register", { email: "Ada@x.com", password: "analytical-engine" });
    assert.equal(registered.status, 200);
    const cookie = cookieOf(registered);

    const me = await (await fetch(base + "/me", { headers: { cookie } })).json();
    assert.equal(me.user.email, "ada@x.com");
    assert.ok(me.user.id);
    assert.equal((await fetch(base + "/me")).status, 401);

    const out = await post(base, "/api/auth/logout", {}, cookie);
    assert.equal(out.status, 200);
    assert.equal((await fetch(base + "/me", { headers: { cookie } })).status, 401);
  });
});

test("maps auth failures to HTTP statuses", async () => {
  const provider = createPasswordProvider(createUserStore(":memory:"), { allowSignup: true });
  await withProvider(provider, async (base) => {
    await post(base, "/api/auth/register", { email: "ada@x.com", password: "analytical-engine" });
    assert.equal((await post(base, "/api/auth/register", { email: "ada@x.com", password: "analytical-engine" })).status, 409);
    assert.equal((await post(base, "/api/auth/register", { email: "b@x.com", password: "short" })).status, 400);
    assert.equal((await post(base, "/api/auth/login", "not json")).status, 400);
    assert.equal((await post(base, "/api/auth/login", { email: "ada@x.com", password: "wrong-password" })).status, 401);
    assert.equal((await post(base, "/api/auth/login", { email: "ada@x.com", password: "analytical-engine" })).status, 200);
  });
});

test("closed sign-up admits only the first account", async () => {
  const provider = createPasswordProvider(createUserStore(":memory:"), { allowSignup: false });
  assert.deepEqual(provider.signIn(), { kind: "password", signupOpen: true });
  await withProvider(provider, async (base) => {
    assert.equal((await post(base, "/api/auth/register", { email: "owner@x.com", password: "owner-password" })).status, 200);
    assert.deepEqual(provider.signIn(), { kind: "password", signupOpen: false });
    assert.equal((await post(base, "/api/auth/register", { email: "in@x.com", password: "intruder-password" })).status, 403);
  });
});

test("blocks repeated failed logins for an account", async () => {
  const provider = createPasswordProvider(createUserStore(":memory:"), { allowSignup: true });
  await withProvider(provider, async (base) => {
    await post(base, "/api/auth/register", { email: "ada@x.com", password: "analytical-engine" });
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await post(base, "/api/auth/login", { email: "ada@x.com", password: "wrong-password" })).status);
    }
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 429]);
    // Even the right password is refused while blocked.
    assert.equal((await post(base, "/api/auth/login", { email: "ada@x.com", password: "analytical-engine" })).status, 429);
  });
});

test("leaves routes it doesn't own to the host", async () => {
  const provider = createPasswordProvider(createUserStore(":memory:"), { allowSignup: true });
  await withProvider(provider, async (base) => {
    assert.equal((await fetch(base + "/api/auth/login")).status, 401, "GET /login isn't a provider route");
    assert.equal((await post(base, "/api/auth/callback", {})).status, 401);
  });
});
