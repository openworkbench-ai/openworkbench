import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const COOKIE_NAME = "owb_session";
const DEFAULT_SESSION_TTL_SECONDS = 12 * 60 * 60;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function requestIsSecure(req: IncomingMessage): boolean {
  const forwardedProto = req.headers["x-forwarded-proto"];
  const value = Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto;
  const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted;
  return value?.split(",")[0]?.trim().toLowerCase() === "https" || Boolean(encrypted);
}

export interface PasswordAuth {
  verifyPassword(candidate: string): boolean;
  isAuthenticated(req: IncomingMessage): boolean;
  createSessionCookie(req: IncomingMessage): string;
  clearSessionCookie(req: IncomingMessage): string;
}

/**
 * Password authentication for the self-hosted showcase. The password is never
 * stored in a browser-readable cookie: the cookie contains only an expiry and
 * an HMAC signature derived from APP_PASSWORD. Changing APP_PASSWORD therefore
 * invalidates every existing session without requiring a session database.
 */
export function createPasswordAuth(
  password: string,
  options: { sessionTtlSeconds?: number; now?: () => number } = {}
): PasswordAuth {
  if (!password) throw new Error("APP_PASSWORD must not be empty.");

  const passwordDigest = digest(password);
  const signingKey = createHash("sha256").update("openworkbench-session\0").update(password).digest();
  const sessionTtlSeconds = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;
  const now = options.now ?? (() => Date.now());

  function sign(payload: string): string {
    return createHmac("sha256", signingKey).update(payload).digest("base64url");
  }

  function cookieAttributes(req: IncomingMessage): string {
    return `HttpOnly; SameSite=Strict; Path=/;${requestIsSecure(req) ? " Secure;" : ""}`;
  }

  return {
    verifyPassword(candidate) {
      return timingSafeEqual(passwordDigest, digest(candidate));
    },

    isAuthenticated(req) {
      const token = parseCookies(req.headers.cookie).get(COOKIE_NAME);
      if (!token) return false;

      const separator = token.indexOf(".");
      if (separator === -1) return false;
      const expiryRaw = token.slice(0, separator);
      const suppliedSignature = token.slice(separator + 1);
      const expiry = Number.parseInt(expiryRaw, 10);
      if (!Number.isSafeInteger(expiry) || expiry <= Math.floor(now() / 1000)) return false;

      const expectedSignature = sign(expiryRaw);
      const supplied = Buffer.from(suppliedSignature);
      const expected = Buffer.from(expectedSignature);
      return supplied.length === expected.length && timingSafeEqual(supplied, expected);
    },

    createSessionCookie(req) {
      const expiry = Math.floor(now() / 1000) + sessionTtlSeconds;
      const payload = String(expiry);
      return `${COOKIE_NAME}=${payload}.${sign(payload)}; Max-Age=${sessionTtlSeconds}; ${cookieAttributes(req)}`;
    },

    clearSessionCookie(req) {
      return `${COOKIE_NAME}=; Max-Age=0; ${cookieAttributes(req)}`;
    },
  };
}
