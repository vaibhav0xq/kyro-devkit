/**
 * Kyro agent gate, CLI entry.
 *
 * A scripted planner proposes USDC payments on Arc Testnet. Every proposal
 * passes through the gate: an anonymous Kyro decision read, the operator
 * policy, an audit line, then the executor. In this revision the only
 * executor is dry-run: it prints the exact Circle CLI command and runs
 * nothing.
 *
 * Exit codes: 0 the run completed (any mix of proceed, hold and refuse),
 * 1 configuration or task file problem, 4 a live transfer ended in an
 * unknown state (not reachable in dry-run).
 */
import { randomBytes } from "node:crypto";
import { dirname, relative, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createAuditLog } from "./audit";
import { createDryRunExecutor } from "./circle";
import { ConfigError, USAGE, loadDotEnv, parseFlags, resolveConfig } from "./config";
import { runGate } from "./gate";
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
  });

  const kyro = createKyroGateway({
    timeoutMs: config.timeoutMs,
    minIntervalMs: config.minIntervalMs,
    ...(config.simulate !== undefined ? { simulate: config.simulate } : {}),
  });
  const audit = createAuditLog(config.auditLogPath);
  const executor = createDryRunExecutor();

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
      ...(config.agentWallet !== undefined ? { agentWallet: config.agentWallet } : {}),
    },
    proposals,
  );

  renderSummary(out, {
    proceeded: run.proceeded,
    held: run.held,
    refused: run.refused,
    unknown: run.unknown,
    kyroReads: kyro.readsMade,
    simulated: kyro.simulated,
    approvedUsdc: run.approvedUsdc,
    caps: config.caps,
    mode: config.mode,
    auditPath: displayPath(config.auditLogPath),
  });

  return run.unknown > 0 ? 4 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    if (error instanceof ConfigError || error instanceof TaskFileError) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    }
    process.exitCode = 1;
  },
);
