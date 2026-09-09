/**
 * The Windows spawn path. A global `npm install -g @circle-fin/cli` leaves a
 * `circle.cmd` shim and Node refuses to spawn batch files without a shell
 * (EINVAL). `planSpawn` decides, per platform and suffix, whether the CLI is
 * started directly or through one pre-quoted cmd.exe line, and the executor
 * is driven here with a recording spawn so the whole path runs on any OS
 * without starting a process. Nothing here reaches Circle or Arc.
 */
import assert from "node:assert/strict";
import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { createCircleCliExecutor, planSpawn } from "../src/circle";
import type { TransferRequest } from "../src/types";
import { AGENT, BUILDER, TX_HASH, errorEnvelope, successEnvelope } from "./helpers";

const KEY = "3f2a9c1e-7b4d-4e58-9a0f-2c6d8e1b5a73";
const REQUEST: TransferRequest = { to: BUILDER, amountUsdc: 1.5, from: AGENT, idempotencyKey: KEY };
const ARGV = ["wallet", "transfer", BUILDER, "--amount", "1.5", "--address", AGENT, "--chain", "ARC-TESTNET", "--idempotency-key", KEY, "--output", "json"];

const SHIM = "C:\\Users\\Operator\\AppData\\Roaming\\npm\\circle.cmd";
const SHIM_WITH_SPACES = "C:\\Program Files\\Circle CLI\\circle.cmd";

/** The one line cmd.exe is handed: the quoted shim path, then the argv unchanged. */
function cmdLine(bin: string): string {
  return `""${bin}" ${ARGV.join(" ")}"`;
}

describe("planSpawn", () => {
  it("runs a .cmd CIRCLE_BIN through cmd.exe /d /s /c on win32 with verbatim arguments", () => {
    const plan = planSpawn(SHIM, ARGV, "win32");
    assert.equal(plan.throughCmd, true);
    assert.equal(plan.file, "cmd.exe");
    assert.equal(plan.windowsVerbatimArguments, true);
    assert.deepEqual(plan.args, ["/d", "/s", "/c", cmdLine(SHIM)]);
  });

  it("quotes a shim path with spaces and leaves every argument as built", () => {
    const plan = planSpawn(SHIM_WITH_SPACES, ARGV, "win32");
    assert.deepEqual(plan.args, ["/d", "/s", "/c", cmdLine(SHIM_WITH_SPACES)]);
    const line = plan.args[3] ?? "";
    assert.ok(line.startsWith(`""${SHIM_WITH_SPACES}" wallet transfer `));
    assert.ok(line.endsWith(` --idempotency-key ${KEY} --output json"`));
  });

  it("uses ComSpec for the shell when it is set and accepts .CMD and .bat suffixes", () => {
    const plan = planSpawn("C:\\tools\\CIRCLE.CMD", ARGV, "win32", "C:\\WINDOWS\\system32\\cmd.exe");
    assert.equal(plan.file, "C:\\WINDOWS\\system32\\cmd.exe");
    assert.equal(plan.throughCmd, true);
    assert.equal(planSpawn("circle.bat", ARGV, "win32").throughCmd, true);
    assert.equal(planSpawn("circle.cmd", ARGV, "win32", "   ").file, "cmd.exe");
  });

  it("spawns everything else directly, on win32 and elsewhere", () => {
    for (const [bin, platform] of [
      ["circle", "win32"],
      ["C:\\tools\\circle.exe", "win32"],
      ["C:\\tools\\circle.cmd.exe", "win32"],
      ["/usr/local/bin/circle", "linux"],
      ["/tmp/fake/circle.cmd", "linux"],
      ["circle.cmd", "darwin"],
    ] as const) {
      const plan = planSpawn(bin, ARGV, platform);
      assert.equal(plan.throughCmd, false, bin);
      assert.equal(plan.file, bin);
      assert.equal(plan.windowsVerbatimArguments, false);
      assert.deepEqual(plan.args, ARGV);
    }
  });

  it("refuses a shim path with a character cmd.exe could act on", () => {
    for (const bin of [
      'C:\\tools\\x" & del *.* & "\\circle.cmd',
      "%APPDATA%\\npm\\circle.cmd",
      "C:\\tools\\a|b\\circle.cmd",
      "C:\\tools\\a\r\nb\\circle.cmd",
      "C:\\tools\\a!b\\circle.cmd",
      "C:\\tools\\a^b\\circle.cmd",
    ]) {
      assert.throws(() => planSpawn(bin, ARGV, "win32"), /character cmd\.exe could act on/, bin);
    }
  });

  it("refuses an argument outside the character set the gate builds", () => {
    for (const part of ["1.5 & whoami", "ARC TESTNET", '"json"', "a|b", "x%PATH%y", ""]) {
      const argv = [...ARGV.slice(0, -1), part];
      assert.throws(() => planSpawn(SHIM, argv, "win32"), /outside the character set/, JSON.stringify(part));
    }
  });
});

interface SpawnCall {
  file: string;
  args: string[];
  options: { shell?: boolean; windowsVerbatimArguments?: boolean; windowsHide?: boolean; stdio?: unknown };
}

interface FakeCliScript {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** Raised before "spawn", the way Node reports a binary it cannot start: "error", then "close". */
  spawnError?: NodeJS.ErrnoException;
  /** Thrown from spawn itself, the way Node rejects arguments it will not pass on. */
  throws?: NodeJS.ErrnoException;
  /** Raised after "spawn" and before any output, the way a process that died on the demo reports. */
  lateError?: NodeJS.ErrnoException;
}

/** Records each spawn and plays one scripted answer without starting a process. */
function recordingSpawn(script: FakeCliScript, calls: SpawnCall[]): typeof spawn {
  const impl = (file: string, args: string[], options: SpawnCall["options"]): ChildProcess => {
    calls.push({ file, args, options });
    if (script.throws !== undefined) throw script.throws;
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => boolean; pid?: number };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    setImmediate(() => {
      if (script.spawnError !== undefined) {
        child.emit("error", script.spawnError);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", -2, null));
        return;
      }
      child.pid = 4242;
      child.emit("spawn");
      if (script.lateError !== undefined) {
        child.emit("error", script.lateError);
        child.stdout.end();
        child.stderr.end();
        setImmediate(() => child.emit("close", null, null));
        return;
      }
      if (script.stdout !== undefined) child.stdout.write(script.stdout);
      if (script.stderr !== undefined) child.stderr.write(script.stderr);
      child.stdout.end();
      child.stderr.end();
      setImmediate(() => child.emit("close", script.exitCode ?? 0, null));
    });
    return child as unknown as ChildProcess;
  };
  return impl as unknown as typeof spawn;
}

/** The single recorded spawn, asserted so the count is checked on every path. */
function only(calls: SpawnCall[]): SpawnCall {
  assert.equal(calls.length, 1, "one process start per proceed");
  const call = calls[0];
  assert.ok(call !== undefined);
  return call;
}

function errno(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`spawn ${code}`);
  error.code = code;
  error.errno = -22;
  error.syscall = "spawn";
  return error;
}

describe("createCircleCliExecutor on Windows", () => {
  it("starts a .cmd CIRCLE_BIN once through cmd.exe and reads the answer as usual", async () => {
    const calls: SpawnCall[] = [];
    const executor = createCircleCliExecutor({
      bin: SHIM,
      timeoutMs: 10_000,
      platform: "win32",
      env: { ...process.env, ComSpec: "C:\\WINDOWS\\system32\\cmd.exe" },
      spawnImpl: recordingSpawn({ stdout: successEnvelope(REQUEST) }, calls),
    });
    const spawned: string[][] = [];
    const result = await executor.transfer(REQUEST, { onSpawn: (argv) => spawned.push(argv) });

    assert.equal(calls.length, 1, "one process start per proceed");
    const call = only(calls);
    assert.equal(call.file, "C:\\WINDOWS\\system32\\cmd.exe");
    assert.deepEqual(call.args, ["/d", "/s", "/c", cmdLine(SHIM)]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsVerbatimArguments, true);
    assert.equal(call.options.windowsHide, true);
    assert.deepEqual(call.options.stdio, ["ignore", "pipe", "pipe"]);

    assert.equal(result.state, "submitted");
    if (result.state !== "submitted") return;
    assert.equal(result.txHash, TX_HASH);
    assert.equal(result.idempotencyKey, KEY);
    assert.deepEqual(result.argv, ARGV, "the audit and the output keep the CLI argv, not the cmd.exe line");
    assert.deepEqual(spawned, [ARGV]);
    assert.equal((call.args[3] ?? "").split(`--idempotency-key ${KEY}`).length, 2, "the key is on the cmd.exe line exactly once");
  });

  it("spawns an .exe or bare CIRCLE_BIN directly on win32", async () => {
    const calls: SpawnCall[] = [];
    const executor = createCircleCliExecutor({
      bin: "C:\\tools\\circle.exe",
      timeoutMs: 10_000,
      platform: "win32",
      spawnImpl: recordingSpawn({ stdout: successEnvelope(REQUEST) }, calls),
    });
    const result = await executor.transfer(REQUEST);
    const call = only(calls);
    assert.equal(call.file, "C:\\tools\\circle.exe");
    assert.deepEqual(call.args, ARGV);
    assert.equal(call.options.windowsVerbatimArguments, false);
    assert.equal(result.state, "submitted");
  });

  it("keeps the direct spawn for a .cmd path off Windows", async () => {
    const calls: SpawnCall[] = [];
    const executor = createCircleCliExecutor({
      bin: "/tmp/fake/circle.cmd",
      timeoutMs: 10_000,
      platform: "linux",
      spawnImpl: recordingSpawn({ stdout: successEnvelope(REQUEST) }, calls),
    });
    await executor.transfer(REQUEST);
    const call = only(calls);
    assert.equal(call.file, "/tmp/fake/circle.cmd");
    assert.deepEqual(call.args, ARGV);
    assert.equal(call.options.windowsVerbatimArguments, false);
  });

  it("reads a failure envelope through the cmd.exe path the same way", async () => {
    const calls: SpawnCall[] = [];
    const executor = createCircleCliExecutor({
      bin: SHIM,
      timeoutMs: 10_000,
      platform: "win32",
      spawnImpl: recordingSpawn(
        { stdout: errorEnvelope("INVALID_ARGUMENT", "Invalid recipient address."), stderr: "Error: Invalid recipient address.\n", exitCode: 1 },
        calls,
      ),
    });
    const result = await executor.transfer(REQUEST);
    assert.equal(calls.length, 1);
    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.errorCode, "INVALID_ARGUMENT");
    assert.equal(result.exitCode, 1);
  });

  it("reports EINVAL or ENOENT from a direct spawn as failed with the CIRCLE_BIN hint, nothing paid", async () => {
    for (const [bin, code, script] of [
      ["C:\\Users\\Operator\\AppData\\Roaming\\npm\\circle", "EINVAL", { spawnError: errno("EINVAL") }],
      ["circle", "ENOENT", { spawnError: errno("ENOENT") }],
      ["C:\\tools\\circle", "EINVAL", { throws: errno("EINVAL") }],
    ] as const) {
      const calls: SpawnCall[] = [];
      const executor = createCircleCliExecutor({
        bin,
        timeoutMs: 10_000,
        platform: "win32",
        spawnImpl: recordingSpawn(script, calls),
      });
      const result = await executor.transfer(REQUEST);
      assert.equal(calls.length, 1, bin);
      assert.equal(result.state, "failed", bin);
      if (result.state !== "failed") return;
      assert.equal(result.errorCode, "SPAWN_FAILED");
      assert.equal(
        result.detail,
        `cannot start the Circle CLI: ${code} (on Windows point CIRCLE_BIN at the full path of circle.cmd, what "where circle" prints)`,
      );
      assert.equal(result.exitCode, null);
      assert.equal(result.idempotencyKey, KEY, "the key is reported so the next attempt can reuse it");
    }
  });

  it("settles once when Node follows a spawn error with close, and reports an error after spawn as unknown", async () => {
    const failed = await createCircleCliExecutor({
      bin: SHIM,
      timeoutMs: 10_000,
      platform: "win32",
      spawnImpl: recordingSpawn({ spawnError: errno("ENOENT") }, []),
    }).transfer(REQUEST);
    assert.equal(failed.state, "failed");
    if (failed.state !== "failed") return;
    assert.equal(failed.detail, "cannot start the Circle CLI: ENOENT", "through cmd.exe the plain code stands, the hint is for direct spawns");

    const unknown = await createCircleCliExecutor({
      bin: SHIM,
      timeoutMs: 10_000,
      platform: "win32",
      spawnImpl: recordingSpawn({ lateError: errno("EPERM") }, []),
    }).transfer(REQUEST);
    assert.equal(unknown.state, "unknown");
    if (unknown.state !== "unknown") return;
    assert.match(unknown.detail, /raised EPERM after it started; the transfer may still be in flight/);
    assert.equal(unknown.idempotencyKey, KEY);
  });

  it("leaves the plain code on a spawn failure off Windows", async () => {
    const executor = createCircleCliExecutor({
      bin: "/opt/circle/bin/circle",
      timeoutMs: 10_000,
      platform: "linux",
      spawnImpl: recordingSpawn({ spawnError: errno("ENOENT") }, []),
    });
    const result = await executor.transfer(REQUEST);
    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.detail, "cannot start the Circle CLI: ENOENT");
  });

  it("refuses to build the cmd.exe line for an unsafe shim path before anything starts", async () => {
    const calls: SpawnCall[] = [];
    const executor = createCircleCliExecutor({
      bin: "%APPDATA%\\npm\\circle.cmd",
      timeoutMs: 10_000,
      platform: "win32",
      spawnImpl: recordingSpawn({ stdout: successEnvelope(REQUEST) }, calls),
    });
    const spawned: string[][] = [];
    const result = await executor.transfer(REQUEST, { onSpawn: (argv) => spawned.push(argv) });
    assert.equal(calls.length, 0, "no process start");
    assert.equal(result.state, "failed");
    if (result.state !== "failed") return;
    assert.equal(result.errorCode, "SPAWN_FAILED");
    assert.match(result.detail, /character cmd\.exe could act on/);
    assert.deepEqual(result.argv, ARGV);
    assert.equal(spawned.length, 1, "the command was announced, then refused, as with any spawn failure");
  });
});
