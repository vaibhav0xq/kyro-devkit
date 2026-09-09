/**
 * Kyro agent gate, CLI entry.
 *
 * A scripted planner proposes USDC payments on Arc Testnet. Every proposal
 * passes through the gate: an anonymous Kyro decision read, the operator
 * policy, an audit line, then the executor. Dry-run, the default, prints the
 * exact Circle CLI command and runs nothing. Live spawns the Circle CLI once
 * per proceed and reports what it answered.
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
 */
import { randomBytes } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { LiveLockError, acquireLiveLock, createAuditLog, releaseLockQuietly } from "./audit";
import { createCircleCliExecutor, createDryRunExecutor } from "./circle";
import { ConfigError, USAGE, loadDotEnv, parseFlags, resolveConfig } from "./config";
import { GateInterruptedError, runGate } from "./gate";
import { createKyroGateway } from "./kyro";
import { TaskFileError, loadTaskList, plan } from "./planners/scripted";
import { renderHeader, renderSummary } from "./render";
import { CHAIN } from "./types";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const KYRO_BASE_URL = "https://www.thekyro.co";

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

  const lock = config.mode === "live" ? await acquireLiveLock(config.auditLogPath) : undefined;
  try {
    return await run(config);
  } finally {
    // A failed cleanup must not turn an exit 4 or a GateInterruptedError into exit 1.
    if (lock !== undefined) await releaseLockQuietly(lock, (line) => process.stderr.write(`${line}\n`));
  }
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
