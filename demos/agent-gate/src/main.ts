/**
 * Kyro agent gate, CLI entry.
 *
 * A scripted planner proposes USDC payments on Arc Testnet. Every proposal
 * passes through the gate: an anonymous Kyro decision read, the operator
 * policy, a decision receipt when receipts are on, an audit line, then the
 * executor. Dry-run, the default, prints the exact Circle CLI command and
 * runs nothing. Live spawns the Circle CLI once per proceed and reports what
 * it answered.
 *
 * Exit codes: 0 the run completed (any mix of proceed, hold and refuse),
 * 1 configuration, task file or lock problem (also a live transfer the
 * Circle CLI rejected with nothing moved), 4 a live transfer ended in an
 * unknown state and needs a reconcile, even when the run died afterwards
 * (neither 1 for a transfer nor 4 is reachable in dry-run).
 *
 * Live runs take an exclusive lock next to the audit log before reading
 * anything, because the duplicate guard and the key reuse read the log and
 * then write it.
 *
 * The `resume` subcommand is the read-only counterpart: it settles live
 * attempts that never got a terminal answer by listing the agent wallet's
 * outbound transfers, writes one resolution line each and transfers
 * nothing. It takes the same lock and exits 4 while any attempt is still
 * unresolved. Without a subcommand nothing about a run changes.
 */
import { randomBytes } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { LiveLockError, acquireLiveLock, createAuditLog, releaseLockQuietly } from "./audit";
import { createCircleCliExecutor, createCircleCliReconciler, createDryRunExecutor } from "./circle";
import { ConfigError, USAGE, loadDotEnv, parseFlags, resolveConfig } from "./config";
import { GateInterruptedError, runGate } from "./gate";
import { KYRO_BASE_URL, createKyroGateway } from "./kyro";
import { TaskFileError, loadTaskList, plan } from "./planners/scripted";
import { renderHeader, renderSummary } from "./render";
import { runResume } from "./resume";
import { CHAIN } from "./types";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

async function ttyPrompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

function displayPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === "" || rel.startsWith("..") ? path : rel;
}

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help) {
    out(USAGE);
    return 0;
  }
  loadDotEnv(PACKAGE_DIR, process.env);
  const config = resolveConfig(flags, process.env, PACKAGE_DIR);

  // resume reads the log and then appends to it, the same read-then-write
  // the duplicate guard does, so it takes the same lock.
  const needsLock = config.mode === "live" || config.command === "resume";
  const lock = needsLock ? await acquireLiveLock(config.auditLogPath) : undefined;
  try {
    return config.command === "resume" ? await resume(config) : await run(config);
  } finally {
    // A failed cleanup must not turn an exit 4 or a GateInterruptedError into exit 1.
    if (lock !== undefined) await releaseLockQuietly(lock, (line) => process.stderr.write(`${line}\n`));
  }
}

/**
 * The read-only half: no planner, no Kyro read, no transfer. It lists the
 * agent wallet's outbound transfers once and records what each unresolved
 * attempt turned out to be. Exit 4 while anything is still unresolved.
 */
async function resume(config: ReturnType<typeof resolveConfig>): Promise<number> {
  const agentWallet = config.agentWallet;
  if (agentWallet === undefined) {
    throw new ConfigError("resume needs AGENT_WALLET_ADDRESS");
  }
  const result = await runResume({
    audit: createAuditLog(config.auditLogPath),
    reconciler: createCircleCliReconciler({ bin: config.circleBin, timeoutMs: config.circleTimeoutMs }),
    out,
    now: () => new Date(),
    runId: newRunId(),
    agentWallet,
    circleBin: config.circleBin,
    circleTimeoutMs: config.circleTimeoutMs,
    auditPath: displayPath(config.auditLogPath),
  });
  return result.stillUnknown > 0 ? 4 : 0;
}

async function run(config: ReturnType<typeof resolveConfig>): Promise<number> {
  const tasks = await loadTaskList(config.tasksPath);
  const proposals = plan(tasks, config.only);

  let prompt: ((question: string) => Promise<string>) | undefined;
  if (config.interactive) {
    if (process.stdin.isTTY) {
      prompt = ttyPrompt;
    } else {
      out("interactive requested but stdin is not a terminal; holds stay held");
    }
  }

  renderHeader(out, {
    mode: config.mode,
    tasksPath: displayPath(config.tasksPath),
    invoiceCount: proposals.length,
    chain: CHAIN,
    caps: config.caps,
    baseUrl: KYRO_BASE_URL,
    timeoutMs: config.timeoutMs,
    minIntervalMs: config.minIntervalMs,
    auditPath: displayPath(config.auditLogPath),
    agentWallet: config.agentWallet,
    simulate: config.simulate,
    interactive: prompt !== undefined,
    receipts: config.receipts,
    ...(config.mode === "live" ? { circle: { bin: config.circleBin, timeoutMs: config.circleTimeoutMs } } : {}),
  });

  const kyro = createKyroGateway({
    timeoutMs: config.timeoutMs,
    minIntervalMs: config.minIntervalMs,
    ...(config.simulate !== undefined ? { simulate: config.simulate } : {}),
  });
  const audit = createAuditLog(config.auditLogPath);
  const executor =
    config.mode === "live"
      ? createCircleCliExecutor({ bin: config.circleBin, timeoutMs: config.circleTimeoutMs })
      : createDryRunExecutor();

  const run = await runGate(
    {
      kyro,
      executor,
      audit,
      out,
      ...(prompt !== undefined ? { prompt } : {}),
      now: () => new Date(),
      caps: config.caps,
      mode: config.mode,
      receipts: config.receipts,
      runId: newRunId(),
      circleBin: config.circleBin,
      circleTimeoutMs: config.circleTimeoutMs,
      ...(config.agentWallet !== undefined ? { agentWallet: config.agentWallet } : {}),
    },
    proposals,
  );

  renderSummary(out, {
    proceeded: run.proceeded,
    held: run.held,
    refused: run.refused,
    failed: run.failed,
    unknown: run.unknown,
    kyroReads: kyro.readsMade,
    simulated: kyro.simulated,
    receipts: { on: config.receipts, confirmed: kyro.receiptsConfirmed, deduped: kyro.receiptsDeduped },
    approvedUsdc: run.approvedUsdc,
    caps: config.caps,
    mode: config.mode,
    auditPath: displayPath(config.auditLogPath),
  });

  if (run.unknown > 0) return 4;
  return run.failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof GateInterruptedError) {
      const cause = error.cause;
      process.stderr.write(`${error.message}\n`);
      process.stderr.write(`${cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)}\n`);
      process.exitCode = 4;
      return;
    }
    if (error instanceof ConfigError || error instanceof TaskFileError || error instanceof LiveLockError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
