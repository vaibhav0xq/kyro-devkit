/**
 * Terminal output. Public API fields only, two vocabularies kept apart:
 * Kyro says allow, caution or block; the operator policy proceeds, holds or
 * refuses. Kyro never moves funds and this output never says it does.
 */
import type { KyroDecision } from "@kyrodev/sdk";
import type {
  Action,
  Assessment,
  Caps,
  Condition,
  ExecutionResult,
  Mode,
  PolicyDecision,
  Proposal,
  ReceiptOutcome,
  SimulationKind,
} from "./types";
import { ARCSCAN_BASE_URL, buildReconcileArgv, formatCommand } from "./circle";
import { DUPLICATE_WINDOW_MS } from "./policy";

export type Out = (line: string) => void;

const LABEL_WIDTH = 12;

function row(label: string, text: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${text}`;
}

function cont(text: string): string {
  return `${"".padEnd(LABEL_WIDTH)}${text}`;
}

export function usdc(amount: number): string {
  return `${Number(amount.toFixed(6))} USDC`;
}

export interface HeaderInfo {
  mode: Mode;
  tasksPath: string;
  invoiceCount: number;
  chain: string;
  caps: Caps;
  baseUrl: string;
  timeoutMs: number;
  minIntervalMs: number;
  auditPath: string;
  agentWallet: string | undefined;
  simulate: SimulationKind | undefined;
  interactive: boolean;
  /** Whether a proceed mints a decision receipt before the executor runs. */
  receipts: boolean;
  /** Live only: the CLI binary and how long each transfer may take. */
  circle?: { bin: string; timeoutMs: number };
}

export function renderHeader(out: Out, info: HeaderInfo): void {
  out(`Kyro agent gate (${info.mode})`);
  out(row("tasks", `${info.tasksPath} (${info.invoiceCount} invoice${info.invoiceCount === 1 ? "" : "s"})`));
  out(row("chain", info.chain));
  out(row("caps", `${usdc(info.caps.maxUsdcPerTransfer)} per transfer, ${usdc(info.caps.maxUsdcPerRun)} per run`));
  out(row("payer", info.agentWallet ?? "not set (AGENT_WALLET_ADDRESS); the printed command carries a placeholder"));
  if (info.circle !== undefined) {
    out(
      row(
        "circle",
        `${info.circle.bin}, one spawn per proceed with its own --idempotency-key, up to ${Math.round(info.circle.timeoutMs / 1000)} s each, never retried`,
      ),
    );
  }
  out(
    row(
      "kyro",
      `${info.baseUrl}, anonymous, timeout ${info.timeoutMs} ms, at least ${info.minIntervalMs} ms between requests`,
    ),
  );
  out(row("audit", info.auditPath));
  if (info.simulate !== undefined) {
    out(row("simulate", `${info.simulate} (SIMULATED: no request reaches Kyro in this run)`));
  }
  out(
    row(
      "receipts",
      info.receipts
        ? "on, a decision receipt is minted for every proceed before anything is paid; no receipt, no payment"
        : `off, no decision receipt is minted (--receipts on to change that${info.mode === "dry-run" ? ", the default in live mode" : ""})`,
    ),
  );
  out(row("human", info.interactive ? "holds prompt for a capped approval" : "holds are not prompted (run with --interactive)"));
  out("");
}

export function renderProposal(out: Out, proposal: Proposal): void {
  const memo = proposal.memo !== undefined && proposal.memo !== "" ? ` (${proposal.memo})` : "";
  out(`${proposal.invoiceId}: ${usdc(proposal.amountUsdc)} to ${proposal.to}${memo}`);
}

function reasonLines(out: Out, label: string, entries: KyroDecision["reasons"]): void {
  if (entries.length === 0) {
    out(row(label, "none"));
    return;
  }
  entries.forEach((entry, index) => {
    const text = `${entry.message} (${entry.code})`;
    out(index === 0 ? row(label, text) : cont(text));
  });
}

export function renderNotConsulted(out: Out): void {
  out(row("kyro", "not consulted, the proposal failed the pre-screen"));
}

export function renderAssessment(out: Out, assessment: Assessment): void {
  const tag = assessment.simulated ? " [SIMULATED]" : "";
  if (!assessment.ok) {
    const retry =
      assessment.retryAfterSeconds !== undefined ? `, retry after ${assessment.retryAfterSeconds} s` : "";
    out(row("kyro", `no usable answer, ${assessment.failure.replace("_", " ")} (${assessment.detail})${retry}${tag}`));
    if (assessment.rateLimit?.remaining !== undefined) {
      out(row("budget", `${assessment.rateLimit.remaining}/${assessment.rateLimit.limit ?? "?"} rate units left this minute${tag}`));
    }
    return;
  }
  const { decision } = assessment;
  const identity = decision.username ? ` (${decision.username})` : "";
  out(row("kyro", `verdict ${decision.decision} for ${decision.useCase}${identity}${tag}`));
  out(
    row(
      "limit",
      `${usdc(decision.recommendedLimit.amountUsdc)} advisory (${decision.recommendedLimit.basis})`,
    ),
  );
  const freshness =
    decision.freshness.cacheStatus === "cached"
      ? `cached, committed evidence${decision.freshness.lastIndexedAt ? `, last indexed ${decision.freshness.lastIndexedAt}` : ""}`
      : `${JSON.stringify(decision.freshness.cacheStatus)}, conservative baseline with no committed evidence`;
  out(row("freshness", freshness));
  out(
    row(
      "score",
      `${decision.score}${decision.riskLevel ? ` (${decision.riskLevel})` : ""}, models ${decision.scoreModelVersion ?? "none"} / ${decision.decisionModelVersion}`,
    ),
  );
  reasonLines(out, "reasons", decision.reasons);
  reasonLines(out, "warnings", decision.warnings);
  if (assessment.rateLimit?.remaining !== undefined) {
    out(row("budget", `${assessment.rateLimit.remaining}/${assessment.rateLimit.limit ?? "?"} rate units left this minute${tag}`));
  }
}

export function renderPolicy(out: Out, policy: PolicyDecision, interactive: boolean): void {
  out(row("policy", policy.action));
  if (policy.conditions.length === 0) {
    out(cont("allow verdict on committed evidence, amount within the advisory limit and the operator caps"));
  }
  for (const condition of policy.conditions) {
    out(cont(`${condition.action}: ${condition.message} (${condition.code})`));
  }
  if (policy.action === "hold") {
    if (policy.cappedAmountUsdc === undefined) {
      out(cont("no capped alternative is available (run budget exhausted)"));
    } else if (interactive) {
      out(cont(`capped alternative ${usdc(policy.cappedAmountUsdc)}, asking a human`));
    } else {
      out(cont(`capped alternative ${usdc(policy.cappedAmountUsdc)} would need a human (run with --interactive)`));
    }
  }
}

export function renderHumanAnswer(out: Out, approved: boolean, amountUsdc: number): void {
  out(row("human", approved ? `approved ${usdc(amountUsdc)}` : "declined, nothing is paid"));
}

/**
 * The receipt step. A minted receipt is shown with its share URL whatever
 * happens next; the condition line, when there is one, names why the proceed
 * became a hold or a refuse.
 */
export function renderReceipt(out: Out, outcome: ReceiptOutcome, condition: Condition | undefined): void {
  if (outcome.ok) {
    const { receipt } = outcome;
    out(row("receipt", `${receipt.id} (${receipt.deduped ? "deduped, same decision state minted earlier today" : "new"}), ${receipt.url}`));
    out(cont(`verdict ${receipt.verdict}, limit ${usdc(receipt.advisoryLimitUsdc)} advisory, payload hash ${receipt.payloadHash}`));
  } else {
    out(row("receipt", "not minted"));
  }
  if (condition !== undefined) {
    out(cont(`${condition.action}: ${condition.message} (${condition.code})`));
  }
  if (outcome.rateLimit?.remaining !== undefined) {
    out(row("budget", `${outcome.rateLimit.remaining}/${outcome.rateLimit.limit ?? "?"} rate units left this minute`));
  }
}

/** Live only: a retry of an invoice whose last attempt ended unknown carries the same key. */
export function renderKeyReuse(out: Out, idempotencyKey: string, priorAt: string): void {
  out(row("idempotency", `reusing key ${idempotencyKey} from the attempt at ${priorAt} that ended unknown`));
}

/** Live only, printed right before the CLI starts so the wait is never silent. */
export function renderSpawn(out: Out, bin: string, argv: string[], timeoutMs: number | undefined): void {
  out(row("executor", formatCommand(bin, argv)));
  const budget = timeoutMs !== undefined ? ` (up to ${Math.round(timeoutMs / 1000)} s)` : "";
  out(cont(`waiting for the Circle CLI, it answers once the transfer reaches a terminal state${budget}`));
}

export interface ExecutionContext {
  /** The paying wallet, used to spell out the reconcile command after an unknown result. */
  agentWallet: string | undefined;
  invoiceId: string;
  /** When the intent line was written; reconcile matches transactions created after it. */
  intentAt: string;
}

export function renderExecution(out: Out, bin: string, execution: ExecutionResult, context?: ExecutionContext): void {
  if (execution.state === "dry-run") {
    out(row("executor", `dry-run, not executed: ${formatCommand(bin, execution.argv)}`));
    return;
  }
  if (execution.state === "submitted") {
    out(row("tx", `${execution.txHash} (${execution.chainState}), ${ARCSCAN_BASE_URL}/tx/${execution.txHash}`));
    out(
      cont(
        `circle transaction id ${execution.transactionId ?? "not reported"}, idempotency key ${execution.idempotencyKey ?? "none"}`,
      ),
    );
    return;
  }
  const code = execution.errorCode !== null ? `${execution.errorCode}, ` : "";
  const exit = `exit ${execution.exitCode ?? "none"}`;
  if (execution.state === "failed") {
    out(row("tx", `failed (${code}${exit}): ${execution.detail}`));
    out(cont("nothing was paid; fix the cause and run again, the next attempt gets a new idempotency key"));
    return;
  }
  out(row("tx", `unknown (${code}${exit}): ${execution.detail}`));
  out(cont("the transfer may still be in flight; reconcile before anything else:"));
  if (context?.agentWallet !== undefined) {
    const to = execution.argv[2] ?? "the recipient";
    const amount = execution.argv[4] ?? "the amount";
    out(cont(formatCommand(bin, buildReconcileArgv(context.agentWallet))));
    out(
      cont(
        `match destinationAddress ${to}, amounts ["${amount}"] and createDate after ${context.intentAt}, then ${ARCSCAN_BASE_URL}/address/${context.agentWallet.toLowerCase()}`,
      ),
    );
  }
  const invoice = context?.invoiceId ?? "this invoice";
  const key = execution.idempotencyKey ?? "none";
  out(
    cont(
      `this run never retries; a later run of ${invoice} is held for ${Math.round(DUPLICATE_WINDOW_MS / 60_000)} minutes and then reuses idempotency key ${key}`,
    ),
  );
}

export function renderOutcome(
  out: Out,
  action: Action,
  execution: ExecutionResult | undefined,
  humanApproved: boolean,
): void {
  if (action === "refuse") {
    out(row("outcome", "refused, no payment"));
  } else if (action === "hold") {
    out(row("outcome", "held, no payment"));
  } else if (execution?.state === "dry-run") {
    out(row("outcome", `proceeded${humanApproved ? " after human approval" : ""}, dry-run so nothing was submitted`));
  } else if (execution?.state === "failed") {
    out(row("outcome", "failed, nothing was paid"));
  } else if (execution?.state === "unknown") {
    out(row("outcome", "unknown, a transfer may have been submitted"));
  } else {
    out(row("outcome", `proceeded${humanApproved ? " after human approval" : ""}`));
  }
  out("");
}

export interface SummaryInfo {
  proceeded: number;
  held: number;
  refused: number;
  failed: number;
  unknown: number;
  kyroReads: number;
  simulated: boolean;
  /** Receipts Kyro confirmed in this run and how many were deduped. Only printed when receipts were on. */
  receipts: { on: boolean; confirmed: number; deduped: number };
  approvedUsdc: number;
  caps: Caps;
  mode: Mode;
  auditPath: string;
}

export function renderSummary(out: Out, summary: SummaryInfo): void {
  const extra = `${summary.failed > 0 ? `, failed ${summary.failed}` : ""}${summary.unknown > 0 ? `, unknown ${summary.unknown}` : ""}`;
  const counts = `proceeded ${summary.proceeded}, held ${summary.held}, refused ${summary.refused}${extra}`;
  const reads = summary.simulated
    ? "Kyro reads 0 (every read in this run was SIMULATED)"
    : `Kyro reads ${summary.kyroReads} (1 anonymous rate unit each)`;
  const receipts = summary.receipts.on
    ? ` Receipts ${summary.receipts.confirmed} (${summary.receipts.confirmed - summary.receipts.deduped} new, ${summary.receipts.deduped} deduped).`
    : "";
  const budget = `${usdc(summary.approvedUsdc)} approved of the ${usdc(summary.caps.maxUsdcPerRun)} run budget`;
  const mode = summary.mode === "dry-run" ? "dry-run, nothing was submitted" : "live";
  out(row("summary", `${counts}. ${reads}.${receipts} ${budget}. Mode ${mode}.`));
  out(row("audit", summary.auditPath));
}
