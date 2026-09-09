/**
 * The live-run lock next to the audit log. The duplicate guard and the key
 * reuse read the log before they write it, so one live run per log at a
 * time is a payment-safety rule, not a convenience.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { LiveLockError, acquireLiveLock, releaseLockQuietly } from "../src/audit";
import { tempAuditPath } from "./helpers";

describe("acquireLiveLock", () => {
  it("creates the lock next to the log, refuses a second holder and frees it on release", async () => {
    const auditPath = await tempAuditPath();
    const lock = await acquireLiveLock(auditPath, 4242, new Date("2026-09-07T10:00:00.000Z"));
    assert.equal(lock.path, `${auditPath}.lock`);
    assert.equal(await readFile(lock.path, "utf8"), "pid 4242 since 2026-09-07T10:00:00.000Z\n");

    await assert.rejects(acquireLiveLock(auditPath, 4343), (error: unknown) => {
      assert.ok(error instanceof LiveLockError);
      assert.match(error.message, /another live run holds .*\.lock \(pid 4242 since 2026-09-07T10:00:00\.000Z\)/);
      assert.match(error.message, /delete the file and start again\. Nothing was read or spawned\./);
      return true;
    });
    // The refused caller must not touch the holder's file.
    assert.equal(await readFile(lock.path, "utf8"), "pid 4242 since 2026-09-07T10:00:00.000Z\n");

    await lock.release();
    await assert.rejects(readFile(lock.path), /ENOENT/);
    const again = await acquireLiveLock(auditPath, 4343);
    await again.release();
  });

  it("release is idempotent", async () => {
    const lock = await acquireLiveLock(await tempAuditPath());
    await lock.release();
    await lock.release();
  });
});

describe("releaseLockQuietly", () => {
  it("turns a failed removal into a warning instead of an exception", async () => {
    const warnings: string[] = [];
    const error = Object.assign(new Error("read-only file system"), { code: "EROFS" });
    await releaseLockQuietly(
      {
        path: "/tmp/agent-gate/audit.log.lock",
        release: () => Promise.reject(error),
      },
      (line) => warnings.push(line),
    );
    assert.deepEqual(warnings, ["could not remove /tmp/agent-gate/audit.log.lock (EROFS); delete it by hand before the next live run"]);
  });

  it("stays silent when the removal works", async () => {
    const warnings: string[] = [];
    const lock = await acquireLiveLock(await tempAuditPath());
    await releaseLockQuietly(lock, (line) => warnings.push(line));
    assert.deepEqual(warnings, []);
  });
});
