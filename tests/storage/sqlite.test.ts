import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../src/core/errors.ts";
import { loadDatabaseSync } from "../../src/storage/sqlite.ts";

test("loads DatabaseSync through the SQLite boundary", () => {
  class FakeDatabaseSync {}
  assert.equal(loadDatabaseSync(() => ({ DatabaseSync: FakeDatabaseSync })), FakeDatabaseSync);
});

test("reports an actionable configuration error when node:sqlite is unavailable", () => {
  assert.throws(
    () => loadDatabaseSync(() => { throw new Error("No such built-in module: node:sqlite"); }),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && error.message === "Node.js 24 or newer is required to run QiYan Bot",
  );
});

test("rejects an invalid node:sqlite module without exposing loader details", () => {
  assert.throws(
    () => loadDatabaseSync(() => ({})),
    (error: unknown) => error instanceof AppError
      && error.code === "CONFIGURATION_ERROR"
      && error.message === "Node.js 24 or newer is required to run QiYan Bot",
  );
});
