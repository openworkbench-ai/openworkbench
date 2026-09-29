import type { IncomingMessage } from "node:http";
import type { AuthProvider } from "./auth-provider.js";
import { AuthError, createAttemptLimiter, createAuth } from "./auth.js";
import { clientIdOf, sendJson } from "./http.js";
import type { UserStore } from "./user-store.js";

const MAX_BODY_BYTES = 16 * 1024;

/** Reads a small JSON object body, or throws an AuthError(400). */
async function readJsonObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > MAX_BODY_BYTES) throw new AuthError(400, "Request body too large.");
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new AuthError(400, "Expected a JSON object body.");
}

/**
 * The built-in AuthProvider: email + password accounts kept in the runtime's
 * own SQLite file. Owns `/api/auth/{register,login,logout}` and their rate
 * limits. Swap it for a hosted provider by implementing AuthProvider instead.
 */
export function createPasswordProvider(store: UserStore, options: { allowSignup: boolean; sessionTtlSeconds?: number }): AuthProvider {
  const auth = createAuth(store, options);
  const loginLimiter = createAttemptLimiter(5, 15 * 60 * 1000);
  const registerLimiter = createAttemptLimiter(10, 60 * 60 * 1000);

  return {
    async authenticate(req) {
      const user = auth.authenticate(req);
      return user ? { id: user.id, email: user.email } : null;
    },

    signIn() {
      return { kind: "password", signupOpen: auth.signupOpen() };
    },

    async handleRoute(req, res, url) {
      if (req.method !== "POST") return false;
      if (url.pathname !== "/api/auth/register" && url.pathname !== "/api/auth/login" && url.pathname !== "/api/auth/logout") {
        return false;
      }

      try {
        if (url.pathname === "/api/auth/logout") {
          auth.logout(req);
          res.setHeader("Set-Cookie", auth.clearCookie(req));
          sendJson(res, 200, { authenticated: false });
          return true;
        }

        const client = clientIdOf(req);

        if (url.pathname === "/api/auth/register") {
          const retryAfter = registerLimiter.retryAfter(client);
          if (retryAfter > 0) {
            res.setHeader("Retry-After", String(retryAfter));
            sendJson(res, 429, { error: "Too many sign-up attempts. Try again later." });
            return true;
          }
          registerLimiter.fail(client);

          const { email, password } = await readJsonObject(req);
          const { user, token } = await auth.register(email, password);
          res.setHeader("Set-Cookie", auth.sessionCookie(req, token));
          sendJson(res, 200, { authenticated: true, user: { id: user.id, email: user.email } });
          return true;
        }

        const { email, password } = await readJsonObject(req);
        // Limit per address and per account, so neither one IP nor a botnet can grind one email's password.
        const keys = [`ip:${client}`, `email:${String(email).trim().toLowerCase()}`];
        const retryAfter = Math.max(...keys.map((key) => loginLimiter.retryAfter(key)));
        if (retryAfter > 0) {
          res.setHeader("Retry-After", String(retryAfter));
          sendJson(res, 429, { error: "Too many failed attempts. Try again later." });
          return true;
        }

        try {
          const { user, token } = await auth.login(email, password);
          keys.forEach((key) => loginLimiter.reset(key));
          res.setHeader("Set-Cookie", auth.sessionCookie(req, token));
          sendJson(res, 200, { authenticated: true, user: { id: user.id, email: user.email } });
        } catch (error) {
          if (error instanceof AuthError && error.status === 401) keys.forEach((key) => loginLimiter.fail(key));
          throw error;
        }
        return true;
      } catch (error) {
        if (error instanceof AuthError) {
          sendJson(res, error.status, { error: error.message });
          return true;
        }
        throw error;
      }
    },
  };
}
