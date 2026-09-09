import type { KyroDecision, KyroRateLimitInfo } from "@kyrodev/sdk";

/** The only chain this demo knows. Circle Agent Wallets reach Arc on testnet today. */
export const CHAIN = "ARC-TESTNET";

/** Kyro use case sent with every decision read. */
export const USE_CASE = "payment";

export type Mode = "dry-run" | "live";

export type SimulationKind = "timeout" | "rate_limit" | "server_error";

/** One payment the planner wants to make. */
export interface Proposal {
  invoiceId: string;
  /** Recipient as given by the planner. Validated and normalised by the policy. */
  to: string;
  amountUsdc: number;
  memo?: string;
  chain: string;
}

/** Why a Kyro read produced no usable verdict. Every one of these fails closed. */
export type FailureKind =
  | "rate_limit"
  | "server_error"
  | "api_error"
  | "timeout"
  | "network"
  | "bad_response"
  | "unexpected";

export type Assessment =
  | {
      ok: true;
      decision: KyroDecision;
      simulated: boolean;
      rateLimit?: KyroRateLimitInfo;
    }
  | {
      ok: false;
      failure: FailureKind;
      detail: string;
      httpStatus?: number;
      retryAfterSeconds?: number;
      simulated: boolean;
      rateLimit?: KyroRateLimitInfo;
    };

/** What the operator policy does with a proposal. Never a Kyro word. */
export type Action = "proceed" | "hold" | "refuse";

export type ConditionCode =
  | "CHAIN_NOT_ALLOWED"
  | "RECIPIENT_INVALID"
  | "RECIPIENT_IS_AGENT_WALLET"
  | "RECIPIENT_NOT_IN_TASK_LIST"
  | "AMOUNT_INVALID"
  | "KYRO_UNAVAILABLE"
  | "VERDICT_BLOCK"
  | "VERDICT_CAUTION"
  | "BASELINE_ONLY"
  | "OVER_ADVISORY_LIMIT"
  | "OVER_TRANSFER_CAP"
  | "RUN_BUDGET_EXCEEDED"
  | "DUPLICATE_RECENT";

export interface Condition {
  code: ConditionCode;
  /** The action this condition forces on its own. */
  action: "refuse" | "hold";
  message: string;
}

export interface Caps {
  maxUsdcPerTransfer: number;
  maxUsdcPerRun: number;
}

/** A payment that already went through the gate with a proceed action. */
export interface RecentPayment {
  to: string;
  amountUsdc: number;
  /** ISO timestamp. */
  at: string;
}

export interface PolicyInput {
  proposal: Proposal;
  /** Undefined when the proposal never reached Kyro (pre-screen refused it). */
  assessment: Assessment | undefined;
  caps: Caps;
  spentUsdcThisRun: number;
  recentPayments: RecentPayment[];
  now: Date;
  /** The paying wallet, when known. Paying yourself is refused. */
  agentWallet?: string;
  /** Recipients the task list allows. Planners that let a model pick recipients must pass this. */
  allowedRecipients?: ReadonlySet<string>;
}

export interface PolicyDecision {
  action: Action;
  /** Every triggered condition, not only the winning one. */
  conditions: Condition[];
  /** Offered to a human on a hold: min(requested, advisory limit, per-transfer cap, remaining run budget). */
  cappedAmountUsdc?: number;
}

export interface TransferRequest {
  to: string;
  amountUsdc: number;
  from: string;
  /**
   * Circle API idempotency key for this payment intent, a UUID v4 the gate
   * records in the audit log before anything is spawned. Live only: dry-run
   * requests carry none and the printed command stays as it was.
   */
  idempotencyKey?: string;
}

/**
 * What happened to a proceed.
 *
 * - `dry-run`: the command was printed, nothing ran.
 * - `submitted`: the Circle CLI returned a terminal success (`CONFIRMED` or
 *   `COMPLETE`) and the recipient, amount and chain in its answer match the
 *   request.
 * - `failed`: the CLI answered with an error that rules out a transfer:
 *   it stopped before submitting or the transaction reached a terminal
 *   failure. Nothing moved.
 * - `unknown`: anything else. The CLI timed out, was stopped, answered
 *   something unparsable or reported an error that may have been raised
 *   after the transfer was submitted. Reconcile before paying again.
 */
export type ExecutionResult =
  | { state: "dry-run"; argv: string[] }
  | {
      state: "submitted";
      argv: string[];
      txHash: string;
      chainState: string;
      transactionId: string | null;
      idempotencyKey: string | null;
    }
  | {
      state: "failed";
      argv: string[];
      exitCode: number | null;
      errorCode: string | null;
      detail: string;
      idempotencyKey: string | null;
    }
  | {
      state: "unknown";
      argv: string[];
      exitCode: number | null;
      errorCode: string | null;
      detail: string;
      idempotencyKey: string | null;
    };

export interface TransferHooks {
  /** Called with the final argv right before the CLI is spawned. Never called in dry-run. */
  onSpawn?: (argv: string[]) => void;
}

export interface Executor {
  readonly mode: Mode;
  /** Only ever called for a proceed action, exactly once per proposal. */
  transfer(request: TransferRequest, hooks?: TransferHooks): Promise<ExecutionResult>;
}
