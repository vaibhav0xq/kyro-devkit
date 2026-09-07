import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DUPLICATE_WINDOW_MS,
  cappedAlternative,
  decide,
  isValidUsdcAmount,
  prescreen,
} from "../src/policy";
import type { Caps, PolicyInput } from "../src/types";
import {
  AGENT,
  BUILDER,
  FIXED_NOW,
  FRESH,
  OTHER,
  baselinePayload,
  decisionPayload,
  failedAssessment,
  okAssessment,
  proposal,
} from "./helpers";

const caps: Caps = { maxUsdcPerTransfer: 5, maxUsdcPerRun: 10 };

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    proposal: proposal(),
    assessment: okAssessment(),
    caps,
    spentUsdcThisRun: 0,
    recentPayments: [],
    now: FIXED_NOW,
    ...overrides,
  };
}

function codes(result: ReturnType<typeof decide>): string[] {
  return result.conditions.map((condition) => condition.code);
}

describe("prescreen", () => {
  it("passes a well-formed proposal", () => {
    assert.deepEqual(prescreen(proposal(), {}), []);
  });

  it("refuses a chain other than ARC-TESTNET", () => {
    const conditions = prescreen(proposal({ chain: "ARC-MAINNET" }), {});
    assert.deepEqual(
      conditions.map((c) => c.code),
      ["CHAIN_NOT_ALLOWED"],
    );
  });

  it("refuses malformed recipients", () => {
    for (const to of ["", "bb30481982786ea53fe1856e0745eec814d83252", "0x1234", `0x${"g".repeat(40)}`]) {
      const conditions = prescreen(proposal({ to }), {});
      assert.deepEqual(
        conditions.map((c) => c.code),
        ["RECIPIENT_INVALID"],
        `recipient ${JSON.stringify(to)}`,
      );
    }
  });

  it("refuses paying the agent wallet itself, case-insensitively", () => {
    const conditions = prescreen(proposal({ to: AGENT.toUpperCase().replace("0X", "0x") }), { agentWallet: AGENT });
    assert.deepEqual(
      conditions.map((c) => c.code),
      ["RECIPIENT_IS_AGENT_WALLET"],
    );
  });

  it("refuses recipients outside the task list when one is supplied", () => {
    const allowed = new Set([BUILDER]);
    assert.deepEqual(prescreen(proposal({ to: BUILDER }), { allowedRecipients: allowed }), []);
    assert.deepEqual(
      prescreen(proposal({ to: OTHER }), { allowedRecipients: allowed }).map((c) => c.code),
      ["RECIPIENT_NOT_IN_TASK_LIST"],
    );
  });

  it("refuses invalid amounts", () => {
    for (const amountUsdc of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1.2345678]) {
      const conditions = prescreen(proposal({ amountUsdc }), {});
      assert.deepEqual(
        conditions.map((c) => c.code),
        ["AMOUNT_INVALID"],
        `amount ${String(amountUsdc)}`,
      );
    }
  });

  it("reports every failed check, not only the first", () => {
    const conditions = prescreen(proposal({ chain: "X", to: "nope", amountUsdc: 0 }), {});
    assert.deepEqual(
      conditions.map((c) => c.code),
      ["CHAIN_NOT_ALLOWED", "RECIPIENT_INVALID", "AMOUNT_INVALID"],
    );
  });
});

describe("isValidUsdcAmount", () => {
  it("accepts up to six decimals", () => {
    assert.equal(isValidUsdcAmount(0.000001), true);
    assert.equal(isValidUsdcAmount(1.5), true);
    assert.equal(isValidUsdcAmount(1200), true);
  });

  it("rejects more than six decimals and non-numbers", () => {
    assert.equal(isValidUsdcAmount(0.0000001), false);
    assert.equal(isValidUsdcAmount("1.5"), false);
    assert.equal(isValidUsdcAmount(null), false);
  });
});

describe("decide", () => {
  it("proceeds on allow with committed evidence inside every limit", () => {
    const result = decide(input());
    assert.equal(result.action, "proceed");
    assert.deepEqual(result.conditions, []);
    assert.equal(result.cappedAmountUsdc, undefined);
  });

  it("refuses on a pre-screen failure without reading the assessment", () => {
    const result = decide(input({ proposal: proposal({ to: "bad" }), assessment: undefined }));
    assert.equal(result.action, "refuse");
    assert.deepEqual(codes(result), ["RECIPIENT_INVALID"]);
  });

  it("refuses when Kyro gave no usable answer", () => {
    for (const failure of ["timeout", "rate_limit", "server_error", "network", "bad_response", "api_error", "unexpected"] as const) {
      const result = decide(input({ assessment: failedAssessment(failure) }));
      assert.equal(result.action, "refuse", failure);
      assert.deepEqual(codes(result), ["KYRO_UNAVAILABLE"], failure);
    }
  });

  it("refuses when no assessment exists at all", () => {
    const result = decide(input({ assessment: undefined }));
    assert.equal(result.action, "refuse");
    assert.deepEqual(codes(result), ["KYRO_UNAVAILABLE"]);
  });

  it("refuses a block verdict even when everything else is fine", () => {
    const result = decide(input({ assessment: okAssessment(decisionPayload({ decision: "block" })) }));
    assert.equal(result.action, "refuse");
    assert.deepEqual(codes(result), ["VERDICT_BLOCK"]);
  });

  it("holds a caution verdict", () => {
    const result = decide(input({ assessment: okAssessment(decisionPayload({ decision: "caution" })) }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["VERDICT_CAUTION"]);
    assert.equal(result.cappedAmountUsdc, 1.5);
  });

  it("holds a baseline (never indexed) answer with both caution and baseline conditions", () => {
    const result = decide(input({ proposal: proposal({ to: FRESH, amountUsdc: 2 }), assessment: okAssessment(baselinePayload(FRESH)) }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["VERDICT_CAUTION", "BASELINE_ONLY"]);
    assert.equal(result.cappedAmountUsdc, 2);
  });

  it("holds an allow verdict whose freshness is not cached", () => {
    const decision = decisionPayload({
      freshness: { cacheStatus: "stale", lastIndexedAt: null, refreshInProgress: true, refreshRecommended: true },
    });
    const result = decide(input({ assessment: okAssessment(decision) }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["BASELINE_ONLY"]);
  });

  it("holds an amount above the advisory limit on an allow verdict", () => {
    const decision = decisionPayload({ recommendedLimit: { amountUsdc: 1, currency: "USDC", basis: "allow" } });
    const result = decide(input({ assessment: okAssessment(decision), proposal: proposal({ amountUsdc: 1.5 }) }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["OVER_ADVISORY_LIMIT"]);
    assert.equal(result.cappedAmountUsdc, 1);
  });

  it("holds an amount above the per-transfer cap and offers the cap", () => {
    const result = decide(input({ proposal: proposal({ amountUsdc: 7 }) }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["OVER_TRANSFER_CAP"]);
    assert.equal(result.cappedAmountUsdc, 5);
  });

  it("holds the 1200 USDC scene with every limit condition and offers the cap", () => {
    const result = decide(input({ proposal: proposal({ amountUsdc: 1200 }), spentUsdcThisRun: 1.5 }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["OVER_ADVISORY_LIMIT", "OVER_TRANSFER_CAP", "RUN_BUDGET_EXCEEDED"]);
    assert.equal(result.cappedAmountUsdc, 5);
  });

  it("holds when the run budget would be exceeded and offers what is left", () => {
    const result = decide(input({ proposal: proposal({ amountUsdc: 4 }), spentUsdcThisRun: 8 }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["RUN_BUDGET_EXCEEDED"]);
    assert.equal(result.cappedAmountUsdc, 2);
  });

  it("offers no capped alternative once the run budget is spent", () => {
    const result = decide(input({ proposal: proposal({ amountUsdc: 1 }), spentUsdcThisRun: 10 }));
    assert.equal(result.action, "hold");
    assert.equal(result.cappedAmountUsdc, undefined);
  });

  it("holds an identical payment inside the duplicate window", () => {
    const recent = [{ to: BUILDER.toUpperCase().replace("0X", "0x"), amountUsdc: 1.5, at: new Date(FIXED_NOW.getTime() - 60_000).toISOString() }];
    const result = decide(input({ recentPayments: recent }));
    assert.equal(result.action, "hold");
    assert.deepEqual(codes(result), ["DUPLICATE_RECENT"]);
  });

  it("ignores payments outside the window, with another amount or to another recipient", () => {
    const recent = [
      { to: BUILDER, amountUsdc: 1.5, at: new Date(FIXED_NOW.getTime() - DUPLICATE_WINDOW_MS - 1).toISOString() },
      { to: BUILDER, amountUsdc: 1.4, at: new Date(FIXED_NOW.getTime() - 60_000).toISOString() },
      { to: OTHER, amountUsdc: 1.5, at: new Date(FIXED_NOW.getTime() - 60_000).toISOString() },
    ];
    const result = decide(input({ recentPayments: recent }));
    assert.equal(result.action, "proceed");
  });

  it("refuse wins over hold when both apply", () => {
    const decision = decisionPayload({
      decision: "block",
      freshness: { cacheStatus: "indexing_required", lastIndexedAt: null, refreshInProgress: false, refreshRecommended: true },
    });
    const result = decide(input({ assessment: okAssessment(decision), proposal: proposal({ amountUsdc: 1200 }) }));
    assert.equal(result.action, "refuse");
    assert.deepEqual(codes(result), ["VERDICT_BLOCK", "BASELINE_ONLY", "OVER_ADVISORY_LIMIT", "OVER_TRANSFER_CAP", "RUN_BUDGET_EXCEEDED"]);
    assert.equal(result.cappedAmountUsdc, undefined);
  });
});

describe("cappedAlternative", () => {
  it("takes the smallest of the request, advisory limit, transfer cap and remaining budget", () => {
    assert.equal(cappedAlternative({ requestedUsdc: 1200, advisoryLimitUsdc: 1000, caps, spentUsdcThisRun: 1.5 }), 5);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 1000, caps, spentUsdcThisRun: 0 }), 3);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 0.5, caps, spentUsdcThisRun: 0 }), 0.5);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 1000, caps, spentUsdcThisRun: 9 }), 1);
  });

  it("returns undefined when nothing positive is left", () => {
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 0, caps, spentUsdcThisRun: 0 }), undefined);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 1000, caps, spentUsdcThisRun: 10 }), undefined);
  });

  it("floors to six decimals and never rounds up past the limiting value", () => {
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 0.1234567, caps, spentUsdcThisRun: 0 }), 0.123456);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 0.000000999999, caps, spentUsdcThisRun: 0 }), undefined);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 0.3, caps, spentUsdcThisRun: 0 }), 0.3);
    assert.equal(cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: 1000, caps, spentUsdcThisRun: 7.1 }), 2.9);
    for (const limit of [0.1, 0.7, 1.1, 2.675, 4.999999, 0.0000015]) {
      const capped = cappedAlternative({ requestedUsdc: 3, advisoryLimitUsdc: limit, caps, spentUsdcThisRun: 0 });
      assert.ok(capped !== undefined && capped <= limit, `limit ${limit} gave ${String(capped)}`);
    }
  });
});
