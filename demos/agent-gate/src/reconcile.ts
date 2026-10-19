/**
 * Reconcile an unresolved live attempt against the provider.
 *
 * After an unknown result the gate does not know whether USDC moved. The
 * only way to find out is to ask Circle what the agent wallet actually
 * sent. `interpretReconcileOutput` is the pure half of that: it takes one
 * `circle transaction list` answer and the attempt being chased, and says
 * confirmed, failed or unknown. No spawn, no clock, no filesystem, so the
 * contract is testable against a recorded answer.
 *
 * The provider response carries no idempotency key. That was checked
 * against the real CLI, not assumed: the transaction object has id, state,
 * blockchain, txHash, sourceAddress, destinationAddress, amounts,
 * operation, transactionType, createDate, updateDate and firstConfirmDate,
 * and nothing that echoes the key the transfer was sent with. So a match
 * here is made on recipient, amount, direction, source wallet, chain and a
 * createDate at or after the moment the intent line was written.
 *
 * That is weaker than a key match and the code treats it that way. Exactly
 * one candidate may resolve an attempt. Two candidates mean two payments
 * that look alike and the answer stays unknown, because the expensive
 * mistake is deciding a second transfer was the first one. Only terminal
 * states resolve: anything still moving, unrecognised, malformed or absent
 * stays unknown and waits for a human.
 */
import { SUCCESS_STATES } from "./circle";
import type { CliOutcome } from "./circle";
import { normaliseAddress } from "./policy";
import { CHAIN } from "./types";

/**
 * States that mean the transfer reached a terminal failure and nothing
 * moved. Everything else that is not a success is still in flight or not
 * understood, and neither of those is a reason to call a payment failed.
 */
export const TERMINAL_FAILURE_STATES: ReadonlySet<string> = new Set(["FAILED", "CANCELLED", "DENIED"]);

/** One live attempt with no terminal answer, taken from the audit log. */
export interface UnresolvedAttempt {
  invoiceId: string;
  /** Recipient, as recorded on the intent line. */
  to: string;
  amountUsdc: number;
  idempotencyKey: string;
  /** When the intent that first carried this key was written. The search window starts here. */
  intentAt: string;
}

/**
 * What the reconcile concluded. `unknown` always carries a reason, because
 * a human reads it and decides what to do next.
 */
export type ReconcileOutcome =
  | {
      outcome: "confirmed";
      transactionId: string;
      txHash: string | null;
      chainState: string;
      detail: string;
    }
  | {
      outcome: "failed";
      transactionId: string;
      chainState: string;
      detail: string;
    }
  | { outcome: "unknown"; detail: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/**
 * True when this transaction could be the attempt. Every field has to
 * agree; a missing or malformed one is a mismatch, never a maybe.
 */
function isCandidate(entry: Record<string, unknown>, attempt: UnresolvedAttempt, agentWallet: string): boolean {
  if (entry.transactionType !== "OUTBOUND") return false;
  if (entry.operation !== "TRANSFER") return false;
  if (entry.blockchain !== CHAIN) return false;

  const source = entry.sourceAddress;
  if (typeof source !== "string" || normaliseAddress(source) !== normaliseAddress(agentWallet)) return false;

  const destination = entry.destinationAddress;
  if (typeof destination !== "string" || normaliseAddress(destination) !== normaliseAddress(attempt.to)) return false;

  const amounts = entry.amounts;
  const first = Array.isArray(amounts) ? amounts[0] : undefined;
  const amount = typeof first === "string" && first.trim() !== "" ? Number(first) : Number.NaN;
  if (!Number.isFinite(amount) || amount !== attempt.amountUsdc) return false;

  // A transfer created before the intent line was written cannot be this
  // attempt; it is an older payment to the same recipient for the same
  // amount, which is exactly the case this check exists to exclude.
  const created = typeof entry.createDate === "string" ? Date.parse(entry.createDate) : Number.NaN;
  const intent = Date.parse(attempt.intentAt);
  if (!Number.isFinite(created) || !Number.isFinite(intent) || created < intent) return false;

  return true;
}

/**
 * Pure mapping from one `circle transaction list` answer to a verdict on
 * one attempt. Anything short of a single terminal candidate is unknown.
 */
export function interpretReconcileOutput(
  attempt: UnresolvedAttempt,
  agentWallet: string,
  outcome: CliOutcome,
): ReconcileOutcome {
  if (outcome.spawnError !== undefined) {
    return { outcome: "unknown", detail: `cannot start the Circle CLI: ${outcome.spawnError}` };
  }
  if (outcome.timedOut) {
    return { outcome: "unknown", detail: "the listing did not answer before the timeout passed" };
  }
  if (outcome.processError !== undefined) {
    return { outcome: "unknown", detail: `the CLI process raised ${outcome.processError} after it started` };
  }
  if (outcome.signal !== null && outcome.exitCode === null) {
    return { outcome: "unknown", detail: `the CLI was stopped by ${outcome.signal}` };
  }

  const envelope = parseJsonObject(outcome.stdout);
  if (envelope === undefined) {
    return { outcome: "unknown", detail: `exit ${String(outcome.exitCode)} but stdout is not a JSON object` };
  }
  const error = isRecord(envelope.error) ? envelope.error : undefined;
  if (error !== undefined) {
    const message = stringOrNull(error.message) ?? "no message";
    return { outcome: "unknown", detail: `the listing failed: ${message}` };
  }
  if (outcome.exitCode !== 0) {
    return { outcome: "unknown", detail: `exit ${String(outcome.exitCode)} without an error envelope` };
  }
  const data = isRecord(envelope.data) ? envelope.data : undefined;
  if (data === undefined) {
    return { outcome: "unknown", detail: "stdout has no data object" };
  }
  const transactions = data.transactions;
  if (!Array.isArray(transactions)) {
    return { outcome: "unknown", detail: "data.transactions is not an array" };
  }

  const candidates = transactions.filter(
    (entry): entry is Record<string, unknown> => isRecord(entry) && isCandidate(entry, attempt, agentWallet),
  );

  if (candidates.length === 0) {
    // Not proof that nothing was sent: the listing is paged and a very
    // recent transfer may not be indexed yet. An empty answer is the
    // weakest evidence there is, so it resolves nothing.
    return {
      outcome: "unknown",
      detail: "no outbound transfer in the listing matches this recipient, amount and time; nothing is resolved on an absence",
    };
  }
  if (candidates.length > 1) {
    return {
      outcome: "unknown",
      detail: `${String(candidates.length)} outbound transfers match this recipient, amount and time; the response carries no idempotency key, so which one is this attempt cannot be told apart here`,
    };
  }

  const match = candidates[0];
  if (match === undefined) {
    return { outcome: "unknown", detail: "no candidate to read" };
  }
  const state = match.state;
  if (typeof state !== "string" || state === "") {
    return { outcome: "unknown", detail: "the matching transaction has no state" };
  }
  const transactionId = stringOrNull(match.id);
  if (transactionId === null) {
    return { outcome: "unknown", detail: `a transaction in state ${state} matches but carries no id` };
  }

  if (SUCCESS_STATES.has(state)) {
    const txHash = stringOrNull(match.txHash);
    return {
      outcome: "confirmed",
      transactionId,
      txHash,
      chainState: state,
      detail: `transaction ${transactionId} is ${state}${txHash !== null ? ` (${txHash})` : ""}`,
    };
  }
  if (TERMINAL_FAILURE_STATES.has(state)) {
    return {
      outcome: "failed",
      transactionId,
      chainState: state,
      detail: `transaction ${transactionId} reached ${state}; nothing moved`,
    };
  }
  return {
    outcome: "unknown",
    detail: `transaction ${transactionId} is ${state}, which is not a terminal state; check again later`,
  };
}
