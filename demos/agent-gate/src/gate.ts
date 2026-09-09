/**
 * The gate: for each proposal, pre-screen, read Kyro, apply the operator
 * policy, ask a human on a hold when allowed, record the intent, then hand a
 * proceed to the executor. Everything with a side effect is injected so the
 * tests run it with a fake fetch, a recording executor and a temp audit file.
 *
 * Live mode adds one rule: a proceed gets a Circle idempotency key before
 * its intent line is written and the executor is called exactly once with
 * it. Whatever comes back, the gate never spawns a second time for the same
 * proposal. A later run of the same invoice reuses the key when the last
 * attempt ended unknown, so a manual retry after a reconcile resolves to
 * the same Circle transaction instead of a second payment.
 */
import { randomUUID } from "node:crypto";
import type { AuditLog } from "./audit";
import type { KyroGateway } from "./kyro";
import { DUPLICATE_WINDOW_MS, decide, normaliseAddress, prescreen } from "./policy";
import {
  renderAssessment,
  renderExecution,
  renderHumanAnswer,
  renderKeyReuse,
  renderNotConsulted,
  renderOutcome,
  renderPolicy,
  renderProposal,
  renderSpawn,
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
  /** How long the live executor waits for the CLI; shown next to the command. */
  circleTimeoutMs?: number;
  agentWallet?: string;
  allowedRecipients?: ReadonlySet<string>;
  /** Idempotency key source, injected by tests. Defaults to a random UUID v4. */
  newIdempotencyKey?: () => string;
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
  /** Proceeds that ended as dry-run or submitted. */
  proceeded: number;
  held: number;
  refused: number;
  /** Live proceeds the CLI rejected with nothing moved. */
  failed: number;
  /** Live proceeds without a verified answer; a transfer may have been submitted. */
  unknown: number;
  approvedUsdc: number;
}

/**
 * Thrown when the run dies after at least one live transfer ended unknown.
 * The entry point maps it to exit 4, so an uncertain transfer is never
 * hidden behind the exit 1 of whatever broke afterwards.
 */
export class GateInterruptedError extends Error {
  readonly unknown: number;
  override readonly cause: unknown;

  constructor(cause: unknown, unknown: number) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `the run stopped after ${String(unknown)} live transfer${unknown === 1 ? "" : "s"} ended unknown: ${reason}. ` +
        "Reconcile before running again; the audit log holds the intent and its idempotency key.",
    );
    this.name = "GateInterruptedError";
    this.unknown = unknown;
    this.cause = cause;
  }
}

function isYes(answer: string): boolean {
  const normalised = answer.trim().toLowerCase();
  return normalised === "y" || normalised === "yes";
}

export async function runGate(deps: GateDeps, proposals: Proposal[]): Promise<GateRun> {
  const outcomes: GateOutcome[] = [];
  const inRunPayments: RecentPayment[] = [];
  const newKey = deps.newIdempotencyKey ?? randomUUID;
  let approvedUsdc = 0;
  // Counted before the result line is written, so a crash right after an
  // unknown answer still surfaces as exit 4 through GateInterruptedError.
  let liveUnknowns = 0;

  try {
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

      const to = normaliseAddress(proposal.to);
      const willPay = action === "proceed" && approvedAmountUsdc !== undefined;

      // Live only: fix the idempotency key before the intent line so the log
      // holds it even if the run dies between the spawn and the result.
      let idempotencyKey: string | undefined;
      let keyIntentAt = now.toISOString();
      if (willPay && deps.mode === "live" && approvedAmountUsdc !== undefined) {
        const prior = await deps.audit.lastLiveAttempt(proposal.invoiceId, to, approvedAmountUsdc);
        if (prior !== undefined && prior.state === "unknown") {
          // Circle answers a reused key with the original transaction, so the
          // reconcile window has to start at the intent that first sent it.
          idempotencyKey = prior.idempotencyKey;
          keyIntentAt = prior.intentAt;
          renderKeyReuse(deps.out, idempotencyKey, prior.at);
        } else {
          idempotencyKey = newKey();
        }
      }

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
        idempotencyKey: idempotencyKey ?? null,
      });

      let execution: ExecutionResult | undefined;
      if (willPay && approvedAmountUsdc !== undefined) {
        execution = await deps.executor.transfer(
          {
            to,
            amountUsdc: approvedAmountUsdc,
            from: deps.agentWallet ?? FROM_PLACEHOLDER,
            ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
          },
          {
            onSpawn: (argv) => renderSpawn(deps.out, deps.circleBin, argv, deps.circleTimeoutMs),
          },
        );
        if (execution.state === "unknown") liveUnknowns += 1;
        renderExecution(deps.out, deps.circleBin, execution, {
          agentWallet: deps.agentWallet,
          invoiceId: proposal.invoiceId,
          intentAt: keyIntentAt,
        });
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
          transactionId: execution.state === "submitted" ? execution.transactionId : null,
          idempotencyKey: execution.state === "dry-run" ? null : execution.idempotencyKey,
          exitCode: execution.state === "failed" || execution.state === "unknown" ? execution.exitCode : null,
          errorCode: execution.state === "failed" || execution.state === "unknown" ? execution.errorCode : null,
          detail: execution.state === "failed" || execution.state === "unknown" ? execution.detail : null,
        });
        approvedUsdc += approvedAmountUsdc;
        inRunPayments.push({ to, amountUsdc: approvedAmountUsdc, at: now.toISOString() });
      }

      renderOutcome(deps.out, action, execution, humanApproved);
      outcomes.push({ proposal, assessment, policy, action, approvedAmountUsdc, humanApproved, execution });
    }
  } catch (error) {
    if (liveUnknowns > 0) throw new GateInterruptedError(error, liveUnknowns);
    throw error;
  }

  return {
    outcomes,
    proceeded: outcomes.filter(
      (o) => o.action === "proceed" && (o.execution?.state === "dry-run" || o.execution?.state === "submitted"),
    ).length,
    held: outcomes.filter((o) => o.action === "hold").length,
    refused: outcomes.filter((o) => o.action === "refuse").length,
    failed: outcomes.filter((o) => o.execution?.state === "failed").length,
    unknown: outcomes.filter((o) => o.execution?.state === "unknown").length,
    approvedUsdc,
  };
}
