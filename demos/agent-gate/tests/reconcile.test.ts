/**
 * The pure half of the reconcile. Every case here runs against a recorded
 * listing, so the contract is checked without a CLI, a session or a wallet.
 *
 * The rule under test is the conservative one: only a single terminal
 * candidate resolves an attempt. Absence, ambiguity, a state still moving
 * and anything unparsable all stay unknown, because the expensive mistake
 * is calling a payment settled when it is not.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { CliOutcome } from "../src/circle";
import { interpretReconcileOutput } from "../src/reconcile";
import type { UnresolvedAttempt } from "../src/reconcile";
import { AGENT, BUILDER, OTHER } from "./helpers";

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** The attempt the recorded listing settles. */
const ATTEMPT: UnresolvedAttempt = {
  invoiceId: "inv-001",
  to: BUILDER,
  amountUsdc: 1.5,
  idempotencyKey: "3f2a9c1e-7b4d-4c8a-9f21-5e6d7c8b9a01",
  intentAt: "2026-09-07T10:00:00.000Z",
};

function answer(stdout: string, exitCode = 0): CliOutcome {
  return { exitCode, signal: null, stdout, stderr: "", timedOut: false };
}

/** One transaction with the verified field set; overrides replace fields. */
function transaction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "7f1e2d3c-4b5a-4f60-9e8d-1c2b3a4f5e6d",
    state: "COMPLETE",
    blockchain: "ARC-TESTNET",
    txHash: `0x${"ab".repeat(32)}`,
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

function listing(...transactions: Record<string, unknown>[]): CliOutcome {
  return answer(JSON.stringify({ data: { transactions } }));
}

describe("interpretReconcileOutput: the recorded listing", () => {
  it("confirms the attempt from the redacted fixture", async () => {
    const stdout = await readFile(resolve(FIXTURES, "transaction-list.confirmed.json"), "utf8");
    const result = interpretReconcileOutput(ATTEMPT, AGENT, answer(stdout));
    assert.equal(result.outcome, "confirmed");
    if (result.outcome !== "confirmed") return;
    assert.equal(result.transactionId, "7f1e2d3c-4b5a-4f60-9e8d-1c2b3a4f5e6d");
    assert.equal(result.txHash, `0x${"ab".repeat(32)}`);
    assert.equal(result.chainState, "COMPLETE");
  });

  it("ignores the older transfer in the same fixture, which is to another recipient before the intent", async () => {
    const stdout = await readFile(resolve(FIXTURES, "transaction-list.confirmed.json"), "utf8");
    // Same wallet, same listing, but this attempt is the 0.75 one, which
    // was created before its intent would have been written.
    const result = interpretReconcileOutput(
      { ...ATTEMPT, to: OTHER, amountUsdc: 0.75 },
      AGENT,
      answer(stdout),
    );
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /no outbound transfer in the listing matches/);
  });
});

describe("interpretReconcileOutput: terminal states", () => {
  it("resolves CONFIRMED as well as COMPLETE", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ state: "CONFIRMED" })));
    assert.equal(result.outcome, "confirmed");
  });

  it("resolves a failed transaction to failed with nothing moved", () => {
    for (const state of ["FAILED", "CANCELLED", "DENIED"]) {
      const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ state })));
      assert.equal(result.outcome, "failed", state);
      if (result.outcome !== "failed") continue;
      assert.equal(result.chainState, state);
      assert.match(result.detail, /nothing moved/);
    }
  });

  it("leaves a pending transaction unknown rather than guessing either way", () => {
    for (const state of ["INITIATED", "QUEUED", "SENT", "CLEARED", "STUCK"]) {
      const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ state })));
      assert.equal(result.outcome, "unknown", state);
      assert.match(result.detail, /not a terminal state/);
    }
  });

  it("leaves a state it does not recognise unknown", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ state: "SOMETHING_NEW" })));
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /SOMETHING_NEW/);
  });

  it("will not confirm a match that carries no id", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ id: null })));
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /carries no id/);
  });

  it("confirms without a hash rather than discarding the match", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ txHash: null })));
    assert.equal(result.outcome, "confirmed");
    if (result.outcome !== "confirmed") return;
    assert.equal(result.txHash, null);
  });
});

describe("interpretReconcileOutput: what does not match", () => {
  it("stays unknown on an empty list, because an absence proves nothing", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing());
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /nothing is resolved on an absence/);
  });

  it("stays unknown when the recipient is someone else", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ destinationAddress: OTHER })));
    assert.equal(result.outcome, "unknown");
  });

  it("stays unknown when the amount is not the one approved", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ amounts: ["1.6"] })));
    assert.equal(result.outcome, "unknown");
  });

  it("stays unknown for a transfer created before the intent was written", () => {
    const result = interpretReconcileOutput(
      ATTEMPT,
      AGENT,
      listing(transaction({ createDate: "2026-09-07T09:59:59.999Z" })),
    );
    assert.equal(result.outcome, "unknown");
  });

  it("accepts a transfer created at the very moment of the intent", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ createDate: ATTEMPT.intentAt })));
    assert.equal(result.outcome, "confirmed");
  });

  it("stays unknown for an inbound transfer or another operation", () => {
    for (const override of [{ transactionType: "INBOUND" }, { operation: "CONTRACT_EXECUTION" }]) {
      const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction(override)));
      assert.equal(result.outcome, "unknown", JSON.stringify(override));
    }
  });

  it("stays unknown when the paying wallet is not this agent wallet", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ sourceAddress: OTHER })));
    assert.equal(result.outcome, "unknown");
  });

  it("stays unknown on another chain", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, listing(transaction({ blockchain: "ARC" })));
    assert.equal(result.outcome, "unknown");
  });

  it("matches the addresses case-insensitively", () => {
    const result = interpretReconcileOutput(
      ATTEMPT,
      AGENT.toUpperCase().replace("0X", "0x"),
      listing(transaction({ destinationAddress: BUILDER.toUpperCase().replace("0X", "0x") })),
    );
    assert.equal(result.outcome, "confirmed");
  });
});

describe("interpretReconcileOutput: never resolves an ambiguous match", () => {
  it("stays unknown when two transfers look like the same payment", () => {
    const result = interpretReconcileOutput(
      ATTEMPT,
      AGENT,
      listing(transaction(), transaction({ id: "11111111-2222-4333-8444-555555555555" })),
    );
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /2 outbound transfers match/);
    assert.match(result.detail, /no idempotency key/);
  });

  it("counts a pending duplicate as a candidate instead of picking the confirmed one", () => {
    const result = interpretReconcileOutput(
      ATTEMPT,
      AGENT,
      listing(transaction(), transaction({ id: "11111111-2222-4333-8444-555555555555", state: "SENT" })),
    );
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /2 outbound transfers match/);
  });
});

describe("interpretReconcileOutput: answers that are not a listing", () => {
  it("stays unknown on malformed output", () => {
    for (const stdout of ["", "not json", "[]", "{", '{"data":{"transactions":"none"}}', '{"data":{}}']) {
      const result = interpretReconcileOutput(ATTEMPT, AGENT, answer(stdout));
      assert.equal(result.outcome, "unknown", JSON.stringify(stdout));
    }
  });

  it("stays unknown when the listing itself reported an error", () => {
    const stdout = JSON.stringify({ error: { code: "AUTH_REQUIRED", message: "no active session" } });
    const result = interpretReconcileOutput(ATTEMPT, AGENT, answer(stdout, 1));
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /no active session/);
  });

  it("stays unknown when the CLI could not start, timed out or was stopped", () => {
    const base = { exitCode: null, signal: null, stdout: "", stderr: "", timedOut: false };
    const cases: CliOutcome[] = [
      { ...base, spawnError: "ENOENT" },
      { ...base, timedOut: true },
      { ...base, processError: "EPIPE" },
      { ...base, signal: "SIGTERM" },
    ];
    for (const outcome of cases) {
      assert.equal(interpretReconcileOutput(ATTEMPT, AGENT, outcome).outcome, "unknown");
    }
  });

  it("stays unknown on a non-zero exit with no envelope", () => {
    const result = interpretReconcileOutput(ATTEMPT, AGENT, answer("{}", 2));
    assert.equal(result.outcome, "unknown");
    assert.match(result.detail, /exit 2/);
  });
});
