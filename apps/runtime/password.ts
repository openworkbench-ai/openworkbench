import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

const N = 16384;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

/** Hashes with scrypt and a random salt. Output is self-describing (`scrypt$N$r$p$salt$hash`) so parameters can be raised later without breaking stored hashes. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/** Constant-time check of `password` against a `hashPassword` result. A malformed stored hash is simply a non-match. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, salt, hash] = stored.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  try {
    const key = await scryptAsync(password, Buffer.from(salt, "base64url"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
    });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

/** A real hash of a throwaway password, verified against when the account doesn't exist so that "no such user" and "wrong password" take equally long. */
let decoyHash: Promise<string> | undefined;
export function verifyAgainstDecoy(password: string): Promise<boolean> {
  decoyHash ??= hashPassword(randomBytes(16).toString("hex"));
  return decoyHash.then((hash) => verifyPassword(password, hash));
}
