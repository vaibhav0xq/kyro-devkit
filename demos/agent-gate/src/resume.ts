/**
 * `resume`: settle live attempts the log never got a terminal answer for.
 *
 * It reads. It does not pay. The only command it runs is the read-only
 * transaction listing, once, however many attempts are open, and the only
 * thing it writes is a resolution line per attempt. Nothing already in the
 * log is edited and no transfer is ever retried from here: a retry is a new
 * proposal the gate has to approve again.
 *
 * An attempt that stays unknown keeps the run at exit 4, the same code a
 * live run uses for an uncertain transfer, so an unresolved payment is
 * never hidden behind a successful-looking exit.
 */
import type { AuditLog } from "./audit";
import type { Reconciler } from "./circle";
import { interpretReconcileOutput } from "./reconcile";
import { renderResumeAttempt, renderResumeHeader, renderResumeSpawn, renderResumeSummary } from "./render";
import type { Out } from "./render";
import { CHAIN } from "./types";

export const RESOLUTION_SOURCE = "circle transaction list";

export interface ResumeDeps {
  audit: AuditLog;
  reconciler: Reconciler;
  out: Out;
  now: () => Date;
  runId: string;
  agentWallet: string;
  circleBin: string;
  circleTimeoutMs?: number;
  auditPath: string;
}

export interface ResumeRun {
  checked: number;
  confirmed: number;
  failed: number;
  stillUnknown: number;
}

export async function runResume(deps: ResumeDeps): Promise<ResumeRun> {
  const attempts = await deps.audit.unresolvedLiveAttempts();

  renderResumeHeader(deps.out, {
    agentWallet: deps.agentWallet,
    auditPath: deps.auditPath,
    chain: CHAIN,
    circleBin: deps.circleBin,
    unresolved: attempts.length,
  });

  // Nothing open means nothing to ask the provider. A resume on a settled
  // log spawns no process and writes no line, so running it twice is free.
  if (attempts.length === 0) {
    return { checked: 0, confirmed: 0, failed: 0, stillUnknown: 0 };
  }

  // One listing answers every open attempt; they share a wallet and a chain.
  const { outcome } = await deps.reconciler.list(deps.agentWallet, {
    onSpawn: (argv) => renderResumeSpawn(deps.out, deps.circleBin, argv, deps.circleTimeoutMs),
  });

  const run: ResumeRun = { checked: attempts.length, confirmed: 0, failed: 0, stillUnknown: 0 };

  for (const attempt of attempts) {
    const result = interpretReconcileOutput(attempt, deps.agentWallet, outcome);
    renderResumeAttempt(deps.out, attempt, result);

    if (result.outcome === "confirmed") run.confirmed += 1;
    else if (result.outcome === "failed") run.failed += 1;
    else run.stillUnknown += 1;

    // Written after the interpretation, never before it, so a line in the
    // log is always a conclusion that was actually reached.
    await deps.audit.append({
      type: "resolution",
      at: deps.now().toISOString(),
      runId: deps.runId,
      mode: "live",
      invoiceId: attempt.invoiceId,
      to: attempt.to,
      amountUsdc: attempt.amountUsdc,
      idempotencyKey: attempt.idempotencyKey,
      outcome: result.outcome,
      transactionId: result.outcome === "unknown" ? null : result.transactionId,
      txHash: result.outcome === "confirmed" ? result.txHash : null,
      source: RESOLUTION_SOURCE,
      detail: result.detail,
    });
  }

  renderResumeSummary(deps.out, { ...run, auditPath: deps.auditPath });
  return run;
}
