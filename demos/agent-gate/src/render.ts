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
  ExecutionResult,
  Mode,
  PolicyDecision,
  Proposal,
  SimulationKind,
} from "./types";
import { formatCommand } from "./circle";

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
}

export function renderHeader(out: Out, info: HeaderInfo): void {
  out(`Kyro agent gate (${info.mode})`);
  out(row("tasks", `${info.tasksPath} (${info.invoiceCount} invoice${info.invoiceCount === 1 ? "" : "s"})`));
  out(row("chain", info.chain));
  out(row("caps", `${usdc(info.caps.maxUsdcPerTransfer)} per transfer, ${usdc(info.caps.maxUsdcPerRun)} per run`));
  out(row("payer", info.agentWallet ?? "not set (AGENT_WALLET_ADDRESS); the printed command carries a placeholder"));
  out(
    row(
      "kyro",
      `${info.baseUrl}, anonymous, timeout ${info.timeoutMs} ms, at least ${info.minIntervalMs} ms between reads`,
    ),
  );
  out(row("audit", info.auditPath));
  if (info.simulate !== undefined) {
    out(row("simulate", `${info.simulate} (SIMULATED: no request reaches Kyro in this run)`));
  }
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

export function renderExecution(out: Out, bin: string, execution: ExecutionResult): void {
  const command = formatCommand(bin, execution.argv);
  if (execution.state === "dry-run") {
    out(row("executor", `dry-run, not executed: ${command}`));
    return;
  }
  out(row("executor", command));
  if (execution.state === "submitted") {
    out(row("tx", `${execution.txHash} (${execution.chainState}), https://testnet.arcscan.app/tx/${execution.txHash}`));
    return;
  }
  out(row("tx", `unknown state (exit ${execution.exitCode ?? "none"}): ${execution.detail}`));
  out(cont("verify on the explorer before retrying; the demo never retries on its own"));
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
  unknown: number;
  kyroReads: number;
  simulated: boolean;
  approvedUsdc: number;
  caps: Caps;
  mode: Mode;
  auditPath: string;
}

export function renderSummary(out: Out, summary: SummaryInfo): void {
  const counts = `proceeded ${summary.proceeded}, held ${summary.held}, refused ${summary.refused}${summary.unknown > 0 ? `, unknown ${summary.unknown}` : ""}`;
  const reads = summary.simulated
    ? "Kyro reads 0 (every read in this run was SIMULATED)"
    : `Kyro reads ${summary.kyroReads} (1 anonymous rate unit each)`;
  const budget = `${usdc(summary.approvedUsdc)} approved of the ${usdc(summary.caps.maxUsdcPerRun)} run budget`;
  const mode = summary.mode === "dry-run" ? "dry-run, nothing was submitted" : "live";
  out(row("summary", `${counts}. ${reads}. ${budget}. Mode ${mode}.`));
  out(row("audit", summary.auditPath));
}
