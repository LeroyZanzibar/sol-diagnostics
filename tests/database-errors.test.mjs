import test from "node:test";
import assert from "node:assert/strict";
import { loadSource } from "./source-module.mjs";

const errors = loadSource("app/api/performance-summary/database-errors.ts", [], {
  setTimeout: callback => { callback(); return 0; },
});

test("retained upload timestamp errors remain actionable without exposing arbitrary internal errors", () => {
  const message = "Invalid timestamp on CSV row 42: daylight-saving times require an explicit UTC offset.";
  assert.ok(errors.analysisFailureMessage(new Error(message)).includes(message));
  assert.match(errors.analysisFailureMessage(new Error(message)), /upload again/);
  assert.doesNotMatch(errors.analysisFailureMessage(new Error("secret internal data")), /secret/);
});

test("transient writes retry with cancellation checks and a bounded attempt count", async () => {
  let writes = 0, checks = 0;
  const transient = new Error("D1_ERROR", { cause: new Error("SQLITE_BUSY: database is locked") });
  assert.equal(await errors.retryDatabaseWrite("batch", async () => {
    if (++writes < 3) throw transient;
    return "saved";
  }, async () => { checks++; }), "saved");
  assert.equal(writes, 3);
  assert.equal(checks, 2);
  writes = 0;
  await assert.rejects(errors.retryDatabaseWrite("batch", async () => { writes++; throw transient; }));
  assert.equal(writes, 4);
  writes = 0;
  await assert.rejects(errors.retryDatabaseWrite("batch", async () => { writes++; throw transient; },
    async () => { throw new Error("Canceled"); }), /Canceled/);
  assert.equal(writes, 1);
});

test("permanent errors retain nested diagnostics without pointless retries", async () => {
  for (const message of ["SQLITE_FULL: database or disk is full", "SQLITE_CONSTRAINT: unique constraint failed", "D1 daily quota exceeded"]) {
    let writes = 0;
    try {
      await errors.retryDatabaseWrite("analysis run", async () => {
        writes++; throw new Error("D1_ERROR", { cause: new Error(message) });
      });
      assert.fail("must reject");
    } catch (error) {
      assert.ok(errors.databaseErrorDetails(error).includes(message));
      assert.doesNotMatch(errors.analysisFailureMessage(error), /could not complete/);
    }
    assert.equal(writes, 1);
  }
});
