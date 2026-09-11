/**
 * Kyro side of the gate: one anonymous decision read per proposal through
 * @kyrodev/sdk, a throttle between requests and a strict shape check on the
 * answer. Every failure is returned as a value so the planner never sees an
 * exception and the policy can fail closed.
 *
 * With receipts on, a proceed also mints one decision receipt through the
 * same client, the same throttle and the same failure mapping, so the gate
 * treats a receipt it could not get exactly like a read it could not get.
 */
import { Kyro, KyroApiError, KyroRequestError } from "@kyrodev/sdk";
import type {
  KyroDecision,
  KyroRateLimitEvent,
  KyroRateLimitInfo,
  KyroReceiptCreateResult,
} from "@kyrodev/sdk";
import type { Assessment, FailureKind, MintedReceipt, ReceiptOutcome, SimulationKind } from "./types";
import { USE_CASE } from "./types";

/** The public API and the site that serves receipt pages share this origin. */
export const KYRO_BASE_URL = "https://www.thekyro.co";

export interface KyroGatewayOptions {
  timeoutMs: number;
  minIntervalMs: number;
  /** When set, no request reaches Kyro: an injected fetch answers the way a failing API would. */
  simulate?: SimulationKind;
  /** Used for tests. Defaults to globalThis.fetch. Ignored when simulate is set. */
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface KyroGateway {
  assess(wallet: string): Promise<Assessment>;
  /** Mints a decision receipt for the wallet and the payment use case. Never throws. */
  receipt(wallet: string): Promise<ReceiptOutcome>;
  /** Decision reads that actually went to the API (simulated reads excluded). */
  readonly readsMade: number;
  /** Receipts the API confirmed in this run, new or deduped (simulated runs never mint). */
  readonly receiptsConfirmed: number;
  /** How many of those were deduped: an identical decision state was already minted that day. */
  readonly receiptsDeduped: number;
  readonly simulated: boolean;
}

const VERDICTS = new Set(["allow", "caution", "block"]);
const RECEIPT_ID = /^rcp_[A-Za-z0-9_-]{16}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
/** One leading slash, plain path characters, nothing that could name another origin or add a query. */
const SITE_RELATIVE_PATH = /^\/(?!\/)[A-Za-z0-9_./-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isReasonList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        isRecord(entry) && typeof entry.code === "string" && typeof entry.message === "string",
    )
  );
}

/**
 * Returns the first missing or malformed field. Undefined means the payload
 * carries everything the policy relies on.
 */
export function findDecisionDefect(data: unknown, wallet: string): string | undefined {
  if (!isRecord(data)) return "payload is not an object";
  if (typeof data.wallet !== "string") return "wallet";
  if (data.wallet.toLowerCase() !== wallet.toLowerCase()) return "wallet (answer is for a different wallet)";
  if (typeof data.decision !== "string" || !VERDICTS.has(data.decision)) return "decision";
  if (!isRecord(data.recommendedLimit)) return "recommendedLimit";
  const amount = data.recommendedLimit.amountUsdc;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return "recommendedLimit.amountUsdc";
  }
  if (!isRecord(data.freshness)) return "freshness";
  const cacheStatus = data.freshness.cacheStatus;
  if (cacheStatus !== null && typeof cacheStatus !== "string") return "freshness.cacheStatus";
  if (!isReasonList(data.reasons)) return "reasons";
  if (!isReasonList(data.warnings)) return "warnings";
  if (typeof data.decisionModelVersion !== "string") return "decisionModelVersion";
  return undefined;
}

/**
 * Same idea for a receipt creation answer: the fields the gate prints,
 * stores and compares against the read must be there and be for this wallet
 * and use case. Undefined means the payload is usable.
 */
export function findReceiptDefect(data: unknown, wallet: string): string | undefined {
  if (!isRecord(data)) return "payload is not an object";
  if (typeof data.deduped !== "boolean") return "deduped";
  const receipt = data.receipt;
  if (!isRecord(receipt)) return "receipt";
  if (typeof receipt.id !== "string" || !RECEIPT_ID.test(receipt.id)) return "receipt.id";
  // The share URL is printed and stored, so it has to be a site-relative path
  // that ends in this receipt's id: no other origin, no backslashes, no query.
  if (typeof data.url !== "string" || !SITE_RELATIVE_PATH.test(data.url) || !data.url.endsWith(`/${receipt.id}`)) {
    return "url";
  }
  if (typeof receipt.payloadHash !== "string" || !SHA256_HEX.test(receipt.payloadHash)) return "receipt.payloadHash";
  if (typeof receipt.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.createdAt))) return "receipt.createdAt";
  if (typeof receipt.wallet !== "string") return "receipt.wallet";
  if (receipt.wallet.toLowerCase() !== wallet.toLowerCase()) return "receipt.wallet (receipt is for a different wallet)";
  if (receipt.useCase !== USE_CASE) return "receipt.useCase (receipt is for a different use case)";
  if (typeof receipt.decision !== "string" || !VERDICTS.has(receipt.decision)) return "receipt.decision";
  if (!isRecord(receipt.recommendedLimit)) return "receipt.recommendedLimit";
  const amount = receipt.recommendedLimit.amountUsdc;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
    return "receipt.recommendedLimit.amountUsdc";
  }
  return undefined;
}

function toMintedReceipt(data: KyroReceiptCreateResult): MintedReceipt {
  return {
    id: data.receipt.id,
    payloadHash: data.receipt.payloadHash,
    deduped: data.deduped,
    url: new URL(data.url, KYRO_BASE_URL).toString(),
    createdAt: data.receipt.createdAt,
    verdict: data.receipt.decision,
    advisoryLimitUsdc: data.receipt.recommendedLimit.amountUsdc,
  };
}

function classify(error: unknown): {
  failure: FailureKind;
  detail: string;
  httpStatus?: number;
  retryAfterSeconds?: number;
  rateLimit?: KyroRateLimitInfo;
} {
  if (error instanceof KyroApiError) {
    const base = {
      detail: `HTTP ${error.status} ${error.code}: ${error.message}`,
      httpStatus: error.status,
      ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      ...(error.rateLimit !== undefined ? { rateLimit: error.rateLimit } : {}),
    };
    if (error.status === 429) return { failure: "rate_limit", ...base };
    if (error.status >= 500) return { failure: "server_error", ...base };
    return { failure: "api_error", ...base };
  }
  if (error instanceof KyroRequestError) {
    const base = {
      detail: `${error.code}: ${error.message}`,
      ...(error.status !== undefined ? { httpStatus: error.status } : {}),
    };
    if (error.code === "TIMEOUT") return { failure: "timeout", ...base };
    if (error.code === "NETWORK") return { failure: "network", ...base };
    return { failure: "bad_response", ...base };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { failure: "unexpected", detail: message };
}

/**
 * A fetch that behaves like a failing Kyro API without contacting it.
 * The shapes match the public error contract: a v1 error envelope with
 * RATE_LIMITED on 429 and INTERNAL on 503.
 */
export function simulatedFetch(kind: SimulationKind): typeof globalThis.fetch {
  const impl = async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (kind === "timeout") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(signal.reason ?? new DOMException("This operation was aborted", "AbortError")),
          { once: true },
        );
      });
    }
    if (kind === "rate_limit") {
      return new Response(
        JSON.stringify({
          ok: false,
          version: "v1",
          error: { code: "RATE_LIMITED", message: "Rate limit exceeded. Retry in 30s." },
        }),
        {
          status: 429,
          headers: {
            "content-type": "application/json",
            "retry-after": "30",
            "x-ratelimit-limit": "20",
            "x-ratelimit-remaining": "0",
          },
        },
      );
    }
    return new Response(
      JSON.stringify({
        ok: false,
        version: "v1",
        error: { code: "INTERNAL", message: "Decision is temporarily unavailable. Please retry." },
      }),
      { status: 503, headers: { "content-type": "application/json" } },
    );
  };
  return impl as typeof globalThis.fetch;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createKyroGateway(options: KyroGatewayOptions): KyroGateway {
  const simulated = options.simulate !== undefined;
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? defaultSleep;
  let lastRateLimit: KyroRateLimitEvent | undefined;
  let lastRequestAt: number | undefined;
  let readsMade = 0;
  let receiptsConfirmed = 0;
  let receiptsDeduped = 0;

  const clientConfig: ConstructorParameters<typeof Kyro>[0] = {
    timeoutMs: options.timeoutMs,
    onRateLimit: (event) => {
      lastRateLimit = event;
    },
  };
  if (options.simulate !== undefined) {
    clientConfig.fetch = simulatedFetch(options.simulate);
  } else if (options.fetch !== undefined) {
    clientConfig.fetch = options.fetch;
  }
  const kyro = new Kyro(clientConfig);

  function rateLimitOf(): KyroRateLimitInfo | undefined {
    if (lastRateLimit === undefined) return undefined;
    const info: KyroRateLimitInfo = {};
    if (lastRateLimit.limit !== undefined) info.limit = lastRateLimit.limit;
    if (lastRateLimit.remaining !== undefined) info.remaining = lastRateLimit.remaining;
    return info;
  }

  /** Reads and receipt creations share one gap: both spend the same anonymous budget. */
  async function throttle(): Promise<void> {
    if (!simulated && lastRequestAt !== undefined) {
      const elapsed = now() - lastRequestAt;
      if (elapsed < options.minIntervalMs) await sleep(options.minIntervalMs - elapsed);
    }
    lastRequestAt = now();
    lastRateLimit = undefined;
  }

  function failed(error: unknown): {
    ok: false;
    failure: FailureKind;
    detail: string;
    httpStatus?: number;
    retryAfterSeconds?: number;
    rateLimit?: KyroRateLimitInfo;
  } {
    const classified = classify(error);
    const rateLimit = classified.rateLimit ?? rateLimitOf();
    return {
      ok: false,
      failure: classified.failure,
      detail: classified.detail,
      ...(classified.httpStatus !== undefined ? { httpStatus: classified.httpStatus } : {}),
      ...(classified.retryAfterSeconds !== undefined ? { retryAfterSeconds: classified.retryAfterSeconds } : {}),
      ...(rateLimit !== undefined ? { rateLimit } : {}),
    };
  }

  async function assess(wallet: string): Promise<Assessment> {
    await throttle();
    if (!simulated) readsMade += 1;

    let decision: KyroDecision;
    try {
      decision = await kyro.decisions.check(wallet, { useCase: USE_CASE });
    } catch (error) {
      return { ...failed(error), simulated };
    }

    const defect = findDecisionDefect(decision, wallet);
    const rateLimit = rateLimitOf();
    if (defect !== undefined) {
      return {
        ok: false,
        failure: "bad_response",
        detail: `decision payload is missing or malformed at ${defect}`,
        ...(rateLimit !== undefined ? { rateLimit } : {}),
        simulated,
      };
    }
    return { ok: true, decision, simulated, ...(rateLimit !== undefined ? { rateLimit } : {}) };
  }

  async function receipt(wallet: string): Promise<ReceiptOutcome> {
    await throttle();

    let created: KyroReceiptCreateResult;
    try {
      created = await kyro.receipts.create({ wallet, useCase: USE_CASE });
    } catch (error) {
      return failed(error);
    }

    const rateLimit = rateLimitOf();
    const malformed = (at: string): ReceiptOutcome => ({
      ok: false,
      failure: "bad_response",
      detail: `receipt payload is missing or malformed at ${at}`,
      ...(rateLimit !== undefined ? { rateLimit } : {}),
    });
    const defect = findReceiptDefect(created, wallet);
    if (defect !== undefined) return malformed(defect);
    let receipt: MintedReceipt;
    try {
      receipt = toMintedReceipt(created);
    } catch {
      // The shape check keeps the URL to a plain site-relative path, so this
      // is a guard against a surprise, not an expected branch.
      return malformed("url");
    }
    if (!simulated) {
      receiptsConfirmed += 1;
      if (receipt.deduped) receiptsDeduped += 1;
    }
    return { ok: true, receipt, ...(rateLimit !== undefined ? { rateLimit } : {}) };
  }

  return {
    assess,
    receipt,
    get readsMade() {
      return readsMade;
    },
    get receiptsConfirmed() {
      return receiptsConfirmed;
    },
    get receiptsDeduped() {
      return receiptsDeduped;
    },
    simulated,
  };
}
