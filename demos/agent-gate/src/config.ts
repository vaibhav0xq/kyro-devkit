/**
 * Flags and environment. Flags win over environment variables, which win
 * over defaults. Dry-run is the default and needs nothing. Live mode needs
 * the paying agent wallet up front and refuses simulated failures: a live
 * run either has what it needs before the first read or it does not start.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Caps, Mode, SimulationKind } from "./types";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const DEFAULTS = {
  mode: "dry-run" as Mode,
  tasksFile: "tasks/invoices.example.json",
  auditFile: "agent-gate.audit.log",
  circleBin: "circle",
  maxUsdcPerTransfer: 5,
  maxUsdcPerRun: 10,
  timeoutMs: 8000,
  minIntervalMs: 1500,
  /** The CLI itself gives up after about 180 s of polling; leave it room to answer. */
  circleTimeoutMs: 240_000,
};

export const SIMULATION_KINDS: readonly SimulationKind[] = ["timeout", "rate_limit", "server_error"];

export interface Flags {
  help: boolean;
  tasks?: string;
  mode?: string;
  only?: string;
  interactive: boolean;
  simulate?: string;
}

export interface Config {
  mode: Mode;
  tasksPath: string;
  only: string | undefined;
  interactive: boolean;
  simulate: SimulationKind | undefined;
  agentWallet: string | undefined;
  circleBin: string;
  /** Live only: how long one Circle CLI spawn may take before it is stopped and reported unknown. */
  circleTimeoutMs: number;
  caps: Caps;
  timeoutMs: number;
  minIntervalMs: number;
  auditLogPath: string;
}

export const USAGE = `Usage: pnpm agent-gate [-- flags]

  --tasks <file>        task file, relative to the current directory (default ${DEFAULTS.tasksFile} in demos/agent-gate)
  --only <invoiceId>    run a single invoice from the task file
  --mode <dry-run|live> dry-run (default) prints the Circle CLI command and runs nothing;
                        live spawns it for every proceed and needs AGENT_WALLET_ADDRESS plus
                        a Circle CLI testnet agent session on this machine
  --simulate <kind>     timeout | rate_limit | server_error: no request reaches Kyro, labelled SIMULATED (dry-run only)
  --interactive         on a hold, ask a human to approve the capped alternative (TTY only)
  --help                this text

Environment (a .env file next to this package is read, existing variables win):
  AGENT_GATE_MODE, AGENT_WALLET_ADDRESS, CIRCLE_BIN, CIRCLE_TIMEOUT_MS, MAX_USDC_PER_TRANSFER,
  MAX_USDC_PER_RUN, KYRO_TIMEOUT_MS, KYRO_MIN_INTERVAL_MS, AGENT_GATE_INTERACTIVE, AGENT_GATE_AUDIT_LOG`;

const VALUE_FLAGS = new Set(["tasks", "mode", "only", "simulate"]);
const BOOLEAN_FLAGS = new Set(["interactive", "help"]);

/** Parses process.argv.slice(2). A leading literal "--" (forwarded by pnpm) is dropped. */
export function parseFlags(argv: readonly string[]): Flags {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const flags: Flags = { help: false, interactive: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (!arg.startsWith("--")) {
      throw new ConfigError(`unexpected argument ${JSON.stringify(arg)}\n\n${USAGE}`);
    }
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOLEAN_FLAGS.has(name)) {
      if (eq !== -1) throw new ConfigError(`--${name} takes no value`);
      if (name === "interactive") flags.interactive = true;
      if (name === "help") flags.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      throw new ConfigError(`unknown flag --${name}\n\n${USAGE}`);
    }
    let value: string | undefined;
    if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else {
      value = args[index + 1];
      index += 1;
    }
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new ConfigError(`--${name} needs a value`);
    }
    if (name === "tasks") flags.tasks = value;
    if (name === "mode") flags.mode = value;
    if (name === "only") flags.only = value;
    if (name === "simulate") flags.simulate = value;
  }
  return flags;
}

/** Minimal .env parser: KEY=value lines, # comments, optional single or double quotes. */
export function parseDotEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    const quoted =
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")));
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      const comment = value.indexOf(" #");
      if (comment !== -1) value = value.slice(0, comment).trim();
    }
    vars[key] = value;
  }
  return vars;
}

/** Loads <dir>/.env into env without overriding variables that are already set. */
export function loadDotEnv(dir: string, env: NodeJS.ProcessEnv): void {
  let text: string;
  try {
    text = readFileSync(resolve(dir, ".env"), "utf8");
  } catch (error) {
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT") return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseDotEnv(text))) {
    if (env[key] === undefined) env[key] = value;
  }
}

function readNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, minimum: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) {
    throw new ConfigError(`${name} must be a number of at least ${minimum}, got ${JSON.stringify(raw)}`);
  }
  return value;
}

function readSwitch(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

function isSimulationKind(value: string): value is SimulationKind {
  return (SIMULATION_KINDS as readonly string[]).includes(value);
}

export function resolveConfig(flags: Flags, env: NodeJS.ProcessEnv, packageDir: string): Config {
  const modeRaw = flags.mode ?? env.AGENT_GATE_MODE?.trim() ?? DEFAULTS.mode;
  if (modeRaw !== "dry-run" && modeRaw !== "live") {
    throw new ConfigError(`mode must be dry-run or live, got ${JSON.stringify(modeRaw)}`);
  }
  const mode: Mode = modeRaw;

  const simulateRaw = flags.simulate;
  if (simulateRaw !== undefined && !isSimulationKind(simulateRaw)) {
    throw new ConfigError(`--simulate must be one of ${SIMULATION_KINDS.join(", ")}, got ${JSON.stringify(simulateRaw)}`);
  }
  const simulate: SimulationKind | undefined = simulateRaw;

  if (mode === "live" && simulate !== undefined) {
    throw new ConfigError("--simulate is refused in live mode; simulated failures are for dry-run only");
  }

  const walletRaw = env.AGENT_WALLET_ADDRESS?.trim();
  let agentWallet: string | undefined;
  if (walletRaw !== undefined && walletRaw !== "") {
    if (!/^0x[0-9a-fA-F]{40}$/.test(walletRaw)) {
      throw new ConfigError("AGENT_WALLET_ADDRESS must be a 0x-prefixed 40-hex address");
    }
    agentWallet = walletRaw.toLowerCase();
  }
  if (mode === "live" && agentWallet === undefined) {
    throw new ConfigError(
      "live mode needs AGENT_WALLET_ADDRESS, the paying agent wallet on ARC-TESTNET (circle wallet list --chain ARC-TESTNET --type agent). Nothing was read or spawned.",
    );
  }

  const maxUsdcPerTransfer = readNumber(env, "MAX_USDC_PER_TRANSFER", DEFAULTS.maxUsdcPerTransfer, 0.000001);
  const maxUsdcPerRun = readNumber(env, "MAX_USDC_PER_RUN", DEFAULTS.maxUsdcPerRun, 0.000001);
  if (maxUsdcPerTransfer > maxUsdcPerRun) {
    throw new ConfigError("MAX_USDC_PER_TRANSFER cannot exceed MAX_USDC_PER_RUN");
  }

  const circleBin = env.CIRCLE_BIN?.trim() || DEFAULTS.circleBin;
  const circleTimeoutMs = readNumber(env, "CIRCLE_TIMEOUT_MS", DEFAULTS.circleTimeoutMs, 1000);

  return {
    mode,
    tasksPath: flags.tasks !== undefined ? resolve(flags.tasks) : resolve(packageDir, DEFAULTS.tasksFile),
    only: flags.only,
    interactive: flags.interactive || readSwitch(env, "AGENT_GATE_INTERACTIVE"),
    simulate,
    agentWallet,
    circleBin,
    circleTimeoutMs,
    caps: { maxUsdcPerTransfer, maxUsdcPerRun },
    timeoutMs: readNumber(env, "KYRO_TIMEOUT_MS", DEFAULTS.timeoutMs, 1),
    minIntervalMs: readNumber(env, "KYRO_MIN_INTERVAL_MS", DEFAULTS.minIntervalMs, 0),
    auditLogPath: resolve(packageDir, env.AGENT_GATE_AUDIT_LOG?.trim() || DEFAULTS.auditFile),
  };
}
