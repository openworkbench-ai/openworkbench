import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface User {
  id: string;
  email: string;
  createdAt: number;
}

interface UserRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: number;
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, createdAt: row.created_at };
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Accounts and login sessions for the built-in email/password provider.
 * Nothing outside that provider reads this -- app ownership lives in its own
 * store (see ownership-store.ts) so a different auth provider can replace this
 * one wholesale. Session tokens are stored hashed, so a leaked database file
 * can't be replayed as live cookies.
 */
export function createUserStore(dbPath: string, now: () => number = () => Date.now()) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
  `);

  const insertUser = db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)");
  const userByEmail = db.prepare("SELECT * FROM users WHERE email = ?");
  const userById = db.prepare("SELECT * FROM users WHERE id = ?");
  const userCount = db.prepare("SELECT COUNT(*) AS n FROM users");
  const insertSession = db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)");
  const sessionUser = db.prepare(
    "SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  );
  const deleteSession = db.prepare("DELETE FROM sessions WHERE token_hash = ?");
  const deleteExpired = db.prepare("DELETE FROM sessions WHERE expires_at <= ?");

  return {
    /** Inserts a user. Returns null if the email is already registered. */
    createUser(email: string, passwordHash: string): User | null {
      const id = randomUUID();
      const createdAt = now();
      try {
        insertUser.run(id, email, passwordHash, createdAt);
      } catch (error) {
        if (error instanceof Error && /UNIQUE/i.test(error.message)) return null;
        throw error;
      }
      return { id, email, createdAt };
    },

    findByEmail(email: string): (User & { passwordHash: string }) | null {
      const row = userByEmail.get(email) as UserRow | undefined;
      return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
    },

    findById(id: string): User | null {
      const row = userById.get(id) as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    countUsers(): number {
      return (userCount.get() as { n: number }).n;
    },

    /** Starts a session and returns the raw token (only ever held by the client's cookie). */
    createSession(userId: string, ttlSeconds: number): string {
      const token = randomBytes(32).toString("base64url");
      const created = now();
      deleteExpired.run(created);
      insertSession.run(hashToken(token), userId, created, created + ttlSeconds * 1000);
      return token;
    },

    userForSession(token: string): User | null {
      const row = sessionUser.get(hashToken(token), now()) as UserRow | undefined;
      return row ? toUser(row) : null;
    },

    endSession(token: string): void {
      deleteSession.run(hashToken(token));
    },

    close(): void {
      db.close();
    },
  };
}

export type UserStore = ReturnType<typeof createUserStore>;
