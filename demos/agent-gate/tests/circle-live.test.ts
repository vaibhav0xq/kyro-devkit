/**
 * The live executor without a Circle session. `interpretTransferOutput` is
 * exercised against fixtures of the CLI 1.0.0 output contract, then the
 * real spawn path runs a stand-in script that answers like the CLI would.
 * Nothing here reaches Circle or Arc.
 */
import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createCircleCliExecutor, interpretTransferOutput } from "../src/circle";
import type { CliOutcome } from "../src/circle";
import type { TransferRequest } from "../src/types";
import { AGENT, BUILDER, CIRCLE_TX_ID, TX_HASH, errorEnvelope, successEnvelope } from "./helpers";

const KEY = "3f2a9c1e-7b4d-4e58-9a0f-2c6d8e1b5a73";
const REQUEST: TransferRequest = { to: BUILDER, amountUsdc: 1.5, from: AGENT, idempotencyKey: KEY };
const ARGV = ["wallet", "transfer", BUILDER, "--amount", "1.5", "--address", AGENT, "--chain", "ARC-TESTNET", "--idempotency-key", KEY, "--output", "json"];

function outcome(overrides: Partial<CliOutcome>): CliOutcome {
  return { exitCode: 1, signal: null, stdout: "", stderr: "", timedOut: false, ...overrides };
}

function ok(stdout: string): CliOutcome {
  return outcome({ exitCode: 0, stdout });
}

function failed(code: string, message: string): CliOutcome {
  return outcome({ exitCode: 1, stdout: errorEnvelope(code, message), stderr: `Error: ${message}\n` });
}

describe("interpretTransferOutput: success envelope", () => {
  it("reads data.state and data.txHash from a CONFIRMED answer", () => {
    const result = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST)));
    assert.equal(result.state, "submitted");
    if (result.state !== "submitted") return;
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.chainState, "CONFIRMED");
    assert.equal(result.transactionId, CIRCLE_TX_ID);
    assert.equal(result.idempotencyKey, KEY);
    assert.deepEqual(result.argv, ARGV);
  });

  it("accepts COMPLETE as the other terminal success and lower-cases the hash", () => {
    const upper = TX_HASH.toUpperCase().replace("0X", "0x");
    const result = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { state: "COMPLETE", txHash: upper })));
    assert.equal(result.state, "submitted");
    if (result.state !== "submitted") return;
    assert.equal(result.chainState, "COMPLETE");
    assert.equal(result.txHash, TX_HASH);
  });

  it("matches the recipient case-insensitively and the amount numerically", () => {
    const shouted = BUILDER.toUpperCase().replace("0X", "0x");
    const result = interpretTransferOutput(
      REQUEST,
      ARGV,
      ok(successEnvelope(REQUEST, { destinationAddress: shouted, amounts: ["1.500000"] })),
    );
    assert.equal(result.state, "submitted");
  });

  it("treats a 0 exit with a non-terminal state as unknown", () => {
    const result = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { state: "SENT" })));
    assert.equal(result.state, "unknown");
    if (result.state !== "unknown") return;
    assert.match(result.detail, /data\.state is "SENT"/);
    assert.equal(result.errorCode, null);
    assert.equal(result.exitCode, 0);
  });

  it("treats a 0 exit whose answer is not the requested payment as unknown", () => {
    const wrongRecipient = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { destinationAddress: AGENT })));
    assert.equal(wrongRecipient.state, "unknown");
    assert.match(wrongRecipient.state === "unknown" ? wrongRecipient.detail : "", /destinationAddress/);

    const wrongAmount = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { amounts: ["15"] })));
    assert.equal(wrongAmount.state, "unknown");
    assert.match(wrongAmount.state === "unknown" ? wrongAmount.detail : "", /amounts/);

    const noHash = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { txHash: null })));
    assert.equal(noHash.state, "unknown");
    assert.match(noHash.state === "unknown" ? noHash.detail : "", /txHash/);

    const shortHash = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { txHash: "0xabc" })));
    assert.equal(shortHash.state, "unknown");

    const otherChain = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { blockchain: "ARC" })));
    assert.equal(otherChain.state, "unknown");
    assert.match(otherChain.state === "unknown" ? otherChain.detail : "", /blockchain/);

    const noChain = interpretTransferOutput(REQUEST, ARGV, ok(successEnvelope(REQUEST, { blockchain: undefined })));
    assert.equal(noChain.state, "unknown");
    assert.match(noChain.state === "unknown" ? noChain.detail : "", /data\.blockchain null is not ARC-TESTNET/);
  });

  it("treats a 0 exit without a data object as unknown", () => {
    assert.equal(interpretTransferOutput(REQUEST, ARGV, ok("")).state, "unknown");
    assert.equal(interpretTransferOutput(REQUEST, ARGV, ok("Transaction confirmed\n")).state, "unknown");
    assert.equal(interpretTransferOutput(REQUEST, ARGV, ok('{"result":"fine"}\n')).state, "unknown");
    assert.equal(interpretTransferOutput(REQUEST, ARGV, ok(errorEnvelope("INTERNAL", "odd"))).state, "unknown");
  });
});

describe("interpretTransferOutput: failure envelope", () => {
  it("maps TIMEOUT to unknown with the code kept", () => {
    const result = interpretTransferOutput(REQUEST, ARGV, failed("TIMEOUT", "Transfer failed or timed out."));
    assert.equal(result.state, "unknown");
    if (result.state !== "unknown") return;
    assert.equal(result.errorCode, "TIMEOUT");
    assert.equal(result.exitCode, 1);
    assert.equal(result.detail, "Transfer failed or timed out.");
    assert.equal(result.idempotencyKey, KEY);
  });

  it("maps errors the CLI raises before submitting to failed", () => {
    for (const [code, message] of [
      ["AUTH_REQUIRED", "No agent session for testnet. Run circle wallet login --testnet."],
      ["VERSION_BLOCKED", "This CLI version is no longer supported."],
      ["INVALID_ARGUMENT", "Invalid amount '1.5x'."],
    ] as const) {
      const result = interpretTransferOutput(REQUEST, ARGV, failed(code, message));
      assert.equal(result.state, "failed", code);
      if (result.state !== "failed") continue;
      assert.equal(result.errorCode, code);
      assert.match(result.detail, /stopped before submitting/);
      assert.equal(result.idempotencyKey, KEY);
    }
  });

  it("maps a terminal onchain failure to failed and every other INTERNAL to unknown", () => {
    const terminal = interpretTransferOutput(REQUEST, ARGV, failed("INTERNAL", "Transaction failed: INSUFFICIENT_FUNDS"));
    assert.equal(terminal.state, "failed");
    assert.match(terminal.state === "failed" ? terminal.detail : "", /nothing transferred/);
    assert.equal(interpretTransferOutput(REQUEST, ARGV, failed("INTERNAL", "Transaction cancelled: by operator")).state, "failed");
    assert.equal(interpretTransferOutput(REQUEST, ARGV, failed("INTERNAL", "Transaction denied: screening")).state, "failed");

    const other = interpretTransferOutput(REQUEST, ARGV, failed("INTERNAL", "Unexpected error: fetch failed"));
    assert.equal(other.state, "unknown");
    assert.equal(other.state === "unknown" ? other.errorCode : null, "INTERNAL");
  });

  it("maps codes that can follow a submission to unknown", () => {
    for (const code of ["PERMISSION_DENIED", "CONFLICT", "NOT_FOUND", "AUTH_EXPIRED", "SOMETHING_NEW"]) {
      const result = interpretTransferOutput(REQUEST, ARGV, failed(code, `${code} happened`));
      assert.equal(result.state, "unknown", code);
      assert.equal(result.state === "unknown" ? result.errorCode : null, code);
    }
  });

  it("treats a non-zero exit without an envelope as unknown and quotes stderr", () => {
    const result = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: 1, stderr: "Error: something odd\n" }));
    assert.equal(result.state, "unknown");
    if (result.state !== "unknown") return;
    assert.equal(result.errorCode, null);
    assert.match(result.detail, /exit 1 without an error envelope: Error: something odd/);
  });

  it("treats a stopped CLI as unknown and a CLI that never started as failed", () => {
    const timedOut = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: null, signal: "SIGTERM", timedOut: true }));
    assert.equal(timedOut.state, "unknown");
    assert.match(timedOut.state === "unknown" ? timedOut.detail : "", /CIRCLE_TIMEOUT_MS/);

    const signalled = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: null, signal: "SIGKILL" }));
    assert.equal(signalled.state, "unknown");
    assert.match(signalled.state === "unknown" ? signalled.detail : "", /SIGKILL/);

    const missing = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: null, spawnError: "ENOENT" }));
    assert.equal(missing.state, "failed");
    if (missing.state !== "failed") return;
    assert.equal(missing.errorCode, "SPAWN_FAILED");
    assert.match(missing.detail, /ENOENT/);
  });

  it("treats an error raised after the process started as unknown, never as nothing paid", () => {
    const late = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: null, processError: "EPERM" }));
    assert.equal(late.state, "unknown");
    if (late.state !== "unknown") return;
    assert.equal(late.errorCode, null);
    assert.match(late.detail, /raised EPERM after it started; the transfer may still be in flight/);

    // A kill that fails during the timeout keeps the timeout wording.
    const both = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: null, timedOut: true, processError: "EPERM" }));
    assert.equal(both.state, "unknown");
    assert.match(both.state === "unknown" ? both.detail : "", /CIRCLE_TIMEOUT_MS/);
  });

  it("only calls a failure envelope failed when it exits 1 and carries a message", () => {
    const wrongExit = interpretTransferOutput(
      REQUEST,
      ARGV,
      outcome({ exitCode: 2, stdout: errorEnvelope("AUTH_REQUIRED", "No agent session for testnet.") }),
    );
    assert.equal(wrongExit.state, "unknown");
    if (wrongExit.state !== "unknown") return;
    assert.equal(wrongExit.errorCode, "AUTH_REQUIRED");
    assert.match(wrongExit.detail, /exit 2 with an error envelope: No agent session for testnet\./);

    const noMessage = interpretTransferOutput(REQUEST, ARGV, outcome({ exitCode: 1, stdout: '{"error":{"code":"AUTH_REQUIRED"}}' }));
    assert.equal(noMessage.state, "unknown");
    assert.match(noMessage.state === "unknown" ? noMessage.detail : "", /without a message/);

    const contradictory = interpretTransferOutput(
      REQUEST,
      ARGV,
      outcome({
        exitCode: 1,
        stdout: JSON.stringify({ data: JSON.parse(successEnvelope(REQUEST)).data, error: { code: "AUTH_REQUIRED", message: "x" } }),
      }),
    );
    assert.equal(contradictory.state, "unknown");
    assert.match(contradictory.state === "unknown" ? contradictory.detail : "", /both a data and an error object/);

    const contradictoryOk = interpretTransferOutput(
      REQUEST,
      ARGV,
      outcome({
        exitCode: 0,
        stdout: JSON.stringify({ data: JSON.parse(successEnvelope(REQUEST)).data, error: { code: "INTERNAL", message: "x" } }),
      }),
    );
    assert.equal(contradictoryOk.state, "unknown");
  });
});

/**
 * A stand-in for the Circle CLI: records its argv, prints a canned stdout,
 * exits with a chosen code or sleeps until it is stopped.
 */
async function fakeCircle(): Promise<{ bin: string; argsFile: string; stdoutFile: string; env: NodeJS.ProcessEnv }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-circle-"));
  const bin = join(dir, "circle");
  const argsFile = join(dir, "argv.txt");
  const stdoutFile = join(dir, "stdout.txt");
  const script = [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > "$FAKE_CIRCLE_ARGS"',
    'if [ -n "$FAKE_CIRCLE_HANG" ]; then exec sleep 60; fi',
    'cat "$FAKE_CIRCLE_STDOUT"',
    'if [ -n "$FAKE_CIRCLE_STDERR" ]; then printf "%s\\n" "$FAKE_CIRCLE_STDERR" >&2; fi',
    'exit "${FAKE_CIRCLE_EXIT:-0}"',
    "",
  ].join("\n");
  await writeFile(bin, script, "utf8");
  await chmod(bin, 0o755);
  await writeFile(stdoutFile, "", "utf8");
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_CIRCLE_ARGS: argsFile, FAKE_CIRCLE_STDOUT: stdoutFile };
  return { bin, argsFile, stdoutFile, env };
}

const posixOnly = { skip: process.platform === "win32" ? "the stand-in CLI is a POSIX shell script" : false };

describe("createCircleCliExecutor", () => {
  it("refuses to start without a paying wallet or an idempotency key", async () => {
    const executor = createCircleCliExecutor({ bin: "circle-that-does-not-exist", timeoutMs: 1000 });
    assert.equal(executor.mode, "live");
    await assert.rejects(executor.transfer({ to: BUILDER, amountUsdc: 1, from: "<AGENT_WALLET_ADDRESS>", idempotencyKey: KEY }), TypeError);
    await assert.rejects(executor.transfer({ to: BUILDER, amountUsdc: 1, from: AGENT }), TypeError);
    assert.throws(() => createCircleCliExecutor({ bin: "circle", timeoutMs: 0 }), RangeError);
  });

  it("reports failed, not unknown, when the binary cannot be started", async () => {
    const executor = createCircleCliExecutor({ bin: join(tmpdir(), "circle-that-does-not-exist"), timeoutMs: 1000 });
    const result = await executor.transfer(REQUEST);
    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.errorCode, "SPAWN_FAILED");
    assert.match(result.detail, /ENOENT/);
  });

  it("spawns once with the idempotency key and reads a success envelope", posixOnly, async () => {
    const fake = await fakeCircle();
    await writeFile(fake.stdoutFile, successEnvelope(REQUEST), "utf8");
    const executor = createCircleCliExecutor({ bin: fake.bin, timeoutMs: 10_000, env: fake.env });
    const spawned: string[][] = [];
    const result = await executor.transfer(REQUEST, { onSpawn: (argv) => spawned.push(argv) });

    assert.equal(result.state, "submitted");
    if (result.state !== "submitted") return;
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.chainState, "CONFIRMED");
    assert.equal(spawned.length, 1);
    const seen = (await readFile(fake.argsFile, "utf8")).trim().split("\n");
    assert.deepEqual(seen, ARGV);
    assert.equal(seen[seen.indexOf("--idempotency-key") + 1], KEY);
  });

  it("reads a TIMEOUT envelope as unknown without spawning again", posixOnly, async () => {
    const fake = await fakeCircle();
    await writeFile(fake.stdoutFile, errorEnvelope("TIMEOUT", "Transfer failed or timed out."), "utf8");
    const executor = createCircleCliExecutor({
      bin: fake.bin,
      timeoutMs: 10_000,
      env: { ...fake.env, FAKE_CIRCLE_EXIT: "1", FAKE_CIRCLE_STDERR: "Error: Transfer failed or timed out." },
    });
    let spawns = 0;
    const result = await executor.transfer(REQUEST, {
      onSpawn: () => {
        spawns += 1;
      },
    });
    assert.equal(spawns, 1);
    assert.equal(result.state, "unknown");
    if (result.state !== "unknown") return;
    assert.equal(result.errorCode, "TIMEOUT");
    assert.equal(result.exitCode, 1);
  });

  it("stops a CLI that overruns CIRCLE_TIMEOUT_MS and reports unknown", posixOnly, async () => {
    const fake = await fakeCircle();
    const executor = createCircleCliExecutor({ bin: fake.bin, timeoutMs: 300, env: { ...fake.env, FAKE_CIRCLE_HANG: "1" } });
    const started = Date.now();
    const result = await executor.transfer(REQUEST);
    assert.ok(Date.now() - started < 10_000, "the executor must not wait for the child's own exit");
    assert.equal(result.state, "unknown");
    if (result.state !== "unknown") return;
    assert.equal(result.errorCode, null);
    assert.match(result.detail, /CIRCLE_TIMEOUT_MS/);
    assert.match(result.detail, /may still be in flight/);
  });
});
