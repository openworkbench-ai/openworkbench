import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Which user owns which installed app -- the core's whole notion of tenancy.
 * User ids are opaque strings handed over by the auth provider; there is
 * deliberately no `users` table (or foreign key to one) here, so ownership
 * survives swapping one provider for another as long as the ids stay stable.
 */
export function createOwnershipStore(dbPath: string) {
  if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_owners (
      app_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS app_owners_user ON app_owners(user_id);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);

  const claimApp = db.prepare("INSERT OR IGNORE INTO app_owners (app_id, user_id) VALUES (?, ?)");
  const appOwner = db.prepare("SELECT user_id FROM app_owners WHERE app_id = ?");
  const ownedApps = db.prepare("SELECT app_id FROM app_owners WHERE user_id = ?");
  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
  const setMeta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");

  let legacyHandled = (getMeta.get("legacy_claimed") as { value: string } | undefined) != null;

  return {
    /** Records `userId` as owner of `appId` unless someone already owns it. */
    claim(appId: string, userId: string): void {
      claimApp.run(appId, userId);
    },

    ownerOf(appId: string): string | null {
      return (appOwner.get(appId) as { user_id: string } | undefined)?.user_id ?? null;
    },

    appsOwnedBy(userId: string): Set<string> {
      return new Set((ownedApps.all(userId) as { app_id: string }[]).map((r) => r.app_id));
    },

    /**
     * Apps that predate ownership (the single-tenant days) belong to whoever
     * signs in first on the instance. Runs at most once, ever: `userId` takes
     * every currently-unowned app in `appIds`, and later calls do nothing.
     * Returns whether it ran.
     */
    claimExistingOnce(userId: string, appIds: string[]): boolean {
      if (legacyHandled) return false;
      for (const appId of appIds) claimApp.run(appId, userId);
      setMeta.run("legacy_claimed", userId);
      legacyHandled = true;
      return true;
    },

    close(): void {
      db.close();
    },
  };
}

export type OwnershipStore = ReturnType<typeof createOwnershipStore>;
