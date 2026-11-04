import assert from "node:assert/strict";
import { test } from "node:test";
import { ExpiringMap, RateLimiter, isAdmin } from "../src/security.js";

test("manager group membership alone does not grant admin access", () => {
  assert.equal(isAdmin(42, -100, -100, [7]), false);
  assert.equal(isAdmin(7, -200, -100, [7]), false);
  assert.equal(isAdmin(7, -100, -100, []), false);
  assert.equal(isAdmin(undefined, -100, -100, [7]), false);
  assert.equal(isAdmin(7, -100, -100, [7]), true);
});

test("drafts expire after inactivity and storage has a fixed capacity", () => {
  const drafts = new ExpiringMap<string>(100, 2);
  drafts.set(1, "private", 0);
  assert.equal(drafts.get(1, 100), undefined);
  drafts.set(1, "first", 100);
  drafts.set(2, "second", 100);
  drafts.set(3, "third", 100);
  assert.equal(drafts.get(1, 101), undefined);
  assert.equal(drafts.get(3, 101), "third");
});

test("per-user and global rate limits reset in the next window", () => {
  const limiter = new RateLimiter();
  for (let i = 0; i < 30; i++) assert.equal(limiter.allow(1, 100_000), true);
  assert.equal(limiter.allow(1, 100_000), false);
  assert.equal(limiter.allow(2, 100_000), true);
  assert.equal(limiter.allow(1, 160_000), true);
  const global = new RateLimiter();
  for (let i = 0; i < 600; i++) assert.equal(global.allow(i, 100_000), true);
  assert.equal(global.allow(601, 100_000), false);
  assert.equal(global.allow(601, 160_000), true);
});
