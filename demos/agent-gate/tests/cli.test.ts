/**
 * End-to-end runs of the real entry point in a child process. Every run here
 * either uses --simulate or stops before the first read, so no request
 * reaches Kyro, nothing is spawned and the suite works offline.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { AGENT, tempAuditPath } from "./helpers";

const run = promisify(execFile);
const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = resolve(PACKAGE_DIR, "src/main.ts");

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  const auditPath = await tempAuditPath();
  const childEnv = {
    ...process.env,
    AGENT_GATE_AUDIT_LOG: auditPath,
    KYRO_TIMEOUT_MS: "50",
    KYRO_MIN_INTERVAL_MS: "0",
    ...env,
  };
  try {
    const { stdout, stderr } = await run(process.execPath, ["--import", "tsx", MAIN, ...args], {
      cwd: PACKAGE_DIR,
      env: childEnv,
      timeout: 60_000,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === "number" ? failed.code : -1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
    };
  }
}

describe("cli", () => {
  it("--help prints usage and exits 0 without touching anything", async () => {
    const result = await cli(["--help"]);
    assert.equal(result.code, 0);
    assert.match(result.stdout, /^Usage: pnpm agent-gate/);
    assert.match(result.stdout, /--simulate <kind>/);
  });

  it("--mode live without AGENT_WALLET_ADDRESS exits 1 before reading or spawning anything", async () => {
    const result = await cli(["--mode", "live"], { AGENT_WALLET_ADDRESS: "" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /live mode needs AGENT_WALLET_ADDRESS/);
    assert.equal(result.stdout, "");
  });

  it("--mode live refuses --simulate", async () => {
    const result = await cli(["--mode", "live", "--simulate", "timeout"], { AGENT_WALLET_ADDRESS: AGENT });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /--simulate is refused in live mode/);
    assert.equal(result.stdout, "");
  });

  it("--mode live runs the gate and refuses a self-payment at the pre-screen without spawning the CLI", async () => {
    const auditPath = await tempAuditPath();
    const tasksPath = join(dirname(auditPath), "self.json");
    await writeFile(
      tasksPath,
      JSON.stringify({ chain: "ARC-TESTNET", invoices: [{ id: "self-001", to: AGENT, amountUsdc: 1, memo: "pays the agent itself" }] }),
      "utf8",
    );
    const result = await cli(["--mode", "live", "--tasks", tasksPath], {
      AGENT_GATE_AUDIT_LOG: auditPath,
      AGENT_WALLET_ADDRESS: AGENT,
      CIRCLE_BIN: join(tmpdir(), "circle-that-does-not-exist"),
      CIRCLE_TIMEOUT_MS: "1000",
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /^Kyro agent gate \(live\)/);
    assert.match(result.stdout, /circle\s+.*circle-that-does-not-exist, one spawn per proceed with its own --idempotency-key, up to 1 s each, never retried/);
    assert.match(result.stdout, /RECIPIENT_IS_AGENT_WALLET/);
    assert.match(result.stdout, /refused, no payment/);
    assert.match(result.stdout, /Kyro reads 0/);
    assert.doesNotMatch(result.stdout, /executor|SPAWN_FAILED|--idempotency-key <|tx\s/);
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] ?? "{}") as { type: string; mode: string; action: string; idempotencyKey: unknown };
    assert.equal(entry.type, "intent");
    assert.equal(entry.mode, "live");
    assert.equal(entry.action, "refuse");
    assert.equal(entry.idempotencyKey, null);
    await assert.rejects(readFile(`${auditPath}.lock`), /ENOENT/);
  });

  it("--mode live exits 1 before reading anything when another live run holds the audit lock", async () => {
    const auditPath = await tempAuditPath();
    const lockPath = `${auditPath}.lock`;
    await writeFile(lockPath, "pid 4242 since 2026-09-07T10:00:00.000Z\n", "utf8");
    const result = await cli(["--mode", "live", "--tasks", join(tmpdir(), "never-read.json")], {
      AGENT_GATE_AUDIT_LOG: auditPath,
      AGENT_WALLET_ADDRESS: AGENT,
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /another live run holds .*\.lock \(pid 4242 since 2026-09-07T10:00:00\.000Z\)/);
    assert.match(result.stderr, /Nothing was read or spawned/);
    assert.equal(result.stdout, "");
    assert.equal(await readFile(lockPath, "utf8"), "pid 4242 since 2026-09-07T10:00:00.000Z\n");
    await assert.rejects(readFile(auditPath), /ENOENT/);
  });

  it("an unknown flag exits 1 and shows usage", async () => {
    const result = await cli(["--receipts"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unknown flag --receipts/);
    assert.match(result.stderr, /Usage:/);
  });

  it("a missing task file exits 1", async () => {
    const result = await cli(["--tasks", "does-not-exist.json"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /cannot read task file/);
  });

  it("--only with an unknown id exits 1 and lists the known ids", async () => {
    const result = await cli(["--only", "inv-999", "--simulate", "server_error"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /known ids: inv-001, inv-002, inv-003/);
  });

  for (const kind of ["timeout", "rate_limit", "server_error"] as const) {
    it(`--simulate ${kind} refuses every scene, labels it SIMULATED and exits 0`, async () => {
      const result = await cli(["--simulate", kind]);
      assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`simulate\\s+${kind} \\(SIMULATED`));
      assert.match(result.stdout, /summary\s+proceeded 0, held 0, refused 3\. Kyro reads 0 \(every read in this run was SIMULATED\)/);
      assert.equal((result.stdout.match(/KYRO_UNAVAILABLE/g) ?? []).length, 3);
      assert.doesNotMatch(result.stdout, /circle wallet transfer/);
      const kyroLines = result.stdout.split("\n").filter((line) => /^kyro\s+no usable|^budget\s|KYRO_UNAVAILABLE/.test(line));
      assert.equal(kyroLines.length, kind === "rate_limit" ? 9 : 6);
      for (const line of kyroLines) assert.match(line, /SIMULATED/, line);
    });
  }

  it("--simulate with --only runs a single scene and writes one intent line", async () => {
    const auditPath = await tempAuditPath();
    const result = await cli(["--simulate", "rate_limit", "--only", "inv-002"], { AGENT_GATE_AUDIT_LOG: auditPath });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /\(1 invoice\)/);
    assert.match(result.stdout, /retry after 30 s \[SIMULATED\]/);
    const lines = (await readFile(auditPath, "utf8")).trim().split("\n");
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] ?? "{}") as { type: string; invoiceId: string; action: string; simulated: boolean };
    assert.equal(entry.type, "intent");
    assert.equal(entry.invoiceId, "inv-002");
    assert.equal(entry.action, "refuse");
    assert.equal(entry.simulated, true);
  });

  it("--interactive without a terminal says so and keeps holds held", async () => {
    const result = await cli(["--simulate", "server_error", "--interactive"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /interactive requested but stdin is not a terminal; holds stay held/);
  });

  it("refuses a bad AGENT_WALLET_ADDRESS before running", async () => {
    const result = await cli(["--simulate", "timeout"], { AGENT_WALLET_ADDRESS: "not-an-address" });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /AGENT_WALLET_ADDRESS must be/);
  });
});
