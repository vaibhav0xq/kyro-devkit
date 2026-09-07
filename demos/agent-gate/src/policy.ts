/**
 * Operator policy. Pure: no I/O, no clock of its own, no network.
 *
 * Kyro returns a verdict (allow, caution or block) plus an advisory limit.
 * This policy turns the verdict, the operator caps and the run history into
 * an action: proceed, hold or refuse. Precedence is refuse over hold over
 * proceed. Every triggered condition is reported, not only the winning one.
 */
import type {
  Action,
  Caps,
  Condition,
  PolicyDecision,
  PolicyInput,
  Proposal,
  RecentPayment,
} from "./types";
import { CHAIN } from "./types";

/** Two identical payments closer together than this are held as a probable duplicate. */
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function isAddress(value: unknown): value is string {
  return typeof value === "string" && ADDRESS_PATTERN.test(value);
}

export function normaliseAddress(value: string): string {
  return value.toLowerCase();
}

/** Finite, above zero, at most six decimals (USDC precision). */
export function isValidUsdcAmount(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return false;
  return Number(value.toFixed(6)) === value;
}

/**
 * Round down to six decimals (whole micro-USDC). Multiplication noise far
 * below a micro-USDC is tolerated, but the result never exceeds the input.
 */
export function floorUsdc(value: number): number {
  let micro = Math.floor(Number((value * 1_000_000).toFixed(6)));
  if (micro / 1_000_000 > value) micro -= 1;
  return Math.max(micro, 0) / 1_000_000;
}

function formatUsdc(value: number): string {
  return `${Number(value.toFixed(6))} USDC`;
}

/**
 * Checks that need no Kyro answer. A proposal that fails any of these is
 * refused before a single request leaves the process.
 */
export function prescreen(
  proposal: Proposal,
  context: { agentWallet?: string; allowedRecipients?: ReadonlySet<string> },
): Condition[] {
  const conditions: Condition[] = [];

  if (proposal.chain !== CHAIN) {
    conditions.push({
      code: "CHAIN_NOT_ALLOWED",
      action: "refuse",
      message: `chain ${JSON.stringify(proposal.chain)} is not ${CHAIN}, the only chain this demo pays on`,
    });
  }

  if (!isAddress(proposal.to)) {
    conditions.push({
      code: "RECIPIENT_INVALID",
      action: "refuse",
      message: `recipient ${JSON.stringify(proposal.to)} is not a 0x-prefixed 40-hex address`,
    });
  } else {
    const to = normaliseAddress(proposal.to);
    if (context.agentWallet !== undefined && to === normaliseAddress(context.agentWallet)) {
      conditions.push({
        code: "RECIPIENT_IS_AGENT_WALLET",
        action: "refuse",
        message: "recipient is the agent wallet itself",
      });
    }
    if (context.allowedRecipients !== undefined && !context.allowedRecipients.has(to)) {
      conditions.push({
        code: "RECIPIENT_NOT_IN_TASK_LIST",
        action: "refuse",
        message: "recipient is not on the task list, so the planner may not pay it",
      });
    }
  }

  if (!isValidUsdcAmount(proposal.amountUsdc)) {
    conditions.push({
      code: "AMOUNT_INVALID",
      action: "refuse",
      message: `amount ${String(proposal.amountUsdc)} must be a finite number above zero with at most six decimals`,
    });
  }

  return conditions;
}

function findDuplicate(
  proposal: Proposal,
  recentPayments: RecentPayment[],
  now: Date,
): RecentPayment | undefined {
  if (!isAddress(proposal.to)) return undefined;
  const to = normaliseAddress(proposal.to);
  const floor = now.getTime() - DUPLICATE_WINDOW_MS;
  return recentPayments.find((payment) => {
    const at = Date.parse(payment.at);
    return (
      Number.isFinite(at) &&
      at >= floor &&
      at <= now.getTime() &&
      normaliseAddress(payment.to) === to &&
      payment.amountUsdc === proposal.amountUsdc
    );
  });
}

/** The amount a human may approve on a hold. Undefined when nothing is left to approve. */
export function cappedAlternative(input: {
  requestedUsdc: number;
  advisoryLimitUsdc: number | undefined;
  caps: Caps;
  spentUsdcThisRun: number;
}): number | undefined {
  const remainingRun = input.caps.maxUsdcPerRun - input.spentUsdcThisRun;
  const candidates = [input.requestedUsdc, input.caps.maxUsdcPerTransfer, remainingRun];
  if (input.advisoryLimitUsdc !== undefined) candidates.push(input.advisoryLimitUsdc);
  const capped = floorUsdc(Math.min(...candidates));
  return capped > 0 ? capped : undefined;
}

function resolveAction(conditions: Condition[]): Action {
  if (conditions.some((condition) => condition.action === "refuse")) return "refuse";
  if (conditions.some((condition) => condition.action === "hold")) return "hold";
  return "proceed";
}

export function decide(input: PolicyInput): PolicyDecision {
  const { proposal, assessment, caps, spentUsdcThisRun, recentPayments, now } = input;
  const conditions = prescreen(proposal, {
    ...(input.agentWallet !== undefined ? { agentWallet: input.agentWallet } : {}),
    ...(input.allowedRecipients !== undefined ? { allowedRecipients: input.allowedRecipients } : {}),
  });

  if (conditions.length > 0) {
    return { action: "refuse", conditions };
  }

  if (assessment === undefined || !assessment.ok) {
    let why = "no decision read was made";
    if (assessment !== undefined) {
      why = `${assessment.simulated ? "SIMULATED " : ""}${assessment.failure.replace("_", " ")}`;
    }
    conditions.push({
      code: "KYRO_UNAVAILABLE",
      action: "refuse",
      message: `no usable Kyro answer (${why}), the gate fails closed`,
    });
    return { action: "refuse", conditions };
  }

  const { decision } = assessment;
  const advisoryLimitUsdc = decision.recommendedLimit.amountUsdc;
  const amount = proposal.amountUsdc;

  if (decision.decision === "block") {
    conditions.push({
      code: "VERDICT_BLOCK",
      action: "refuse",
      message: "Kyro verdict is block",
    });
  } else if (decision.decision === "caution") {
    conditions.push({
      code: "VERDICT_CAUTION",
      action: "hold",
      message: "Kyro verdict is caution, a human decides",
    });
  }

  if (decision.freshness.cacheStatus !== "cached") {
    conditions.push({
      code: "BASELINE_ONLY",
      action: "hold",
      message: `the verdict is a conservative baseline, not committed evidence (freshness ${JSON.stringify(decision.freshness.cacheStatus)})`,
    });
  }

  if (amount > advisoryLimitUsdc) {
    conditions.push({
      code: "OVER_ADVISORY_LIMIT",
      action: "hold",
      message: `${formatUsdc(amount)} is above the advisory limit of ${formatUsdc(advisoryLimitUsdc)}`,
    });
  }

  if (amount > caps.maxUsdcPerTransfer) {
    conditions.push({
      code: "OVER_TRANSFER_CAP",
      action: "hold",
      message: `${formatUsdc(amount)} is above the operator cap of ${formatUsdc(caps.maxUsdcPerTransfer)} per transfer`,
    });
  }

  if (spentUsdcThisRun + amount > caps.maxUsdcPerRun) {
    conditions.push({
      code: "RUN_BUDGET_EXCEEDED",
      action: "hold",
      message: `${formatUsdc(amount)} would take this run past its budget of ${formatUsdc(caps.maxUsdcPerRun)} (${formatUsdc(spentUsdcThisRun)} already approved)`,
    });
  }

  const duplicate = findDuplicate(proposal, recentPayments, now);
  if (duplicate !== undefined) {
    conditions.push({
      code: "DUPLICATE_RECENT",
      action: "hold",
      message: `an identical payment (same recipient and amount) was approved at ${duplicate.at}, inside the ${DUPLICATE_WINDOW_MS / 60_000} minute duplicate window`,
    });
  }

  const action = resolveAction(conditions);
  if (action !== "hold") {
    return { action, conditions };
  }

  const cappedAmountUsdc = cappedAlternative({
    requestedUsdc: amount,
    advisoryLimitUsdc,
    caps,
    spentUsdcThisRun,
  });
  return cappedAmountUsdc === undefined
    ? { action, conditions }
    : { action, conditions, cappedAmountUsdc };
}
