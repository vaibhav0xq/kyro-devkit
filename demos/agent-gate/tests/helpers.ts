import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KyroDecision } from "@kyrodev/sdk";
import { buildTransferArgv } from "../src/circle";
import type { Assessment, ExecutionResult, Executor, FailureKind, Mode, Proposal, TransferRequest } from "../src/types";
import { CHAIN } from "../src/types";

export const BUILDER = "0xbb30481982786ea53fe1856e0745eec814d83252";
export const FRESH = "0x000000000000000000000000000000000000dead";
export const AGENT = `0x${"1a".repeat(20)}`;
export const OTHER = `0x${"2b".repeat(20)}`;

export function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    invoiceId: "inv-test",
    to: BUILDER,
    amountUsdc: 1.5,
    chain: CHAIN,
    ...overrides,
  };
}

export function decisionPayload(overrides: Partial<KyroDecision> = {}): KyroDecision {
  return {
    wallet: BUILDER,
    username: "vaibhav_meta.kyro",
    useCase: "payment",
    decision: "allow",
    riskLevel: "Trusted",
    recommendedLimit: { amountUsdc: 1000, currency: "USDC", basis: "allow" },
    reasons: [{ code: "TEST_REASON", message: "test reason" }],
    warnings: [],
    score: 89,
    evidence: { used: ["score"], missing: [] },
    freshness: {
      cacheStatus: "cached",
      lastIndexedAt: "2026-09-06T06:55:43.049Z",
      refreshInProgress: false,
      refreshRecommended: false,
    },
    coverage: null,
    scoreModelVersion: "identity_score_v1",
    decisionModelVersion: "decision_v0.4.1",
    ...overrides,
  };
}

export function baselinePayload(wallet: string): KyroDecision {
  return decisionPayload({
    wallet,
    username: null,
    decision: "caution",
    riskLevel: "High Risk",
    recommendedLimit: { amountUsdc: 50, currency: "USDC", basis: "caution" },
    score: 0,
    freshness: {
      cacheStatus: "indexing_required",
      lastIndexedAt: null,
      refreshInProgress: false,
      refreshRecommended: true,
    },
    scoreModelVersion: null,
  });
}

export function okAssessment(decision: KyroDecision = decisionPayload()): Assessment {
  return { ok: true, decision, simulated: false };
}

export function failedAssessment(failure: FailureKind): Assessment {
  return { ok: false, failure, detail: `${failure} detail`, simulated: false };
}

export function okJson(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ ok: true, version: "v1", data }), {
    status: 200,
    headers: { "content-type": "application/json", "x-ratelimit-limit": "20", "x-ratelimit-remaining": "19", ...headers },
  });
}

export function errJson(
  code: string,
  message: string,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ ok: false, version: "v1", error: { code, message } }), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

export interface RecordedCall {
  url: string;
  init: RequestInit;
}

type Answer = Response | ((url: string, init: RequestInit) => Response | Promise<Response>);

/** Queue-based fetch. Each answer serves one call; an exhausted queue throws. */
export function mockFetch(...answers: Answer[]): { fetch: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const queue = [...answers];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call: RecordedCall = { url, init: init ?? {} };
    calls.push(call);
    const next = queue.shift();
    if (next === undefined) throw new Error(`mock fetch exhausted: no answer queued for ${url}`);
    return typeof next === "function" ? next(url, call.init) : next;
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** Never answers; rejects when the SDK's timeout aborts the request. */
export function hangingAnswer(): Answer {
  return (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason ?? new DOMException("This operation was aborted", "AbortError")),
        { once: true },
      );
    });
}

export function recordingExecutor(
  result: (request: TransferRequest, argv: string[]) => ExecutionResult = (_request, argv) => ({
    state: "dry-run",
    argv,
  }),
  mode: Mode = "dry-run",
): Executor & { calls: TransferRequest[] } {
  const calls: TransferRequest[] = [];
  return {
    mode,
    calls,
    async transfer(request, hooks) {
      calls.push(request);
      const argv = buildTransferArgv(request);
      if (mode === "live") hooks?.onSpawn?.(argv);
      return result(request, argv);
    },
  };
}

export const TX_HASH = `0x${"ab".repeat(32)}`;
export const CIRCLE_TX_ID = "7f1e2d3c-4b5a-4f60-9e8d-1c2b3a4f5e6d";

/** A Circle CLI success envelope for the given request, as `--output json` prints it. */
export function successEnvelope(
  request: { to: string; amountUsdc: number; idempotencyKey?: string },
  overrides: Record<string, unknown> = {},
): string {
  const data: Record<string, unknown> = {
    ...(request.idempotencyKey !== undefined ? { idempotencyKey: request.idempotencyKey } : {}),
    id: CIRCLE_TX_ID,
    state: "CONFIRMED",
    blockchain: CHAIN,
    txHash: TX_HASH,
    sourceAddress: AGENT,
    destinationAddress: request.to,
    amounts: [String(request.amountUsdc)],
    amountInUSD: String(request.amountUsdc),
    networkFee: "0",
    operation: "TRANSFER",
    transactionType: "OUTBOUND",
    createDate: "2026-09-07T10:00:05.000Z",
    updateDate: "2026-09-07T10:00:19.000Z",
    ...overrides,
  };
  return `${JSON.stringify({ data }, null, 2)}\n`;
}

/** A Circle CLI error envelope, as `--output json` prints it on exit 1. */
export function errorEnvelope(code: string, message: string, hint?: string): string {
  const error: Record<string, unknown> = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (code === "INTERNAL") error.feedbackHint = 'circle feedback submit --category BUG "<what you were doing>"';
  return `${JSON.stringify({ error }, null, 2)}\n`;
}

export async function tempAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "agent-gate-"));
  return join(dir, "audit.log");
}

export function collectOut(): { out: (line: string) => void; lines: string[]; text: () => string } {
  const lines: string[] = [];
  return {
    out: (line) => {
      lines.push(line);
    },
    lines,
    text: () => lines.join("\n"),
  };
}

/** Answers prompts in order and records the questions. */
export function scriptedPrompt(answers: string[]): {
  prompt: (question: string) => Promise<string>;
  questions: string[];
} {
  const questions: string[] = [];
  const queue = [...answers];
  return {
    questions,
    prompt: async (question) => {
      questions.push(question);
      const answer = queue.shift();
      if (answer === undefined) throw new Error("prompt called more often than scripted");
      return answer;
    },
  };
}

export const FIXED_NOW = new Date("2026-09-07T10:00:00.000Z");
