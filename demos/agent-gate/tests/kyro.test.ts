import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KYRO_BASE_URL, createKyroGateway, findDecisionDefect, findReceiptDefect, simulatedFetch } from "../src/kyro";
import {
  BUILDER,
  FRESH,
  OTHER,
  PAYLOAD_HASH,
  RECEIPT_ID,
  baselinePayload,
  createdJson,
  decisionPayload,
  errJson,
  hangingAnswer,
  mockFetch,
  okJson,
  receiptPayload,
} from "./helpers";

function gateway(fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createKyroGateway>[0]> = {}) {
  return createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, fetch, ...extra });
}

describe("kyro gateway", () => {
  it("asks for the payment use case anonymously and returns the decision", async () => {
    const { fetch, calls } = mockFetch(okJson(decisionPayload()));
    const kyro = gateway(fetch);
    const assessment = await kyro.assess(BUILDER);
    assert.equal(assessment.ok, true);
    if (!assessment.ok) return;
    assert.equal(assessment.decision.decision, "allow");
    assert.equal(assessment.simulated, false);
    assert.deepEqual(assessment.rateLimit, { limit: 20, remaining: 19 });
    assert.equal(kyro.readsMade, 1);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.url, `https://www.thekyro.co/api/v1/decision/${BUILDER}?useCase=payment`);
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-api-key"), null);
  });

  it("returns the baseline answer for a never-indexed wallet as ok", async () => {
    const { fetch } = mockFetch(okJson(baselinePayload(FRESH)));
    const assessment = await gateway(fetch).assess(FRESH);
    assert.equal(assessment.ok, true);
    if (!assessment.ok) return;
    assert.equal(assessment.decision.decision, "caution");
    assert.equal(assessment.decision.freshness.cacheStatus, "indexing_required");
  });

  it("maps a 429 to rate_limit with the retry hint", async () => {
    const { fetch } = mockFetch(
      errJson("RATE_LIMITED", "slow down", 429, { "retry-after": "30", "x-ratelimit-limit": "20", "x-ratelimit-remaining": "0" }),
    );
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok, false);
    if (assessment.ok) return;
    assert.equal(assessment.failure, "rate_limit");
    assert.equal(assessment.httpStatus, 429);
    assert.equal(assessment.retryAfterSeconds, 30);
    assert.deepEqual(assessment.rateLimit, { limit: 20, remaining: 0 });
  });

  it("maps 5xx to server_error and other 4xx to api_error", async () => {
    const { fetch } = mockFetch(errJson("INTERNAL", "down", 503), errJson("VALIDATION_ERROR", "bad wallet", 400));
    const kyro = gateway(fetch);
    const first = await kyro.assess(BUILDER);
    const second = await kyro.assess(BUILDER);
    assert.equal(first.ok === false && first.failure, "server_error");
    assert.equal(second.ok === false && second.failure, "api_error");
  });

  it("maps a hung request to timeout without waiting past the deadline", async () => {
    const { fetch } = mockFetch(hangingAnswer());
    const started = Date.now();
    const assessment = await gateway(fetch, { timeoutMs: 40 }).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "timeout");
    assert.ok(Date.now() - started < 2000);
  });

  it("maps a thrown fetch to network", async () => {
    const { fetch } = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "network");
  });

  it("maps a non-JSON body to bad_response", async () => {
    const { fetch } = mockFetch(new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }));
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "bad_response");
  });

  it("treats a well-formed envelope with a malformed decision as bad_response", async () => {
    const broken = { ...decisionPayload(), recommendedLimit: { amountUsdc: "1000", currency: "USDC", basis: "x" } };
    const { fetch } = mockFetch(okJson(broken));
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok, false);
    if (assessment.ok) return;
    assert.equal(assessment.failure, "bad_response");
    assert.match(assessment.detail, /recommendedLimit\.amountUsdc/);
  });

  it("refuses an answer for a different wallet", async () => {
    const { fetch } = mockFetch(okJson(decisionPayload({ wallet: FRESH })));
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "bad_response");
  });

  it("never throws into the caller, even on an unexpected error type", async () => {
    const { fetch } = mockFetch(() => {
      throw "boom";
    });
    const assessment = await gateway(fetch).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "network");
  });

  it("waits out the minimum interval between real reads", async () => {
    const slept: number[] = [];
    let clock = 1000;
    const { fetch } = mockFetch(okJson(decisionPayload()), okJson(decisionPayload()), okJson(decisionPayload()));
    const kyro = createKyroGateway({
      timeoutMs: 50,
      minIntervalMs: 1500,
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await kyro.assess(BUILDER);
    clock += 400;
    await kyro.assess(BUILDER);
    clock += 5000;
    await kyro.assess(BUILDER);
    assert.deepEqual(slept, [1100]);
    assert.equal(kyro.readsMade, 3);
  });
});

describe("kyro gateway: receipts", () => {
  it("posts the wallet and the payment use case anonymously and returns the minted receipt", async () => {
    const { fetch, calls } = mockFetch(createdJson(receiptPayload()));
    const kyro = gateway(fetch);
    const outcome = await kyro.receipt(BUILDER);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.deepEqual(outcome.receipt, {
      id: RECEIPT_ID,
      payloadHash: PAYLOAD_HASH,
      deduped: false,
      url: `${KYRO_BASE_URL}/check/r/${RECEIPT_ID}`,
      createdAt: "2026-09-07T10:00:03.000Z",
      verdict: "allow",
      advisoryLimitUsdc: 1000,
    });
    assert.deepEqual(outcome.rateLimit, { limit: 20, remaining: 19 });
    assert.equal(kyro.receiptsConfirmed, 1);
    assert.equal(kyro.readsMade, 0);
    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.ok(call !== undefined);
    assert.equal(call.url, "https://www.thekyro.co/api/v1/decision-receipts");
    assert.equal(call.init.method, "POST");
    assert.deepEqual(JSON.parse(String(call.init.body)), { wallet: BUILDER, useCase: "payment" });
    const headers = new Headers(call.init.headers);
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("x-api-key"), null);
    assert.equal(headers.get("content-type"), "application/json");
  });

  it("returns a deduped receipt (200) as ok with deduped set", async () => {
    const { fetch } = mockFetch(okJson(receiptPayload({}, { deduped: true })));
    const kyro = gateway(fetch);
    const outcome = await kyro.receipt(BUILDER);
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.receipt.deduped, true);
    assert.equal(kyro.receiptsConfirmed, 1);
    assert.equal(kyro.receiptsDeduped, 1);
  });

  it("maps failures the same way as a read and mints nothing", async () => {
    const cases: Array<[Parameters<typeof mockFetch>[0], string, number | undefined]> = [
      [errJson("RATE_LIMITED", "slow down", 429, { "retry-after": "30" }), "rate_limit", 30],
      [errJson("INTERNAL_ERROR", "boom", 503), "server_error", undefined],
      [errJson("VALIDATION_ERROR", "bad wallet", 400), "api_error", undefined],
      [hangingAnswer(), "timeout", undefined],
      [new Response("<html>", { status: 201, headers: { "content-type": "text/html" } }), "bad_response", undefined],
    ];
    for (const [answer, failure, retryAfter] of cases) {
      const { fetch } = mockFetch(answer);
      const kyro = gateway(fetch);
      const outcome = await kyro.receipt(BUILDER);
      assert.equal(outcome.ok, false, failure);
      if (outcome.ok) continue;
      assert.equal(outcome.failure, failure);
      assert.equal(outcome.retryAfterSeconds, retryAfter);
      assert.equal(kyro.receiptsConfirmed, 0);
    }
  });

  it("treats a receipt for another wallet, use case or with missing fields as bad_response", async () => {
    const cases: Array<[unknown, string]> = [
      [receiptPayload({ wallet: OTHER }), "receipt.wallet (receipt is for a different wallet)"],
      [receiptPayload({ useCase: "escrow" }), "receipt.useCase (receipt is for a different use case)"],
      [{ ...receiptPayload(), url: "https://www.thekyro.co/check/r/x" }, "url"],
      [{ ...receiptPayload(), url: `//evil.example/check/r/${RECEIPT_ID}` }, "url"],
      [{ ...receiptPayload(), url: `/\\evil.example/check/r/${RECEIPT_ID}` }, "url"],
      [{ ...receiptPayload(), url: `/check/r/${RECEIPT_ID}?x=1` }, "url"],
      [{ ...receiptPayload(), url: "/check/r/rcp_someoneElse00000" }, "url"],
      [{ ...receiptPayload(), url: "//[" }, "url"],
      [{ ...receiptPayload(), deduped: "no" }, "deduped"],
      [receiptPayload({ id: "rcp_short" }), "receipt.id"],
      [receiptPayload({ payloadHash: "abc" }), "receipt.payloadHash"],
      [receiptPayload({ decision: "maybe" as never }), "receipt.decision"],
      [receiptPayload({ recommendedLimit: { amountUsdc: -1, currency: "USDC", basis: "allow" } }), "receipt.recommendedLimit.amountUsdc"],
    ];
    for (const [data, defect] of cases) {
      const { fetch } = mockFetch(createdJson(data));
      const kyro = gateway(fetch);
      const outcome = await kyro.receipt(BUILDER);
      assert.equal(outcome.ok, false, defect);
      if (outcome.ok) continue;
      assert.equal(outcome.failure, "bad_response");
      assert.equal(outcome.detail, `receipt payload is missing or malformed at ${defect}`);
      assert.equal(kyro.receiptsConfirmed, 0);
    }
  });

  it("never throws into the caller", async () => {
    const kyro = gateway((async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch);
    const outcome = await kyro.receipt(BUILDER);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.failure, "network");
  });

  it("shares the minimum interval with reads", async () => {
    const slept: number[] = [];
    let clock = 1000;
    const { fetch } = mockFetch(okJson(decisionPayload()), createdJson(receiptPayload()), okJson(decisionPayload()));
    const kyro = createKyroGateway({
      timeoutMs: 50,
      minIntervalMs: 1500,
      fetch,
      now: () => clock,
      sleep: async (ms) => {
        slept.push(ms);
        clock += ms;
      },
    });
    await kyro.assess(BUILDER);
    clock += 200;
    await kyro.receipt(BUILDER);
    clock += 300;
    await kyro.assess(BUILDER);
    assert.deepEqual(slept, [1300, 1200]);
    assert.equal(kyro.readsMade, 2);
    assert.equal(kyro.receiptsConfirmed, 1);
  });

  it("goes through the simulated fetch when simulating, so nothing can leak to the network", async () => {
    const { fetch, calls } = mockFetch(createdJson(receiptPayload()));
    const kyro = createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, simulate: "server_error", fetch });
    const outcome = await kyro.receipt(BUILDER);
    assert.equal(outcome.ok, false);
    assert.equal(calls.length, 0);
    assert.equal(kyro.receiptsConfirmed, 0);
  });
});

describe("simulated failures", () => {
  it("timeout rejects on abort so the SDK deadline fires", async () => {
    const kyro = createKyroGateway({ timeoutMs: 40, minIntervalMs: 1500, simulate: "timeout" });
    const assessment = await kyro.assess(BUILDER);
    assert.equal(assessment.ok, false);
    if (assessment.ok) return;
    assert.equal(assessment.failure, "timeout");
    assert.equal(assessment.simulated, true);
    assert.equal(kyro.readsMade, 0);
    assert.equal(kyro.simulated, true);
  });

  it("rate_limit answers 429 with the public error code and headers", async () => {
    const response = await simulatedFetch("rate_limit")("https://example.invalid");
    assert.equal(response.status, 429);
    assert.equal(response.headers.get("retry-after"), "30");
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "RATE_LIMITED");
    const assessment = await createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, simulate: "rate_limit" }).assess(BUILDER);
    assert.equal(assessment.ok, false);
    if (assessment.ok) return;
    assert.equal(assessment.failure, "rate_limit");
    assert.equal(assessment.retryAfterSeconds, 30);
    assert.equal(assessment.simulated, true);
  });

  it("server_error answers 503 with INTERNAL", async () => {
    const response = await simulatedFetch("server_error")("https://example.invalid");
    assert.equal(response.status, 503);
    const body = (await response.json()) as { error: { code: string } };
    assert.equal(body.error.code, "INTERNAL");
    const assessment = await createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, simulate: "server_error" }).assess(BUILDER);
    assert.equal(assessment.ok === false && assessment.failure, "server_error");
  });

  it("ignores an injected fetch when simulating, so nothing can leak to the network", async () => {
    const { fetch, calls } = mockFetch(okJson(decisionPayload()));
    const kyro = createKyroGateway({ timeoutMs: 50, minIntervalMs: 0, simulate: "server_error", fetch });
    await kyro.assess(BUILDER);
    assert.equal(calls.length, 0);
  });
});

describe("findReceiptDefect", () => {
  it("accepts the spec example shape and a differently cased wallet", () => {
    assert.equal(findReceiptDefect(receiptPayload(), BUILDER), undefined);
    assert.equal(findReceiptDefect(receiptPayload({}, { deduped: true }), BUILDER.toUpperCase().replace("0X", "0x")), undefined);
  });

  it("names the first defect", () => {
    assert.equal(findReceiptDefect(null, BUILDER), "payload is not an object");
    assert.equal(findReceiptDefect({ url: "/check/r/x", deduped: false }, BUILDER), "receipt");
    assert.equal(findReceiptDefect(receiptPayload({ createdAt: "yesterday" }), BUILDER), "receipt.createdAt");
    assert.equal(findReceiptDefect(receiptPayload({ recommendedLimit: undefined as never }), BUILDER), "receipt.recommendedLimit");
  });
});

describe("findDecisionDefect", () => {
  it("accepts the real payload shapes", () => {
    assert.equal(findDecisionDefect(decisionPayload(), BUILDER), undefined);
    assert.equal(findDecisionDefect(baselinePayload(FRESH), FRESH), undefined);
    assert.equal(findDecisionDefect(decisionPayload(), BUILDER.toUpperCase().replace("0X", "0x")), undefined);
  });

  it("names the first defect", () => {
    assert.equal(findDecisionDefect(null, BUILDER), "payload is not an object");
    assert.equal(findDecisionDefect({ ...decisionPayload(), decision: "maybe" }, BUILDER), "decision");
    assert.equal(findDecisionDefect({ ...decisionPayload(), freshness: null }, BUILDER), "freshness");
    assert.equal(findDecisionDefect({ ...decisionPayload(), reasons: [{ code: 1 }] }, BUILDER), "reasons");
    assert.equal(findDecisionDefect({ ...decisionPayload(), decisionModelVersion: undefined }, BUILDER), "decisionModelVersion");
  });
});
