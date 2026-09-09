/**
 * Circle CLI side of the gate.
 *
 * Two executors share one argv builder. The dry-run executor prints the
 * command and runs nothing. The live executor spawns the Circle CLI once
 * per proceed (no shell, stdin closed, the operator's environment passed
 * through) and turns its answer into an ExecutionResult with
 * `interpretTransferOutput`, which is pure so the contract can be tested
 * against fixtures without a CLI or a session.
 *
 * One exception to "no shell": on Windows a global npm install leaves
 * `circle.cmd`, a batch shim, and Node refuses to spawn batch files directly
 * (EINVAL, the CVE-2024-27980 hardening). When CIRCLE_BIN ends in .cmd or
 * .bat on win32, `planSpawn` hands cmd.exe one pre-quoted line built from
 * the same argv, after checking every part against a strict character set.
 * Still one process start per proceed, still the same command.
 *
 * Output contract (Circle CLI 1.0.0, `--output json`):
 * - success: exit 0, stdout `{ "data": { id, state, txHash, blockchain,
 *   destinationAddress, amounts, ... } }`, `state` is terminal (`CONFIRMED`
 *   or `COMPLETE`) because the CLI polls until then;
 * - failure: exit 1, stdout `{ "error": { code, message, hint? } }`, stderr
 *   `Error: <message>`. `TIMEOUT` is printed when the poll budget runs out,
 *   so the transfer may still be in flight. Only `error.code` is machine
 *   readable; the exit code is 1 for every failure class.
 */
import { spawn } from "node:child_process";
import type { ExecutionResult, Executor, TransferHooks, TransferRequest } from "./types";
import { CHAIN } from "./types";
import { isAddress, isValidUsdcAmount, normaliseAddress } from "./policy";

/** Stands in for the paying wallet in dry-run when AGENT_WALLET_ADDRESS is not set. */
export const FROM_PLACEHOLDER = "<AGENT_WALLET_ADDRESS>";

export const ARCSCAN_BASE_URL = "https://testnet.arcscan.app";

/** Terminal states the CLI reports on a 0 exit for a transfer that went through. */
export const SUCCESS_STATES: ReadonlySet<string> = new Set(["CONFIRMED", "COMPLETE"]);

/**
 * Error codes the CLI can only raise before it submits anything: no session,
 * a blocked CLI version or an argument the CLI or the API rejected up front.
 * Every other code, `TIMEOUT` first among them, may have been raised after
 * the transfer left the machine and therefore reads as unknown.
 */
export const FAILED_BEFORE_SUBMIT_CODES: ReadonlySet<string> = new Set([
  "AUTH_REQUIRED",
  "VERSION_BLOCKED",
  "INVALID_ARGUMENT",
]);

/** `INTERNAL` with this message means the transaction reached a terminal failure onchain. */
const TERMINAL_FAILURE_MESSAGE = /^Transaction (failed|cancelled|denied)\b/;

const TX_HASH = /^0x[0-9a-f]{64}$/i;

/** Up to six decimals, no exponent, no trailing zeros. */
export function formatUsdcAmount(amountUsdc: number): string {
  if (!isValidUsdcAmount(amountUsdc)) {
    throw new RangeError(`amount ${String(amountUsdc)} is not a valid USDC amount`);
  }
  return amountUsdc.toFixed(6).replace(/\.?0+$/, "");
}

export function buildTransferArgv(request: TransferRequest): string[] {
  if (!isAddress(request.to)) {
    throw new TypeError(`recipient ${JSON.stringify(request.to)} is not a 0x-prefixed 40-hex address`);
  }
  if (request.from !== FROM_PLACEHOLDER && !isAddress(request.from)) {
    throw new TypeError(`paying wallet ${JSON.stringify(request.from)} is not a 0x-prefixed 40-hex address`);
  }
  const from = request.from === FROM_PLACEHOLDER ? request.from : normaliseAddress(request.from);
  const argv = [
    "wallet",
    "transfer",
    normaliseAddress(request.to),
    "--amount",
    formatUsdcAmount(request.amountUsdc),
    "--address",
    from,
    "--chain",
    CHAIN,
  ];
  if (request.idempotencyKey !== undefined) argv.push("--idempotency-key", request.idempotencyKey);
  argv.push("--output", "json");
  return argv;
}

/**
 * Read-only listing of the agent wallet's outbound transfers, the first step
 * of a reconcile after an unknown result. Returns `{ "data": { "transactions":
 * [ ... ] } }` with the same per-transaction fields as a transfer answer.
 */
export function buildReconcileArgv(agentWallet: string): string[] {
  return [
    "transaction",
    "list",
    "--address",
    normaliseAddress(agentWallet),
    "--chain",
    CHAIN,
    "--operation",
    "transfer",
    "--tx-type",
    "outbound",
    "--output",
    "json",
  ];
}

/** Human-readable command line. Only for display; nothing here reaches a shell. */
export function formatCommand(bin: string, argv: string[]): string {
  return [bin, ...argv].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/** What npm writes for a global install on Windows; Node will not spawn these without a shell. */
const WINDOWS_BATCH_FILE = /\.(cmd|bat)$/i;

/** Characters cmd.exe could act on inside the quoted path it is handed. */
const CMD_UNSAFE_IN_PATH = /["%!^&|<>\r\n\0]/;

/**
 * Every argument the gate builds (subcommands, flags, addresses, a decimal
 * amount, ARC-TESTNET, a UUID, json) is drawn from this set. Anything else
 * never reaches cmd.exe, so nothing on that line is ever interpreted.
 */
const CMD_SAFE_ARGUMENT = /^[A-Za-z0-9._-]+$/;

/** How the CLI is started: the file and arguments handed to child_process.spawn. */
export interface SpawnPlan {
  file: string;
  args: string[];
  /** True only on the cmd.exe path, where the arguments are one pre-quoted line. */
  windowsVerbatimArguments: boolean;
  /** True when a .cmd or .bat CIRCLE_BIN runs through cmd.exe on Windows. */
  throughCmd: boolean;
}

/**
 * Direct spawn everywhere, except a .cmd or .bat CIRCLE_BIN on win32, which
 * goes through `cmd.exe /d /s /c "<"bin" argv...>"` the way Node's own
 * `shell: true` would, minus the unchecked join: the path may not carry a
 * character cmd.exe acts on and every argument must match CMD_SAFE_ARGUMENT.
 * A plan that cannot be built safely is refused before anything starts.
 */
export function planSpawn(
  bin: string,
  argv: string[],
  platform: NodeJS.Platform = process.platform,
  comSpec?: string,
): SpawnPlan {
  if (platform !== "win32" || !WINDOWS_BATCH_FILE.test(bin)) {
    return { file: bin, args: argv, windowsVerbatimArguments: false, throughCmd: false };
  }
  if (CMD_UNSAFE_IN_PATH.test(bin)) {
    throw new TypeError(`CIRCLE_BIN ${JSON.stringify(bin)} has a character cmd.exe could act on; use a plain path to the .cmd shim`);
  }
  const unsafe = argv.find((part) => !CMD_SAFE_ARGUMENT.test(part));
  if (unsafe !== undefined) {
    throw new TypeError(`argument ${JSON.stringify(unsafe)} is outside the character set the demo passes through cmd.exe`);
  }
  const line = [`"${bin}"`, ...argv].join(" ");
  const shell = comSpec?.trim() || "cmd.exe";
  return { file: shell, args: ["/d", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true, throughCmd: true };
}

/** Builds the exact argv a live run would pass to the CLI and returns it unexecuted. */
export function createDryRunExecutor(): Executor {
  return {
    mode: "dry-run",
    async transfer(request: TransferRequest): Promise<ExecutionResult> {
      const argv = buildTransferArgv(request);
      return { state: "dry-run", argv };
    },
  };
}

/** What came back from one CLI invocation, before interpretation. */
export interface CliOutcome {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True when the executor stopped the CLI because CIRCLE_TIMEOUT_MS passed. */
  timedOut: boolean;
  /** Set when the process could not be started at all (for example ENOENT). */
  spawnError?: string;
  /** Set when the process started and then raised an error (for example a failed kill). */
  processError?: string;
}

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

function firstLine(text: string): string | undefined {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part !== "");
  return line;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Explains why a 0 exit is not accepted as a success; undefined when it is. */
function successMismatch(request: TransferRequest, data: Record<string, unknown>): string | undefined {
  const state = data.state;
  if (typeof state !== "string" || !SUCCESS_STATES.has(state)) {
    return `data.state is ${JSON.stringify(state ?? null)}, not CONFIRMED or COMPLETE`;
  }
  const txHash = data.txHash;
  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) {
    return `data.txHash ${JSON.stringify(txHash ?? null)} is not a 32-byte hash`;
  }
  const destination = data.destinationAddress;
  if (typeof destination !== "string" || normaliseAddress(destination) !== normaliseAddress(request.to)) {
    return `data.destinationAddress ${JSON.stringify(destination ?? null)} is not the requested recipient`;
  }
  const amounts = data.amounts;
  const first = Array.isArray(amounts) ? amounts[0] : undefined;
  const amount = typeof first === "string" && first.trim() !== "" ? Number(first) : Number.NaN;
  if (!Number.isFinite(amount) || amount !== request.amountUsdc) {
    return `data.amounts ${JSON.stringify(amounts ?? null)} is not the requested ${formatUsdcAmount(request.amountUsdc)} USDC`;
  }
  // The CLI always prints the chain from the transaction record; a missing
  // one is as unverified as a wrong one.
  const blockchain = data.blockchain;
  if (blockchain !== CHAIN) {
    return `data.blockchain ${JSON.stringify(blockchain ?? null)} is not ${CHAIN}`;
  }
  return undefined;
}

/**
 * Pure mapping from one CLI answer to an ExecutionResult. Anything that is
 * not a verified success or a failure that rules out a transfer is unknown.
 */
export function interpretTransferOutput(
  request: TransferRequest,
  argv: string[],
  outcome: CliOutcome,
): ExecutionResult {
  const idempotencyKey = request.idempotencyKey ?? null;
  const base = { argv, exitCode: outcome.exitCode, idempotencyKey };

  if (outcome.spawnError !== undefined) {
    return { state: "failed", ...base, errorCode: "SPAWN_FAILED", detail: `cannot start the Circle CLI: ${outcome.spawnError}` };
  }
  if (outcome.timedOut) {
    return {
      state: "unknown",
      ...base,
      errorCode: null,
      detail: "no answer before CIRCLE_TIMEOUT_MS passed; the process the demo started was stopped and the transfer may still be in flight",
    };
  }
  if (outcome.processError !== undefined) {
    return {
      state: "unknown",
      ...base,
      errorCode: null,
      detail: `the CLI process raised ${outcome.processError} after it started; the transfer may still be in flight`,
    };
  }

  const envelope = parseJsonObject(outcome.stdout);
  const error = envelope !== undefined && isRecord(envelope.error) ? envelope.error : undefined;
  const data = envelope !== undefined && isRecord(envelope.data) ? envelope.data : undefined;

  if (error !== undefined && data !== undefined) {
    return { state: "unknown", ...base, errorCode: null, detail: "stdout carries both a data and an error object" };
  }

  if (outcome.exitCode === 0) {
    if (data === undefined) {
      const why = envelope === undefined ? "stdout is not a JSON object" : "stdout has no data object";
      return { state: "unknown", ...base, errorCode: null, detail: `exit 0 but ${why}` };
    }
    const mismatch = successMismatch(request, data);
    if (mismatch !== undefined) {
      return { state: "unknown", ...base, errorCode: null, detail: `exit 0 but ${mismatch}` };
    }
    return {
      state: "submitted",
      argv,
      txHash: (data.txHash as string).toLowerCase(),
      chainState: data.state as string,
      transactionId: stringOrNull(data.id),
      idempotencyKey,
    };
  }

  if (outcome.signal !== null && outcome.exitCode === null) {
    return { state: "unknown", ...base, errorCode: null, detail: `the CLI was stopped by ${outcome.signal}` };
  }

  if (error === undefined) {
    const hint = firstLine(outcome.stderr) ?? firstLine(outcome.stdout) ?? "no output";
    return { state: "unknown", ...base, errorCode: null, detail: `exit ${String(outcome.exitCode)} without an error envelope: ${hint}` };
  }

  // A failed verdict needs the full failure contract: exit 1, a code and a
  // message. Anything short of that is an answer this code does not know.
  const code = stringOrNull(error.code);
  const message = stringOrNull(error.message);
  if (outcome.exitCode !== 1) {
    const shown = message ?? "no message";
    return { state: "unknown", ...base, errorCode: code, detail: `exit ${String(outcome.exitCode)} with an error envelope: ${shown}` };
  }
  if (message === null) {
    return { state: "unknown", ...base, errorCode: code, detail: "error envelope without a message" };
  }
  if (code !== null && FAILED_BEFORE_SUBMIT_CODES.has(code)) {
    return { state: "failed", ...base, errorCode: code, detail: `${message} (the CLI stopped before submitting)` };
  }
  if (code === "INTERNAL" && TERMINAL_FAILURE_MESSAGE.test(message)) {
    return { state: "failed", ...base, errorCode: code, detail: `${message} (terminal state, nothing transferred)` };
  }
  return { state: "unknown", ...base, errorCode: code, detail: message };
}

export interface CircleCliExecutorOptions {
  /**
   * Binary name or path, from CIRCLE_BIN. Resolved through PATH by the OS,
   * never a shell, except a .cmd or .bat shim on Windows (see planSpawn).
   */
  bin: string;
  /** How long to wait for the CLI before stopping it and reporting unknown. */
  timeoutMs: number;
  /** Environment for the child; defaults to this process's environment, untouched. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to process.platform. Decides whether a batch shim goes through cmd.exe. Tests set it. */
  platform?: NodeJS.Platform;
  /** Defaults to child_process.spawn. Tests hand in a recorder that never starts a process. */
  spawnImpl?: typeof spawn;
}

/** Grace period between SIGTERM and SIGKILL when the CLI overruns CIRCLE_TIMEOUT_MS. */
const KILL_GRACE_MS = 5_000;

function errorText(error: unknown): string {
  if (isRecord(error)) {
    const code = error.code;
    if (typeof code === "string" && code !== "") return code;
    const message = error.message;
    if (typeof message === "string" && message !== "") return message;
  }
  return String(error);
}

/**
 * On Windows the two ways a direct spawn of the CLI fails before it starts
 * are both about CIRCLE_BIN: EINVAL when it is a batch file reached without
 * the .cmd suffix, ENOENT when a bare name is not found because PATH lookup
 * without a shell does not try .cmd. Say so next to the code.
 */
function spawnErrorText(error: unknown, plan: SpawnPlan, platform: NodeJS.Platform): string {
  const text = errorText(error);
  if (platform === "win32" && !plan.throughCmd && (text === "EINVAL" || text === "ENOENT")) {
    return `${text} (on Windows point CIRCLE_BIN at the full path of circle.cmd, what "where circle" prints)`;
  }
  return text;
}

function runCli(options: CircleCliExecutorOptions, argv: string[]): Promise<CliOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawned = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    const spawnFn = options.spawnImpl ?? spawn;

    let plan: SpawnPlan;
    try {
      plan = planSpawn(options.bin, argv, platform, env.ComSpec);
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: errorText(error) });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      child = spawnFn(plan.file, plan.args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments,
      });
    } catch (error) {
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: spawnErrorText(error, plan, platform) });
      return;
    }
    if (child.stdout === null || child.stderr === null) {
      child.kill("SIGKILL");
      resolve({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: "no stdio pipes" });
      return;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    const finish = (outcome: CliOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      resolve(outcome);
    };

    child.on("spawn", () => {
      spawned = true;
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      // Before "spawn" the binary never started, so nothing was paid. After
      // it, the error is about the process (a kill that failed, for example)
      // and says nothing about the transfer.
      if (!spawned) {
        finish({ exitCode: null, signal: null, stdout, stderr, timedOut, spawnError: spawnErrorText(error, plan, platform) });
      } else {
        finish({ exitCode: null, signal: null, stdout, stderr, timedOut, processError: errorText(error) });
      }
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, stdout, stderr, timedOut });
    });
  });
}

/**
 * Spawns the Circle CLI for a proceed and reports what it answered. One
 * spawn per call, no retry of any kind: a retry is a new proposal the gate
 * has to approve again, with the idempotency key the audit log recorded.
 */
export function createCircleCliExecutor(options: CircleCliExecutorOptions): Executor {
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new RangeError(`CIRCLE_TIMEOUT_MS must be a positive number of milliseconds, got ${String(options.timeoutMs)}`);
  }
  return {
    mode: "live",
    async transfer(request: TransferRequest, hooks?: TransferHooks): Promise<ExecutionResult> {
      if (request.from === FROM_PLACEHOLDER) {
        throw new TypeError("live transfers need the paying wallet address, not the dry-run placeholder");
      }
      if (request.idempotencyKey === undefined) {
        throw new TypeError("live transfers need an idempotency key recorded before the spawn");
      }
      const argv = buildTransferArgv(request);
      hooks?.onSpawn?.(argv);
      const outcome = await runCli(options, argv);
      return interpretTransferOutput(request, argv, outcome);
    },
  };
}
