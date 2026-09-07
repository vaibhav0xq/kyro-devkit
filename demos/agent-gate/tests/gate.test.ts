import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { createAuditLog } from "../src/audit";
import type { AuditEntry, AuditIntent, AuditResult } from "../src/audit";
import { FROM_PLACEHOLDER } from "../src/circle";
import { runGate } from "../src/gate";
import type { GateDeps } from "../src/gate";
import { createKyroGateway } from "../src/kyro";
import type { KyroGateway } from "../src/kyro";
import type { Caps, Proposal } from "../src/types";
import {
  AGENT,
  BUILDER,
  FIXED_NOW,
  FRESH,
  OTHER,
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
