/**
 * The gate: for each proposal, pre-screen, read Kyro, apply the operator
 * policy, ask a human on a hold when allowed, record the intent, then hand a
 * proceed to the executor. Everything with a side effect is injected so the
 * tests run it with a fake fetch, a recording executor and a temp audit file.
 */
import type { AuditLog } from "./audit";
import type { KyroGateway } from "./kyro";
import { DUPLICATE_WINDOW_MS, decide, normaliseAddress, prescreen } from "./policy";
import {
  renderAssessment,
  renderExecution,
  renderHumanAnswer,
  renderNotConsulted,
  renderOutcome,
  renderPolicy,
  renderProposal,
} from "./render";
import type { Out } from "./render";
import type {
  Action,
  Assessment,
  Caps,
  ExecutionResult,
  Executor,
  Mode,
  PolicyDecision,
  Proposal,
  RecentPayment,
} from "./types";
import { FROM_PLACEHOLDER } from "./circle";

export interface GateDeps {
  kyro: KyroGateway;
  executor: Executor;
  audit: AuditLog;
  out: Out;
  /** Present only when a human can answer. Receives the question, returns the raw answer. */
  prompt?: (question: string) => Promise<string>;
  now: () => Date;
  caps: Caps;
  mode: Mode;
  runId: string;
  circleBin: string;
  agentWallet?: string;
  allowedRecipients?: ReadonlySet<string>;
}

export interface GateOutcome {
  proposal: Proposal;
  assessment: Assessment | undefined;
  policy: PolicyDecision;
  action: Action;
  approvedAmountUsdc: number | undefined;
  humanApproved: boolean;
  execution: ExecutionResult | undefined;
}

export interface GateRun {
  outcomes: GateOutcome[];
  proceeded: number;
  held: number;
  refused: number;
  unknown: number;
  approvedUsdc: number;
}

function isYes(answer: string): boolean {
  const normalised = answer.trim().toLowerCase();
  return normalised === "y" || normalised === "yes";
}

export async function runGate(deps: GateDeps, proposals: Proposal[]): Promise<GateRun> {
  const outcomes: GateOutcome[] = [];
  const inRunPayments: RecentPayment[] = [];
  let approvedUsdc = 0;

  for (const proposal of proposals) {
    renderProposal(deps.out, proposal);
    const now = deps.now();

    const screenContext = {
      ...(deps.agentWallet !== undefined ? { agentWallet: deps.agentWallet } : {}),
      ...(deps.allowedRecipients !== undefined ? { allowedRecipients: deps.allowedRecipients } : {}),
    };

    let assessment: Assessment | undefined;
    if (prescreen(proposal, screenContext).length === 0) {
      assessment = await deps.kyro.assess(normaliseAddress(proposal.to));
      renderAssessment(deps.out, assessment);
    } else {
      renderNotConsulted(deps.out);
    }

    const recentPayments = [
      ...(await deps.audit.recentLivePayments(now, DUPLICATE_WINDOW_MS)),
      ...inRunPayments,
    ];
    const policy = decide({
      proposal,
      assessment,
      caps: deps.caps,
      spentUsdcThisRun: approvedUsdc,
      recentPayments,
      now,
      ...screenContext,
    });

    const canAsk = deps.prompt !== undefined && policy.action === "hold" && policy.cappedAmountUsdc !== undefined;
    renderPolicy(deps.out, policy, canAsk);

    let action: Action = policy.action;
    let approvedAmountUsdc: number | undefined = policy.action === "proceed" ? proposal.amountUsdc : undefined;
    let humanApproved = false;
    if (canAsk && deps.prompt !== undefined && policy.cappedAmountUsdc !== undefined) {
      const capped = policy.cappedAmountUsdc;
      const answer = await deps.prompt(
        `approve ${Number(capped.toFixed(6))} USDC to ${normaliseAddress(proposal.to)} for ${proposal.invoiceId}? [y/N] `,
      );
      if (isYes(answer)) {
        action = "proceed";
        approvedAmountUsdc = capped;
        humanApproved = true;
      }
      renderHumanAnswer(deps.out, humanApproved, capped);
    }

    const verdictFields = assessment?.ok
      ? {
          verdict: assessment.decision.decision,
          advisoryLimitUsdc: assessment.decision.recommendedLimit.amountUsdc,
          cacheStatus: assessment.decision.freshness.cacheStatus,
          decisionModelVersion: assessment.decision.decisionModelVersion,
          kyroFailure: null,
        }
      : {
          verdict: null,
          advisoryLimitUsdc: null,
          cacheStatus: null,
          decisionModelVersion: null,
          kyroFailure: assessment === undefined ? null : assessment.failure,
        };

    await deps.audit.append({
      type: "intent",
      at: now.toISOString(),
      runId: deps.runId,
      mode: deps.mode,
      invoiceId: proposal.invoiceId,
      to: proposal.to,
      requestedUsdc: proposal.amountUsdc,
      approvedUsdc: approvedAmountUsdc ?? null,
      action,
      humanApproved,
      conditions: policy.conditions.map((condition) => condition.code),
      ...verdictFields,
      simulated: assessment?.simulated ?? false,
    });

    let execution: ExecutionResult | undefined;
    if (action === "proceed" && approvedAmountUsdc !== undefined) {
      const to = normaliseAddress(proposal.to);
      execution = await deps.executor.transfer({
        to,
        amountUsdc: approvedAmountUsdc,
        from: deps.agentWallet ?? FROM_PLACEHOLDER,
      });
      renderExecution(deps.out, deps.circleBin, execution);
      await deps.audit.append({
        type: "result",
        at: deps.now().toISOString(),
        runId: deps.runId,
        mode: deps.mode,
        invoiceId: proposal.invoiceId,
        to,
        amountUsdc: approvedAmountUsdc,
        state: execution.state,
        argv: execution.argv,
        txHash: execution.state === "submitted" ? execution.txHash : null,
        exitCode: execution.state === "unknown" ? execution.exitCode : null,
        detail: execution.state === "unknown" ? execution.detail : null,
      });
      approvedUsdc += approvedAmountUsdc;
      inRunPayments.push({ to, amountUsdc: approvedAmountUsdc, at: now.toISOString() });
    }

    renderOutcome(deps.out, action, execution, humanApproved);
    outcomes.push({ proposal, assessment, policy, action, approvedAmountUsdc, humanApproved, execution });
  }

  return {
    outcomes,
    proceeded: outcomes.filter((o) => o.action === "proceed" && o.execution?.state !== "unknown").length,
    held: outcomes.filter((o) => o.action === "hold").length,
    refused: outcomes.filter((o) => o.action === "refuse").length,
    unknown: outcomes.filter((o) => o.execution?.state === "unknown").length,
    approvedUsdc,
  };
}
