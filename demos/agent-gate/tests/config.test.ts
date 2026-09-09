import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { ConfigError, DEFAULTS, loadDotEnv, parseDotEnv, parseFlags, resolveConfig } from "../src/config";
import { parseTaskList, plan } from "../src/planners/scripted";
import { AGENT, BUILDER } from "./helpers";

const PKG = "/pkg";

describe("parseFlags", () => {
  it("defaults to no flags", () => {
    assert.deepEqual(parseFlags([]), { help: false, interactive: false });
  });

  it("drops the leading -- that pnpm forwards", () => {
    assert.deepEqual(parseFlags(["--", "--simulate", "timeout"]), { help: false, interactive: false, simulate: "timeout" });
  });

  it("accepts both --flag value and --flag=value", () => {
    assert.equal(parseFlags(["--tasks", "a.json"]).tasks, "a.json");
    assert.equal(parseFlags(["--tasks=a.json"]).tasks, "a.json");
    assert.equal(parseFlags(["--only=inv-002"]).only, "inv-002");
    assert.equal(parseFlags(["--mode", "live"]).mode, "live");
  });

  it("parses boolean flags", () => {
    assert.equal(parseFlags(["--interactive"]).interactive, true);
    assert.equal(parseFlags(["--help"]).help, true);
  });

  it("rejects unknown flags, bare arguments and missing values", () => {
    assert.throws(() => parseFlags(["--receipts"]), ConfigError);
    assert.throws(() => parseFlags(["live"]), ConfigError);
    assert.throws(() => parseFlags(["--tasks"]), ConfigError);
    assert.throws(() => parseFlags(["--tasks", "--interactive"]), ConfigError);
    assert.throws(() => parseFlags(["--interactive=yes"]), ConfigError);
  });
});

describe("resolveConfig", () => {
  it("runs dry-run with nothing configured", () => {
    const config = resolveConfig(parseFlags([]), {}, PKG);
    assert.equal(config.mode, "dry-run");
    assert.equal(config.simulate, undefined);
    assert.equal(config.agentWallet, undefined);
    assert.equal(config.interactive, false);
    assert.deepEqual(config.caps, { maxUsdcPerTransfer: DEFAULTS.maxUsdcPerTransfer, maxUsdcPerRun: DEFAULTS.maxUsdcPerRun });
    assert.equal(config.timeoutMs, DEFAULTS.timeoutMs);
    assert.equal(config.minIntervalMs, DEFAULTS.minIntervalMs);
    assert.equal(config.tasksPath, resolve(PKG, DEFAULTS.tasksFile));
    assert.equal(config.auditLogPath, resolve(PKG, DEFAULTS.auditFile));
    assert.equal(config.circleBin, "circle");
    assert.equal(config.circleTimeoutMs, DEFAULTS.circleTimeoutMs);
  });

  it("lets flags win over environment", () => {
    const env = { AGENT_GATE_MODE: "dry-run", AGENT_GATE_INTERACTIVE: "0" };
    const config = resolveConfig(parseFlags(["--interactive", "--only", "inv-002"]), env, PKG);
    assert.equal(config.interactive, true);
    assert.equal(config.only, "inv-002");
  });

  it("reads caps, timeouts, the payer and the audit path from the environment", () => {
    const config = resolveConfig(
      parseFlags([]),
      {
        MAX_USDC_PER_TRANSFER: "2.5",
        MAX_USDC_PER_RUN: "4",
        KYRO_TIMEOUT_MS: "300",
        KYRO_MIN_INTERVAL_MS: "0",
        AGENT_WALLET_ADDRESS: AGENT.toUpperCase().replace("0X", "0x"),
        AGENT_GATE_AUDIT_LOG: "logs/run.log",
        AGENT_GATE_INTERACTIVE: "true",
        CIRCLE_BIN: "/opt/circle/bin/circle",
        CIRCLE_TIMEOUT_MS: "90000",
      },
      PKG,
    );
    assert.deepEqual(config.caps, { maxUsdcPerTransfer: 2.5, maxUsdcPerRun: 4 });
    assert.equal(config.timeoutMs, 300);
    assert.equal(config.minIntervalMs, 0);
    assert.equal(config.agentWallet, AGENT);
    assert.equal(config.auditLogPath, resolve(PKG, "logs/run.log"));
    assert.equal(config.interactive, true);
    assert.equal(config.circleBin, "/opt/circle/bin/circle");
    assert.equal(config.circleTimeoutMs, 90_000);
  });

  it("accepts live mode only with the paying wallet configured", () => {
    const config = resolveConfig(parseFlags(["--mode", "live"]), { AGENT_WALLET_ADDRESS: AGENT }, PKG);
    assert.equal(config.mode, "live");
    assert.equal(config.agentWallet, AGENT);
    assert.equal(config.circleTimeoutMs, DEFAULTS.circleTimeoutMs);
    assert.equal(resolveConfig(parseFlags([]), { AGENT_GATE_MODE: "live", AGENT_WALLET_ADDRESS: AGENT }, PKG).mode, "live");

    assert.throws(() => resolveConfig(parseFlags(["--mode", "live"]), {}, PKG), /live mode needs AGENT_WALLET_ADDRESS/);
    assert.throws(() => resolveConfig(parseFlags([]), { AGENT_GATE_MODE: "live", AGENT_WALLET_ADDRESS: " " }, PKG), /live mode needs AGENT_WALLET_ADDRESS/);
  });

  it("refuses simulate in live mode before anything else is checked", () => {
    assert.throws(() => resolveConfig(parseFlags(["--mode", "live", "--simulate", "timeout"]), {}, PKG), /refused in live mode/);
    assert.throws(
      () => resolveConfig(parseFlags(["--mode", "live", "--simulate", "rate_limit"]), { AGENT_WALLET_ADDRESS: AGENT }, PKG),
      /refused in live mode/,
    );
    assert.equal(resolveConfig(parseFlags(["--simulate", "timeout"]), { AGENT_WALLET_ADDRESS: AGENT }, PKG).simulate, "timeout");
  });

  it("rejects bad values loudly", () => {
    assert.throws(() => resolveConfig(parseFlags(["--mode", "test"]), {}, PKG), /mode must be dry-run or live/);
    assert.throws(() => resolveConfig(parseFlags(["--simulate", "outage"]), {}, PKG), /--simulate must be one of/);
    assert.throws(() => resolveConfig(parseFlags([]), { MAX_USDC_PER_TRANSFER: "abc" }, PKG), /MAX_USDC_PER_TRANSFER/);
    assert.throws(() => resolveConfig(parseFlags([]), { MAX_USDC_PER_TRANSFER: "0" }, PKG), /MAX_USDC_PER_TRANSFER/);
    assert.throws(() => resolveConfig(parseFlags([]), { MAX_USDC_PER_TRANSFER: "20", MAX_USDC_PER_RUN: "10" }, PKG), /cannot exceed/);
    assert.throws(() => resolveConfig(parseFlags([]), { KYRO_TIMEOUT_MS: "0" }, PKG), /KYRO_TIMEOUT_MS/);
    assert.throws(() => resolveConfig(parseFlags([]), { CIRCLE_TIMEOUT_MS: "500" }, PKG), /CIRCLE_TIMEOUT_MS must be a number of at least 1000/);
    assert.throws(() => resolveConfig(parseFlags([]), { CIRCLE_TIMEOUT_MS: "soon" }, PKG), /CIRCLE_TIMEOUT_MS/);
    assert.throws(() => resolveConfig(parseFlags([]), { AGENT_WALLET_ADDRESS: "wallet-id-123" }, PKG), /AGENT_WALLET_ADDRESS/);
  });
});

describe("dotenv loading", () => {
  it("parses comments, quotes and export prefixes", () => {
    const parsed = parseDotEnv([
      "# comment",
      "",
      "A=1",
      "B=\"two words\"",
      "C='single'",
      "export D=4 # trailing comment",
      "not a pair",
      "1BAD=x",
    ].join("\n"));
    assert.deepEqual(parsed, { A: "1", B: "two words", C: "single", D: "4" });
  });

  it("never overrides variables that are already set and tolerates a missing file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-gate-env-"));
    const env: NodeJS.ProcessEnv = { MAX_USDC_PER_RUN: "3" };
    loadDotEnv(dir, env);
    assert.deepEqual(env, { MAX_USDC_PER_RUN: "3" });
    await writeFile(join(dir, ".env"), "MAX_USDC_PER_RUN=99\nKYRO_TIMEOUT_MS=250\n");
    loadDotEnv(dir, env);
    assert.deepEqual(env, { MAX_USDC_PER_RUN: "3", KYRO_TIMEOUT_MS: "250" });
  });
});

describe("task file", () => {
  it("parses the example shape and defaults the chain", () => {
    const tasks = parseTaskList({ invoices: [{ id: "a", to: BUILDER, amountUsdc: 1.5, memo: "m" }] }, "t.json");
    assert.equal(tasks.chain, "ARC-TESTNET");
    assert.deepEqual(tasks.invoices, [{ invoiceId: "a", to: BUILDER, amountUsdc: 1.5, memo: "m", chain: "ARC-TESTNET" }]);
  });

  it("keeps a foreign chain so the policy can refuse it", () => {
    const tasks = parseTaskList({ chain: "ARC-MAINNET", invoices: [{ id: "a", to: BUILDER, amountUsdc: 1 }] }, "t.json");
    assert.equal(tasks.invoices[0]?.chain, "ARC-MAINNET");
  });

  it("rejects malformed files before anything runs", () => {
    assert.throws(() => parseTaskList([], "t"), /must be a JSON object/);
    assert.throws(() => parseTaskList({ invoices: [] }, "t"), /non-empty array/);
    assert.throws(() => parseTaskList({ invoices: [{ id: "", to: BUILDER, amountUsdc: 1 }] }, "t"), /id must be/);
    assert.throws(() => parseTaskList({ invoices: [{ id: "a", to: BUILDER, amountUsdc: "1" }] }, "t"), /amountUsdc must be a JSON number/);
    assert.throws(() => parseTaskList({ invoices: [{ id: "a", to: BUILDER, amountUsdc: 1 }, { id: "a", to: BUILDER, amountUsdc: 1 }] }, "t"), /used twice/);
    assert.throws(() => parseTaskList({ chain: 5, invoices: [{ id: "a", to: BUILDER, amountUsdc: 1 }] }, "t"), /chain must be a string/);
  });

  it("selects a single invoice with --only and names the known ids otherwise", () => {
    const tasks = parseTaskList({ invoices: [{ id: "a", to: BUILDER, amountUsdc: 1 }, { id: "b", to: BUILDER, amountUsdc: 2 }] }, "t");
    assert.deepEqual(plan(tasks, "b").map((p) => p.invoiceId), ["b"]);
    assert.equal(plan(tasks, undefined).length, 2);
    assert.throws(() => plan(tasks, "zzz"), /known ids: a, b/);
  });
});
