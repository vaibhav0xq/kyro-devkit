import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createAuditLog } from "../src/audit";
import type { AuditEntry, AuditIntent, AuditResult } from "../src/audit";
import { FROM_PLACEHOLDER } from "../src/circle";
import { GateInterruptedError, runGate } from "../src/gate";
import type { GateDeps } from "../src/gate";
import { createKyroGateway } from "../src/kyro";
import type { KyroGateway } from "../src/kyro";
import type { Caps, Proposal } from "../src/types";
import {
  AGENT,
  BUILDER,
  CIRCLE_TX_ID,
  FIXED_NOW,
  FRESH,
  OTHER,
  TX_HASH,
  baselinePayload,
  collectOut,
  decisionPayload,
  errJson,
  hangingAnswer,
  mockFetch,
  okJson,
  proposal,
  recordingExecutor,
  scriptedPrompt,
  tempAuditPath,
} from "./helpers";

const caps: Caps = { maxUsdcPerTransfer: 5, maxUsdcPerRun: 10 };

interface Harness {
  deps: GateDeps;
  executor: ReturnType<typeof recordingExecutor>;
  out: ReturnType<typeof collectOut>;
  auditPath: string;
  calls: ReturnType<typeof mockFetch>["calls"];
}

async function harness(
  answers: Parameters<typeof mockFetch>,
  overrides: Partial<GateDeps> & { kyro?: KyroGateway } = {},
): Promise<Harness> {
  const { fetch, calls } = mockFetch(...answers);
  const kyro = overrides.kyro ?? createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, fetch });
  const executor = recordingExecutor();
  const out = collectOut();
  const auditPath = await tempAuditPath();
  let tick = 0;
  const deps: GateDeps = {
    kyro,
    executor,
    audit: createAuditLog(auditPath),
    out: out.out,
    now: () => new Date(FIXED_NOW.getTime() + tick++ * 1000),
    caps,
    mode: "dry-run",
    runId: "test-run",
    circleBin: "circle",
    ...overrides,
  };
  return { deps, executor, out, auditPath, calls };
}

async function auditEntries(path: string): Promise<AuditEntry[]> {
  const text = await readFile(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as AuditEntry);
}

function intents(entries: AuditEntry[]): AuditIntent[] {
  return entries.filter((entry): entry is AuditIntent => entry.type === "intent");
}

function results(entries: AuditEntry[]): AuditResult[] {
  return entries.filter((entry): entry is AuditResult => entry.type === "result");
}

const SCENES: Proposal[] = [
  proposal({ invoiceId: "inv-001", to: BUILDER, amountUsdc: 1.5 }),
  proposal({ invoiceId: "inv-002", to: FRESH, amountUsdc: 2 }),
  proposal({ invoiceId: "inv-003", to: BUILDER, amountUsdc: 1200 }),
];

describe("gate: the three scenes", () => {
  it("proceeds, holds, holds and prints the command only for the proceed", async () => {
    const h = await harness([okJson(decisionPayload()), okJson(baselinePayload(FRESH)), okJson(decisionPayload())]);
    const run = await runGate(h.deps, SCENES);

    assert.deepEqual(run.outcomes.map((o) => o.action), ["proceed", "hold", "hold"]);
    assert.equal(run.proceeded, 1);
    assert.equal(run.held, 2);
    assert.equal(run.refused, 0);
    assert.equal(run.unknown, 0);
    assert.equal(run.approvedUsdc, 1.5);
    assert.equal(h.calls.length, 3);

    assert.equal(h.executor.calls.length, 1);
    assert.deepEqual(h.executor.calls[0], { to: BUILDER, amountUsdc: 1.5, from: FROM_PLACEHOLDER });
    const text = h.out.text();
    assert.match(text, /dry-run, not executed: circle wallet transfer 0xbb30481982786ea53fe1856e0745eec814d83252 --amount 1.5 --address <AGENT_WALLET_ADDRESS> --chain ARC-TESTNET --output json/);
    assert.match(text, /verdict allow for payment/);
    assert.match(text, /verdict caution for payment/);
    assert.match(text, /BASELINE_ONLY/);
    assert.match(text, /OVER_ADVISORY_LIMIT/);
    assert.match(text, /OVER_TRANSFER_CAP/);
    assert.match(text, /RUN_BUDGET_EXCEEDED/);
    assert.match(text, /capped alternative 5 USDC would need a human/);
    assert.doesNotMatch(text, /SIMULATED/);

    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries).length, 3);
    assert.deepEqual(
      intents(entries).map((entry) => [entry.invoiceId, entry.action, entry.approvedUsdc, entry.verdict]),
      [
        ["inv-001", "proceed", 1.5, "allow"],
        ["inv-002", "hold", null, "caution"],
        ["inv-003", "hold", null, "allow"],
      ],
    );
    const written = results(entries);
    assert.equal(written.length, 1);
    assert.equal(written[0]?.state, "dry-run");
    assert.equal(written[0]?.mode, "dry-run");
    assert.equal(written[0]?.argv.join(" "), `wallet transfer ${BUILDER} --amount 1.5 --address ${FROM_PLACEHOLDER} --chain ARC-TESTNET --output json`);
  });

  it("uses the agent wallet as the payer when it is configured", async () => {
    const h = await harness([okJson(decisionPayload())], { agentWallet: AGENT });
    await runGate(h.deps, [SCENES[0] as Proposal]);
    assert.equal(h.executor.calls[0]?.from, AGENT);
    assert.match(h.out.text(), new RegExp(`--address ${AGENT}`));
  });
});

describe("gate: pre-screen refusals never reach Kyro", () => {
  it("does not call fetch or the executor for a malformed recipient", async () => {
    const h = await harness([]);
    const run = await runGate(h.deps, [proposal({ to: "0x1234" })]);
    assert.equal(run.refused, 1);
    assert.equal(h.calls.length, 0);
    assert.equal(h.executor.calls.length, 0);
    assert.match(h.out.text(), /not consulted, the proposal failed the pre-screen/);
    assert.match(h.out.text(), /RECIPIENT_INVALID/);
    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries)[0]?.action, "refuse");
    assert.deepEqual(intents(entries)[0]?.conditions, ["RECIPIENT_INVALID"]);
    assert.equal(results(entries).length, 0);
  });

  it("refuses another chain, the agent wallet and off-list recipients without a read", async () => {
    const h = await harness([], { agentWallet: AGENT, allowedRecipients: new Set([BUILDER, AGENT]) });
    const run = await runGate(h.deps, [
      proposal({ invoiceId: "a", chain: "ARC-MAINNET" }),
      proposal({ invoiceId: "b", to: AGENT }),
      proposal({ invoiceId: "c", to: OTHER }),
      proposal({ invoiceId: "d", amountUsdc: 0 }),
    ]);
    assert.equal(run.refused, 4);
    assert.equal(h.calls.length, 0);
    assert.deepEqual(
      run.outcomes.map((o) => o.policy.conditions.map((c) => c.code)),
      [["CHAIN_NOT_ALLOWED"], ["RECIPIENT_IS_AGENT_WALLET"], ["RECIPIENT_NOT_IN_TASK_LIST"], ["AMOUNT_INVALID"]],
    );
  });
});

describe("gate: Kyro failures fail closed", () => {
  it("refuses on timeout, rate limit, server error and bad response", async () => {
    const h = await harness([
      hangingAnswer(),
      errJson("RATE_LIMITED", "slow down", 429, { "retry-after": "30" }),
      errJson("INTERNAL", "down", 503),
      okJson({ nonsense: true }),
    ]);
    const run = await runGate(h.deps, [
      proposal({ invoiceId: "t" }),
      proposal({ invoiceId: "r" }),
      proposal({ invoiceId: "s" }),
      proposal({ invoiceId: "b" }),
    ]);
    assert.equal(run.refused, 4);
    assert.equal(h.executor.calls.length, 0);
    assert.deepEqual(
      run.outcomes.map((o) => (o.assessment && !o.assessment.ok ? o.assessment.failure : "ok")),
      ["timeout", "rate_limit", "server_error", "bad_response"],
    );
    for (const outcome of run.outcomes) {
      assert.deepEqual(
        outcome.policy.conditions.map((c) => c.code),
        ["KYRO_UNAVAILABLE"],
      );
    }
    const text = h.out.text();
    assert.match(text, /no usable answer, timeout/);
    assert.match(text, /no usable answer, rate limit .*retry after 30 s/);
    assert.match(text, /no usable answer, server error/);
    assert.match(text, /no usable answer, bad response/);
    const entries = await auditEntries(h.auditPath);
    assert.deepEqual(
      intents(entries).map((entry) => entry.kyroFailure),
      ["timeout", "rate_limit", "server_error", "bad_response"],
    );
  });

  it("labels simulated failures and makes no real read", async () => {
    for (const simulate of ["timeout", "rate_limit", "server_error"] as const) {
      const kyro = createKyroGateway({ timeoutMs: 40, minIntervalMs: 1500, simulate });
      const h = await harness([okJson(decisionPayload())], { kyro });
      const run = await runGate(h.deps, SCENES);
      assert.equal(run.refused, 3, simulate);
      assert.equal(kyro.readsMade, 0, simulate);
      assert.equal(h.calls.length, 0, simulate);
      assert.equal(h.executor.calls.length, 0, simulate);
      assert.match(h.out.text(), /\[SIMULATED\]/);
      const entries = await auditEntries(h.auditPath);
      assert.ok(intents(entries).every((entry) => entry.simulated && entry.action === "refuse"), simulate);
    }
  });
});

describe("gate: run budget and duplicates", () => {
  it("accumulates approved amounts across the run", async () => {
    const h = await harness([okJson(decisionPayload()), okJson(decisionPayload()), okJson(decisionPayload())]);
    const run = await runGate(h.deps, [
      proposal({ invoiceId: "a", amountUsdc: 4 }),
      proposal({ invoiceId: "b", amountUsdc: 4.5 }),
      proposal({ invoiceId: "c", amountUsdc: 3 }),
    ]);
    assert.deepEqual(run.outcomes.map((o) => o.action), ["proceed", "proceed", "hold"]);
    assert.deepEqual(run.outcomes[2]?.policy.conditions.map((c) => c.code), ["RUN_BUDGET_EXCEEDED"]);
    assert.equal(run.outcomes[2]?.policy.cappedAmountUsdc, 1.5);
    assert.equal(run.approvedUsdc, 8.5);
  });

  it("holds an identical payment repeated inside one run", async () => {
    const h = await harness([okJson(decisionPayload()), okJson(decisionPayload())]);
    const run = await runGate(h.deps, [proposal({ invoiceId: "a" }), proposal({ invoiceId: "b" })]);
    assert.deepEqual(run.outcomes.map((o) => o.action), ["proceed", "hold"]);
    assert.deepEqual(run.outcomes[1]?.policy.conditions.map((c) => c.code), ["DUPLICATE_RECENT"]);
  });

  it("counts earlier live results from the audit log, never dry-run ones", async () => {
    const at = new Date(FIXED_NOW.getTime() - 60_000).toISOString();
    const line = (mode: "dry-run" | "live", state: string): string =>
      JSON.stringify({
        type: "result",
        at,
        runId: "earlier",
        mode,
        invoiceId: "inv-001",
        to: BUILDER,
        amountUsdc: 1.5,
        state,
        argv: [],
        txHash: null,
        exitCode: null,
        detail: null,
      });

    const dry = await harness([okJson(decisionPayload())]);
    await writeFile(dry.auditPath, `${line("dry-run", "dry-run")}\n`);
    const dryRun = await runGate(dry.deps, [proposal()]);
    assert.equal(dryRun.outcomes[0]?.action, "proceed");

    const live = await harness([okJson(decisionPayload())]);
    await writeFile(live.auditPath, `${line("live", "submitted")}\nnot json at all\n`);
    const liveRun = await runGate(live.deps, [proposal()]);
    assert.equal(liveRun.outcomes[0]?.action, "hold");
    assert.deepEqual(liveRun.outcomes[0]?.policy.conditions.map((c) => c.code), ["DUPLICATE_RECENT"]);
  });
});

describe("gate: human approval on a hold", () => {
  it("keeps the hold and pays nothing when the human declines", async () => {
    const { prompt, questions } = scriptedPrompt(["n"]);
    const h = await harness([okJson(decisionPayload())], { prompt });
    const run = await runGate(h.deps, [proposal({ amountUsdc: 1200 })]);
    assert.equal(run.outcomes[0]?.action, "hold");
    assert.equal(run.outcomes[0]?.humanApproved, false);
    assert.equal(h.executor.calls.length, 0);
    assert.deepEqual(questions, [`approve 5 USDC to ${BUILDER} for inv-test? [y/N] `]);
    assert.match(h.out.text(), /declined, nothing is paid/);
    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries)[0]?.action, "hold");
    assert.equal(intents(entries)[0]?.humanApproved, false);
    assert.equal(results(entries).length, 0);
  });

  it("proceeds with the capped amount when the human approves", async () => {
    const { prompt } = scriptedPrompt(["y"]);
    const h = await harness([okJson(decisionPayload())], { prompt });
    const run = await runGate(h.deps, [proposal({ amountUsdc: 1200 })]);
    assert.equal(run.outcomes[0]?.action, "proceed");
    assert.equal(run.outcomes[0]?.humanApproved, true);
    assert.equal(run.outcomes[0]?.approvedAmountUsdc, 5);
    assert.deepEqual(h.executor.calls, [{ to: BUILDER, amountUsdc: 5, from: FROM_PLACEHOLDER }]);
    assert.equal(run.approvedUsdc, 5);
    assert.match(h.out.text(), /--amount 5 --address/);
    assert.match(h.out.text(), /proceeded after human approval, dry-run so nothing was submitted/);
    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries)[0]?.action, "proceed");
    assert.equal(intents(entries)[0]?.approvedUsdc, 5);
    assert.equal(intents(entries)[0]?.humanApproved, true);
    assert.equal(results(entries)[0]?.amountUsdc, 5);
  });

  it("never prompts on a refuse", async () => {
    const { prompt, questions } = scriptedPrompt([]);
    const h = await harness([okJson(decisionPayload({ decision: "block" }))], { prompt });
    const run = await runGate(h.deps, [proposal({ invoiceId: "blocked", amountUsdc: 1200 })]);
    assert.equal(run.outcomes[0]?.action, "refuse");
    assert.equal(questions.length, 0);
    assert.equal(h.executor.calls.length, 0);
  });

  it("never prompts when the run budget leaves nothing to approve", async () => {
    const { prompt, questions } = scriptedPrompt([]);
    const h = await harness([okJson(decisionPayload()), okJson(decisionPayload())], {
      prompt,
      caps: { maxUsdcPerTransfer: 5, maxUsdcPerRun: 5 },
    });
    const run = await runGate(h.deps, [proposal({ invoiceId: "a", amountUsdc: 5 }), proposal({ invoiceId: "b", amountUsdc: 1 })]);
    assert.deepEqual(run.outcomes.map((o) => o.action), ["proceed", "hold"]);
    assert.equal(run.outcomes[1]?.policy.cappedAmountUsdc, undefined);
    assert.equal(questions.length, 0);
    assert.match(h.out.text(), /no capped alternative is available/);
  });
});

/**
 * Live mode with a recording executor standing in for the Circle CLI. The
 * executor answers with canned results, so the gate's own live behaviour
 * (key handling, audit lines, output, counts) is checked without a session.
 */
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY_A = "3f2a9c1e-7b4d-4e58-9a0f-2c6d8e1b5a73";
const RECONCILE = `circle transaction list --address ${AGENT} --chain ARC-TESTNET --operation transfer --tx-type outbound --output json`;

type LiveAnswer = "submitted" | "failed" | "unknown";

function liveResult(answer: LiveAnswer): Parameters<typeof recordingExecutor>[0] {
  return (request, argv) => {
    const idempotencyKey = request.idempotencyKey ?? null;
    if (answer === "submitted") {
      return { state: "submitted", argv, txHash: TX_HASH, chainState: "CONFIRMED", transactionId: CIRCLE_TX_ID, idempotencyKey };
    }
    if (answer === "failed") {
      return {
        state: "failed",
        argv,
        exitCode: 1,
        errorCode: "AUTH_REQUIRED",
        detail: "the Circle CLI stopped before submitting: No agent session for testnet.",
        idempotencyKey,
      };
    }
    return { state: "unknown", argv, exitCode: 1, errorCode: "TIMEOUT", detail: "Transfer failed or timed out.", idempotencyKey };
  };
}

async function liveHarness(
  answer: LiveAnswer,
  answers: Parameters<typeof mockFetch>,
  overrides: Partial<GateDeps> = {},
): Promise<Harness> {
  const executor = recordingExecutor(liveResult(answer), "live");
  const h = await harness(answers, { executor, mode: "live", agentWallet: AGENT, circleTimeoutMs: 240_000, ...overrides });
  return { ...h, executor };
}

function priorLiveLines(state: "submitted" | "failed" | "unknown" | null, minutesAgo: number, key = KEY_A): string {
  const at = new Date(FIXED_NOW.getTime() - minutesAgo * 60_000).toISOString();
  const intent = JSON.stringify({
    type: "intent",
    at,
    runId: "earlier",
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
    idempotencyKey: key,
  });
  if (state === null) return `${intent}\n`;
  const result = JSON.stringify({
    type: "result",
    at: new Date(FIXED_NOW.getTime() - minutesAgo * 60_000 + 20_000).toISOString(),
    runId: "earlier",
    mode: "live",
    invoiceId: "inv-001",
    to: BUILDER,
    amountUsdc: 1.5,
    state,
    argv: [],
    txHash: state === "submitted" ? TX_HASH : null,
    exitCode: state === "submitted" ? 0 : 1,
    detail: state === "submitted" ? null : "Transfer failed or timed out.",
    transactionId: state === "submitted" ? CIRCLE_TX_ID : null,
    idempotencyKey: key,
    errorCode: state === "unknown" ? "TIMEOUT" : null,
  });
  return `${intent}\n${result}\n`;
}

describe("gate: live mode", () => {
  it("passes a fresh idempotency key through the intent line, the request and the argv", async () => {
    const h = await liveHarness("submitted", [okJson(decisionPayload())]);
    const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);

    assert.equal(run.proceeded, 1);
    assert.equal(run.failed, 0);
    assert.equal(run.unknown, 0);
    assert.equal(h.executor.calls.length, 1);
    const key = h.executor.calls[0]?.idempotencyKey;
    assert.ok(key !== undefined && UUID_V4.test(key), `expected a UUID v4 key, got ${String(key)}`);
    assert.equal(h.executor.calls[0]?.from, AGENT);

    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries)[0]?.idempotencyKey, key);
    assert.equal(intents(entries)[0]?.mode, "live");
    const written = results(entries)[0];
    assert.equal(written?.state, "submitted");
    assert.equal(written?.idempotencyKey, key);
    assert.equal(written?.txHash, TX_HASH);
    assert.equal(written?.transactionId, CIRCLE_TX_ID);
    assert.equal(written?.errorCode, null);
    assert.equal(written?.argv.join(" "), `wallet transfer ${BUILDER} --amount 1.5 --address ${AGENT} --chain ARC-TESTNET --idempotency-key ${key} --output json`);

    const text = h.out.text();
    assert.match(text, new RegExp(`executor\\s+circle wallet transfer ${BUILDER} --amount 1.5 --address ${AGENT} --chain ARC-TESTNET --idempotency-key ${key} --output json`));
    assert.match(text, /waiting for the Circle CLI.*up to 240 s/);
    assert.match(text, new RegExp(`tx\\s+${TX_HASH} \\(CONFIRMED\\), https://testnet.arcscan.app/tx/${TX_HASH}`));
    assert.match(text, new RegExp(`circle transaction id ${CIRCLE_TX_ID}, idempotency key ${key}`));
    assert.match(text, /outcome\s+proceeded\n/);
    assert.doesNotMatch(text, /dry-run/);
    assert.doesNotMatch(text, /reusing key/);
  });

  it("uses a different key for every proceed in a run", async () => {
    const h = await liveHarness("submitted", [okJson(decisionPayload()), okJson(decisionPayload())]);
    await runGate(h.deps, [proposal({ invoiceId: "a", amountUsdc: 1 }), proposal({ invoiceId: "b", amountUsdc: 2 })]);
    const keys = h.executor.calls.map((call) => call.idempotencyKey);
    assert.equal(keys.length, 2);
    assert.notEqual(keys[0], keys[1]);
  });

  it("never attaches a key in dry-run", async () => {
    const h = await harness([okJson(decisionPayload())], { agentWallet: AGENT });
    await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
    assert.equal("idempotencyKey" in (h.executor.calls[0] ?? {}), false);
    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries)[0]?.idempotencyKey, null);
    assert.doesNotMatch(h.out.text(), /--idempotency-key/);
  });

  it("reports an unknown answer once, prints the reconcile steps and never spawns again", async () => {
    const h = await liveHarness("unknown", [okJson(decisionPayload())]);
    const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);

    assert.equal(run.outcomes[0]?.action, "proceed");
    assert.equal(run.outcomes[0]?.execution?.state, "unknown");
    assert.equal(run.proceeded, 0);
    assert.equal(run.failed, 0);
    assert.equal(run.unknown, 1);
    assert.equal(run.approvedUsdc, 1.5);
    assert.equal(h.executor.calls.length, 1);
    assert.equal(h.calls.length, 1);

    const key = h.executor.calls[0]?.idempotencyKey ?? "";
    const text = h.out.text();
    assert.match(text, /tx\s+unknown \(TIMEOUT, exit 1\): Transfer failed or timed out\./);
    assert.match(text, /may still be in flight; reconcile before anything else/);
    assert.ok(text.includes(RECONCILE), `expected the reconcile command in:\n${text}`);
    assert.match(text, new RegExp(`match destinationAddress ${BUILDER}, amounts \\["1.5"\\] and createDate after 2026-09-07T10:00:0\\dZ?`));
    assert.match(text, new RegExp(`https://testnet.arcscan.app/address/${AGENT}`));
    assert.match(text, new RegExp(`a later run of inv-001 is held for 10 minutes and then reuses idempotency key ${key}`));
    assert.match(text, /outcome\s+unknown, a transfer may have been submitted/);

    const written = results(await auditEntries(h.auditPath))[0];
    assert.equal(written?.state, "unknown");
    assert.equal(written?.errorCode, "TIMEOUT");
    assert.equal(written?.idempotencyKey, key);
    assert.equal(written?.txHash, null);
  });

  it("reports a failed answer as nothing paid and counts it separately", async () => {
    const h = await liveHarness("failed", [okJson(decisionPayload())]);
    const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
    assert.equal(run.proceeded, 0);
    assert.equal(run.failed, 1);
    assert.equal(run.unknown, 0);
    assert.equal(h.executor.calls.length, 1);
    const text = h.out.text();
    assert.match(text, /tx\s+failed \(AUTH_REQUIRED, exit 1\): the Circle CLI stopped before submitting/);
    assert.match(text, /nothing was paid; fix the cause and run again, the next attempt gets a new idempotency key/);
    assert.match(text, /outcome\s+failed, nothing was paid/);
    assert.doesNotMatch(text, /circle transaction list/);
    const written = results(await auditEntries(h.auditPath))[0];
    assert.equal(written?.state, "failed");
    assert.equal(written?.errorCode, "AUTH_REQUIRED");
  });

  it("holds a repeat of an unknown or interrupted live payment inside the duplicate window", async () => {
    for (const prior of [priorLiveLines("unknown", 3), priorLiveLines(null, 3), priorLiveLines("submitted", 3), priorLiveLines("failed", 3)]) {
      const h = await liveHarness("submitted", [okJson(decisionPayload())]);
      await writeFile(h.auditPath, prior);
      const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
      assert.equal(run.outcomes[0]?.action, "hold");
      assert.deepEqual(run.outcomes[0]?.policy.conditions.map((c) => c.code), ["DUPLICATE_RECENT"]);
      assert.equal(h.executor.calls.length, 0);
    }
  });

  it("reuses the earlier key only when the last live attempt ended unknown or never reported", async () => {
    for (const [prior, expectReuse, endedAt] of [
      [priorLiveLines("unknown", 30), true, "2026-09-07T09:30:20.000Z"],
      [priorLiveLines(null, 30), true, "2026-09-07T09:30:00.000Z"],
      [priorLiveLines("submitted", 30), false, ""],
      [priorLiveLines("failed", 30), false, ""],
    ] as const) {
      const h = await liveHarness("submitted", [okJson(decisionPayload())]);
      await writeFile(h.auditPath, prior);
      const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
      assert.equal(run.outcomes[0]?.action, "proceed");
      assert.equal(h.executor.calls.length, 1);
      const key = h.executor.calls[0]?.idempotencyKey;
      if (expectReuse) {
        assert.equal(key, KEY_A);
        assert.match(h.out.text(), new RegExp(`idempotency\\s+reusing key ${KEY_A} from the attempt at ${endedAt} that ended unknown`));
      } else {
        assert.notEqual(key, KEY_A);
        assert.ok(key !== undefined && UUID_V4.test(key));
        assert.doesNotMatch(h.out.text(), /reusing key/);
      }
      const entries = await auditEntries(h.auditPath);
      assert.equal(intents(entries).at(-1)?.idempotencyKey, key);
    }
  });

  it("starts the reconcile window at the intent that first sent a reused key", async () => {
    const h = await liveHarness("unknown", [okJson(decisionPayload())]);
    await writeFile(h.auditPath, priorLiveLines("unknown", 30));
    await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
    assert.equal(h.executor.calls[0]?.idempotencyKey, KEY_A);
    // The earlier intent was written at 09:30:00; this run's intent is at 10:00:00.
    assert.match(h.out.text(), /createDate after 2026-09-07T09:30:00\.000Z/);
    assert.doesNotMatch(h.out.text(), /createDate after 2026-09-07T10:00/);
  });

  it("surfaces an unknown as GateInterruptedError when the run dies before the result line is written", async () => {
    const h = await liveHarness("unknown", [okJson(decisionPayload())]);
    const audit = h.deps.audit;
    h.deps.audit = {
      ...audit,
      async append(entry) {
        if (entry.type === "result") throw new Error("disk full");
        await audit.append(entry);
      },
    };
    await assert.rejects(runGate(h.deps, [proposal({ invoiceId: "inv-001" })]), (error: unknown) => {
      assert.ok(error instanceof GateInterruptedError);
      assert.equal(error.unknown, 1);
      assert.match(error.message, /stopped after 1 live transfer ended unknown: disk full/);
      assert.ok(error.cause instanceof Error && error.cause.message === "disk full");
      return true;
    });
    assert.equal(h.executor.calls.length, 1);
    const entries = await auditEntries(h.auditPath);
    assert.equal(intents(entries).length, 1);
    assert.equal(results(entries).length, 0);
  });

  it("rethrows the original error when the run dies with no unknown transfer", async () => {
    const h = await liveHarness("submitted", [okJson(decisionPayload())]);
    const audit = h.deps.audit;
    h.deps.audit = {
      ...audit,
      async append(entry) {
        if (entry.type === "result") throw new Error("disk full");
        await audit.append(entry);
      },
    };
    await assert.rejects(runGate(h.deps, [proposal({ invoiceId: "inv-001" })]), (error: unknown) => {
      assert.ok(!(error instanceof GateInterruptedError));
      assert.ok(error instanceof Error && error.message === "disk full");
      return true;
    });
  });

  it("does not reuse a key for a different amount or recipient", async () => {
    const h = await liveHarness("submitted", [okJson(decisionPayload()), okJson(decisionPayload())]);
    await writeFile(h.auditPath, priorLiveLines("unknown", 30));
    await runGate(h.deps, [proposal({ invoiceId: "inv-001", amountUsdc: 2 }), proposal({ invoiceId: "inv-001", to: OTHER, amountUsdc: 1.5 })]);
    assert.equal(h.executor.calls.length, 1);
    assert.notEqual(h.executor.calls[0]?.idempotencyKey, KEY_A);
  });

  it("keeps a failed Kyro read a refuse in live mode with no spawn", async () => {
    const h = await liveHarness("submitted", [errJson("INTERNAL_ERROR", "boom", 500)]);
    const run = await runGate(h.deps, [proposal({ invoiceId: "inv-001" })]);
    assert.equal(run.outcomes[0]?.action, "refuse");
    assert.equal(h.executor.calls.length, 0);
    assert.equal(run.failed, 0);
    assert.equal(run.unknown, 0);
  });
});
