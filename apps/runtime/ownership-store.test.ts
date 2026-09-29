import assert from "node:assert/strict";
import { test } from "node:test";
import { createOwnershipStore } from "./ownership-store.js";

test("records one owner per app and never reassigns it", () => {
  const store = createOwnershipStore(":memory:");
  store.claim("notes", "ada");
  store.claim("notes", "bob");
  store.claim("tracker", "bob");

  assert.equal(store.ownerOf("notes"), "ada");
  assert.equal(store.ownerOf("missing"), null);
  assert.deepEqual([...store.appsOwnedBy("bob")], ["tracker"]);
  assert.deepEqual([...store.appsOwnedBy("nobody")], []);
});

test("pre-existing apps go to the first user only, once", () => {
  const store = createOwnershipStore(":memory:");
  store.claim("owned", "bob");

  assert.equal(store.claimExistingOnce("ada", ["hyrox", "owned"]), true);
  assert.deepEqual([...store.appsOwnedBy("ada")], ["hyrox"]);
  assert.equal(store.ownerOf("owned"), "bob", "an already-owned app is left alone");

  assert.equal(store.claimExistingOnce("bob", ["late-arrival"]), false);
  assert.equal(store.ownerOf("late-arrival"), null);
});

test("ownership ids are opaque strings, not tied to any accounts table", () => {
  const store = createOwnershipStore(":memory:");
  store.claim("app", "clerk|user_2abc");
  assert.equal(store.ownerOf("app"), "clerk|user_2abc");
});
