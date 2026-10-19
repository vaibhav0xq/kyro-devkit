/**
 * Discovery and the resume command. Nothing here spawns a process: the
 * reconciler is a stub that returns a recorded listing and counts how often
 * it was asked, which is how "running resume twice is a no-op" is checked.
 *
 * The audit log is a real temp file written through the real append path,
 * so the append-only promise and the torn-line behaviour are exercised as
 * they are in a live run.
 */
import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import type { CliOutcome, Reconciler } from "../src/circle";
import { createAuditLog } from "../src/audit";
import type { AuditEntry } from "../src/audit";
import { runResume } from "../src/resume";
import { AGENT, BUILDER, OTHER, collectOut, tempAuditPath } from "./helpers";

const KEY = "3f2a9c1e-7b4d-4c8a-9f21-5e6d7c8b9a01";
const INTENT_AT = "2026-09-07T10:00:00.000Z";
const TX_ID = "7f1e2d3c-4b5a-4f60-9e8d-1c2b3a4f5e6d";
const HASH = `0x${"ab".repeat(32)}`;

function intentLine(overrides: Record<string, unknown> = {}): AuditEntry {
  return {
    type: "intent",
    at: INTENT_AT,
    runId: "run-1",
    mode: "live",
    invoiceId: "inv-001",
    to: BUILDER,
    requestedUsdc: 1.5,
    approvedUsdc: 1.5,
    action: "proceed",
    humanApproved: false,
    conditions: [],
    verdict: "allow",
    advisoryLimitUsdc: 1000,
    cacheStatus: "cached",
    decisionModelVersion: "decision_v0.4.1",
    kyroFailure: null,
    simulated: false,
    idempotencyKey: KEY,
    receiptId: null,
    receiptPayloadHash: null,
    receiptDeduped: null,
    receiptUrl: null,
    ...overrides,
  } as AuditEntry;
}

function resultLine(state: string, overrides: Record<string, unknown> = {}): AuditEntry {
  return {
    type: "result",
    at: "2026-09-07T10:00:09.000Z",
    runId: "run-1",
    mode: "live",
    invoiceId: "inv-001",
    to: BUILDER,
    amountUsdc: 1.5,
    state,
    argv: ["wallet", "transfer"],
    txHash: null,
    transactionId: null,
    idempotencyKey: KEY,
    exitCode: 1,
    errorCode: "TIMEOUT",
    detail: "no answer before the timeout",
    ...overrides,
  } as AuditEntry;
}

function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: TX_ID,
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash: HASH,
    sourceAddress: AGENT,
    destinationAddress: BUILDER,
    amounts: ["1.5"],
    operation: "TRANSFER",
    transactionType: "OUTBOUND",
    createDate: "2026-09-07T10:00:04.182Z",
    updateDate: "2026-09-07T10:00:41.907Z",
    firstConfirmDate: "2026-09-07T10:00:26.550Z",
    ...overrides,
  };
}

/** A reconciler that answers from memory and records every call. */
function stubReconciler(...transactions: Record<string, unknown>[]): Reconciler & { calls: number } {
  const outcome: CliOutcome = {
    exitCode: 0,
    signal: null,
    stdout: JSON.stringify({ data: { transactions } }),
    stderr: "",
    timedOut: false,
  };
  const stub = {
    calls: 0,
    async list(_agentWallet: string, hooks?: { onSpawn?: (argv: string[]) => void }) {
      stub.calls += 1;
      const argv = ["transaction", "list"];
      hooks?.onSpawn?.(argv);
      return { argv, outcome };
    },
  };
  return stub;
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("unresolvedLiveAttempts", () => {
  it("finds a live proceed intent that never got a result", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine());
    assert.deepEqual(await audit.unresolvedLiveAttempts(), [
      { invoiceId: "inv-001", to: BUILDER, amountUsdc: 1.5, idempotencyKey: KEY, intentAt: INTENT_AT },
    ]);
  });

  it("keeps an attempt whose result was unknown, which is the case worth chasing", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine());
    await audit.append(resultLine("unknown"));
    assert.equal((await audit.unresolvedLiveAttempts()).length, 1);
  });

  it("drops an attempt with a terminal result", async () => {
    for (const state of ["submitted", "failed"]) {
      const audit = createAuditLog(await tempAuditPath());
      await audit.append(intentLine());
      await audit.append(resultLine(state));
      assert.deepEqual(await audit.unresolvedLiveAttempts(), [], state);
    }
  });

  it("drops an attempt a resolution already settled, and keeps one it could not", async () => {
    for (const [outcome, remaining] of [
      ["confirmed", 0],
      ["failed", 0],
      ["unknown", 1],
    ] as const) {
      const path = await tempAuditPath();
      const audit = createAuditLog(path);
      await audit.append(intentLine());
      await audit.append(resultLine("unknown"));
      await audit.append({
        type: "resolution",
        at: "2026-09-07T11:00:00.000Z",
        runId: "run-2",
        mode: "live",
        invoiceId: "inv-001",
        to: BUILDER,
        amountUsdc: 1.5,
        idempotencyKey: KEY,
        outcome,
        transactionId: outcome === "unknown" ? null : TX_ID,
        txHash: outcome === "confirmed" ? HASH : null,
        source: "circle transaction list",
        detail: "test",
      });
      assert.equal((await audit.unresolvedLiveAttempts()).length, remaining, outcome);
    }
  });

  it("ignores dry-run entries, which moved nothing", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine({ mode: "dry-run", idempotencyKey: null }));
    await audit.append(intentLine({ mode: "dry-run" }));
    assert.deepEqual(await audit.unresolvedLiveAttempts(), []);
  });

  it("ignores holds and refuses, which never reached an executor", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine({ action: "hold", approvedUsdc: null, idempotencyKey: null }));
    await audit.append(intentLine({ action: "refuse", approvedUsdc: null, idempotencyKey: null }));
    assert.deepEqual(await audit.unresolvedLiveAttempts(), []);
  });

  it("counts a reused key once and starts its window at the first intent", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine());
    await audit.append(resultLine("unknown"));
    await audit.append(intentLine({ at: "2026-09-08T10:00:00.000Z", runId: "run-2" }));
    const open = await audit.unresolvedLiveAttempts();
    assert.equal(open.length, 1);
    assert.equal(open[0]?.intentAt, INTENT_AT);
  });

  it("survives a torn final line without trusting it", async () => {
    const path = await tempAuditPath();
    const audit = createAuditLog(path);
    await audit.append(intentLine());
    // A process killed mid-write leaves a fragment behind.
    await appendFile(path, '{"type":"result","at":"2026-09-07T10:0', "utf8");
    assert.equal((await audit.unresolvedLiveAttempts()).length, 1);
  });

  it("skips a resolution line missing the fields it is read by", async () => {
    const path = await tempAuditPath();
    const audit = createAuditLog(path);
    await audit.append(intentLine());
    await appendFile(
      path,
      `${JSON.stringify({ type: "resolution", at: "2026-09-07T11:00:00.000Z", mode: "live", invoiceId: "inv-001", to: BUILDER, amountUsdc: 1.5, outcome: "confirmed" })}\n`,
      "utf8",
    );
    // No idempotencyKey, so it settles nothing.
    assert.equal((await audit.unresolvedLiveAttempts()).length, 1);
  });
});

describe("confirmedLivePayments", () => {
  async function withResolution(outcome: "confirmed" | "failed" | "unknown", overrides: Record<string, unknown> = {}) {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine());
    await audit.append(resultLine("unknown"));
    await audit.append({
      type: "resolution",
      at: "2026-09-07T11:00:00.000Z",
      runId: "run-2",
      mode: "live",
      invoiceId: "inv-001",
      to: BUILDER,
      amountUsdc: 1.5,
      idempotencyKey: KEY,
      outcome,
      transactionId: outcome === "unknown" ? null : TX_ID,
      txHash: outcome === "confirmed" ? HASH : null,
      source: "circle transaction list",
      detail: "test",
      ...overrides,
    } as AuditEntry);
    return audit;
  }

  it("reports a confirmed payment with no time window at all", async () => {
    const audit = await withResolution("confirmed");
    assert.deepEqual(await audit.confirmedLivePayments(), [
      { invoiceId: "inv-001", to: BUILDER, amountUsdc: 1.5, at: "2026-09-07T11:00:00.000Z", transactionId: TX_ID },
    ]);
  });

  it("reports nothing for a failed or unresolved reconcile", async () => {
    for (const outcome of ["failed", "unknown"] as const) {
      const audit = await withResolution(outcome);
      assert.deepEqual(await audit.confirmedLivePayments(), [], outcome);
    }
  });

  it("reports nothing on a log that predates resume", async () => {
    const audit = createAuditLog(await tempAuditPath());
    await audit.append(intentLine());
    await audit.append(resultLine("unknown"));
    assert.deepEqual(await audit.confirmedLivePayments(), []);
  });
});

describe("runResume", () => {
  async function setup(transactions: Record<string, unknown>[], seed: AuditEntry[]) {
    const path = await tempAuditPath();
    const audit = createAuditLog(path);
    for (const entry of seed) await audit.append(entry);
    const reconciler = stubReconciler(...transactions);
    const printed = collectOut();
    const deps = {
      audit,
      reconciler,
      out: printed.out,
      now: () => new Date("2026-09-07T12:00:00.000Z"),
      runId: "resume-1",
      agentWallet: AGENT,
      circleBin: "circle",
      auditPath: path,
    };
    return { path, audit, reconciler, printed, deps };
  }

  it("confirms an unresolved attempt and records it without touching the earlier lines", async () => {
    const { path, reconciler, printed, deps } = await setup(
      [transaction()],
      [intentLine(), resultLine("unknown")],
    );
    const before = await readLines(path);

    const run = await runResume(deps);
    assert.deepEqual(run, { checked: 1, confirmed: 1, failed: 0, stillUnknown: 0 });
    assert.equal(reconciler.calls, 1);

    const after = await readLines(path);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after.slice(0, before.length), before);

    const resolution = after[after.length - 1];
    assert.equal(resolution?.type, "resolution");
    assert.equal(resolution?.outcome, "confirmed");
    assert.equal(resolution?.idempotencyKey, KEY);
    assert.equal(resolution?.transactionId, TX_ID);
    assert.equal(resolution?.txHash, HASH);
    assert.equal(resolution?.source, "circle transaction list");
    assert.equal(resolution?.at, "2026-09-07T12:00:00.000Z");
    assert.match(printed.text(), /confirmed/);
    assert.match(printed.text(), /do not send it again/);
  });

  it("records a terminal failure as failed", async () => {
    const { path, deps } = await setup([transaction({ state: "FAILED" })], [intentLine(), resultLine("unknown")]);
    const run = await runResume(deps);
    assert.deepEqual(run, { checked: 1, confirmed: 0, failed: 1, stillUnknown: 0 });
    const last = (await readLines(path)).at(-1);
    assert.equal(last?.outcome, "failed");
    assert.equal(last?.txHash, null);
  });

  it("keeps an unresolved attempt unresolved and says why", async () => {
    const { path, printed, deps } = await setup([], [intentLine(), resultLine("unknown")]);
    const run = await runResume(deps);
    assert.deepEqual(run, { checked: 1, confirmed: 0, failed: 0, stillUnknown: 1 });
    const last = (await readLines(path)).at(-1);
    assert.equal(last?.outcome, "unknown");
    assert.equal(last?.transactionId, null);
    assert.match(printed.text(), /still unresolved/);
  });

  it("running it twice settles nothing again and spawns nothing", async () => {
    const { path, reconciler, deps } = await setup([transaction()], [intentLine(), resultLine("unknown")]);
    await runResume(deps);
    const afterFirst = await readLines(path);
    assert.equal(reconciler.calls, 1);

    const second = await runResume(deps);
    assert.deepEqual(second, { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0 });
    // No second listing and no second resolution line.
    assert.equal(reconciler.calls, 1);
    assert.deepEqual(await readLines(path), afterFirst);
  });

  it("asks for one listing however many attempts are open", async () => {
    const other = {
      ...intentLine({ invoiceId: "inv-002", to: OTHER, idempotencyKey: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }),
    } as AuditEntry;
    const { reconciler, deps } = await setup([transaction()], [intentLine(), other]);
    const run = await runResume(deps);
    assert.equal(reconciler.calls, 1);
    assert.equal(run.checked, 2);
    assert.equal(run.confirmed, 1);
    assert.equal(run.stillUnknown, 1);
  });

  it("does nothing at all on a log with no unresolved attempts", async () => {
    const { path, reconciler, printed, deps } = await setup(
      [transaction()],
      [intentLine(), resultLine("submitted", { txHash: HASH, transactionId: TX_ID, exitCode: 0, errorCode: null, detail: null })],
    );
    const before = await readLines(path);
    const run = await runResume(deps);
    assert.deepEqual(run, { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0 });
    assert.equal(reconciler.calls, 0);
    assert.deepEqual(await readLines(path), before);
    assert.match(printed.text(), /every live attempt in this log has a terminal answer/);
  });
});
