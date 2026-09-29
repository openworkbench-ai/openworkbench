import type { IncomingMessage } from "node:http";
import { hashPassword, verifyAgainstDecoy, verifyPassword } from "./password.js";
import type { User, UserStore } from "./user-store.js";

export const COOKIE_NAME = "owb_session";
const DEFAULT_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const MIN_PASSWORD_LENGTH = 8;
// scrypt cost is linear in input size; an unbounded password is a cheap DoS.
export const MAX_PASSWORD_LENGTH = 128;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class AuthError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 409,
    message: string
  ) {
    super(message);
  }
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

/** Lowercases and trims; returns null if the result isn't a plausible address. */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(email) ? email : null;
}

export interface AuthOptions {
  /** When false, only the very first account can be created (it becomes the owner of any pre-existing apps). */
  allowSignup: boolean;
  sessionTtlSeconds?: number;
}

export interface Auth {
  /** True if a new account may be created right now. */
  signupOpen(): boolean;
  register(email: unknown, password: unknown): Promise<{ user: User; token: string; firstUser: boolean }>;
  login(email: unknown, password: unknown): Promise<{ user: User; token: string }>;
  /** Resolves the request's session cookie to its user, or null. */
  authenticate(req: IncomingMessage): User | null;
  logout(req: IncomingMessage): void;
  sessionCookie(req: IncomingMessage, token: string): string;
  clearCookie(req: IncomingMessage): string;
}

/**
 * Email + password accounts with server-side sessions. The cookie carries only
 * a random opaque token (HttpOnly, SameSite=Strict); the session record lives
 * in the user store, so logout and expiry take effect immediately.
 */
export function createAuth(store: UserStore, options: AuthOptions): Auth {
  const ttl = options.sessionTtlSeconds ?? DEFAULT_SESSION_TTL_SECONDS;

  function cookieAttributes(req: IncomingMessage): string {
    return `HttpOnly; SameSite=Strict; Path=/;${requestIsSecure(req) ? " Secure;" : ""}`;
  }

  function tokenOf(req: IncomingMessage): string | undefined {
    return parseCookies(req.headers.cookie).get(COOKIE_NAME) || undefined;
  }

  function signupOpen(): boolean {
    return options.allowSignup || store.countUsers() === 0;
  }

  return {
    signupOpen,

    async register(rawEmail, rawPassword) {
      if (!signupOpen()) throw new AuthError(403, "Sign-ups are closed on this workbench.");
      const email = normalizeEmail(rawEmail);
      if (!email) throw new AuthError(400, "Enter a valid email address.");
      if (typeof rawPassword !== "string" || rawPassword.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(400, `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      }
      if (rawPassword.length > MAX_PASSWORD_LENGTH) {
        throw new AuthError(400, `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`);
      }

      const firstUser = store.countUsers() === 0;
      const user = store.createUser(email, await hashPassword(rawPassword));
      if (!user) throw new AuthError(409, "An account with that email already exists.");
      return { user, token: store.createSession(user.id, ttl), firstUser };
    },

    async login(rawEmail, rawPassword) {
      const email = normalizeEmail(rawEmail);
      const password = typeof rawPassword === "string" && rawPassword.length <= MAX_PASSWORD_LENGTH ? rawPassword : "";
      const record = email ? store.findByEmail(email) : null;
      // Always spend one scrypt, so response time doesn't reveal whether the email is registered.
      const ok = record ? await verifyPassword(password, record.passwordHash) : await verifyAgainstDecoy(password);
      if (!record || !ok || !password) throw new AuthError(401, "Incorrect email or password.");
      const { passwordHash: _omit, ...user } = record;
      return { user, token: store.createSession(user.id, ttl) };
    },

    authenticate(req) {
      const token = tokenOf(req);
      return token ? store.userForSession(token) : null;
    },

    logout(req) {
      const token = tokenOf(req);
      if (token) store.endSession(token);
    },

    sessionCookie(req, token) {
      return `${COOKIE_NAME}=${token}; Max-Age=${ttl}; ${cookieAttributes(req)}`;
    },

    clearCookie(req) {
      return `${COOKIE_NAME}=; Max-Age=0; ${cookieAttributes(req)}`;
    },
  };
}

/** Fixed-window limiter for failed attempts, keyed by client. */
export function createAttemptLimiter(maxAttempts: number, windowMs: number, now: () => number = () => Date.now()) {
  const attempts = new Map<string, { count: number; resetAt: number }>();
  return {
    /** Seconds until `key` may try again, or 0 if it isn't blocked. */
    retryAfter(key: string): number {
      const entry = attempts.get(key);
      if (!entry || entry.resetAt <= now() || entry.count < maxAttempts) return 0;
      return Math.ceil((entry.resetAt - now()) / 1000);
    },
    fail(key: string): void {
      const entry = attempts.get(key);
      const live = entry && entry.resetAt > now();
      attempts.set(key, { count: live ? entry.count + 1 : 1, resetAt: live ? entry.resetAt : now() + windowMs });
    },
    reset(key: string): void {
      attempts.delete(key);
    },
  };
}
