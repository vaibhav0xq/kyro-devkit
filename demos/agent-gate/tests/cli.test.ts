/**
 * End-to-end runs of the real entry point in a child process. Every run here
 * uses --simulate, so no request reaches Kyro and the suite works offline.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tempAuditPath } from "./helpers";

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

  it("--mode live exits 1 with a clear message in this revision", async () => {
    const result = await cli(["--mode", "live"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /live mode is not available in this revision/);
    assert.equal(result.stdout, "");
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
