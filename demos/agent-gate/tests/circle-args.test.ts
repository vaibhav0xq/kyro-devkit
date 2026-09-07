import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FROM_PLACEHOLDER,
  buildTransferArgv,
  createDryRunExecutor,
  formatCommand,
  formatUsdcAmount,
} from "../src/circle";
import { AGENT, BUILDER } from "./helpers";

describe("formatUsdcAmount", () => {
  it("prints plain decimals without trailing zeros or exponents", () => {
    assert.equal(formatUsdcAmount(1.5), "1.5");
    assert.equal(formatUsdcAmount(2), "2");
    assert.equal(formatUsdcAmount(1200), "1200");
    assert.equal(formatUsdcAmount(0.000001), "0.000001");
    assert.equal(formatUsdcAmount(0.1), "0.1");
    assert.equal(formatUsdcAmount(123456.123456), "123456.123456");
  });

  it("refuses amounts the policy would refuse", () => {
    assert.throws(() => formatUsdcAmount(0), RangeError);
    assert.throws(() => formatUsdcAmount(-1), RangeError);
    assert.throws(() => formatUsdcAmount(1.2345678), RangeError);
    assert.throws(() => formatUsdcAmount(Number.NaN), RangeError);
  });
});

describe("buildTransferArgv", () => {
  it("matches the Circle CLI transfer shape exactly", () => {
    assert.deepEqual(buildTransferArgv({ to: BUILDER, amountUsdc: 1.5, from: AGENT }), [
      "wallet",
      "transfer",
      BUILDER,
      "--amount",
      "1.5",
      "--address",
      AGENT,
      "--chain",
      "ARC-TESTNET",
      "--output",
      "json",
    ]);
  });

  it("lower-cases addresses and keeps the placeholder verbatim", () => {
    const argv = buildTransferArgv({ to: BUILDER.toUpperCase().replace("0X", "0x"), amountUsdc: 2, from: FROM_PLACEHOLDER });
    assert.equal(argv[2], BUILDER);
    assert.equal(argv[6], FROM_PLACEHOLDER);
  });

  it("never carries a chain other than ARC-TESTNET", () => {
    const argv = buildTransferArgv({ to: BUILDER, amountUsdc: 1, from: AGENT });
    assert.equal(argv[argv.indexOf("--chain") + 1], "ARC-TESTNET");
  });

  it("rejects malformed recipients and payers", () => {
    assert.throws(() => buildTransferArgv({ to: "0x1234", amountUsdc: 1, from: AGENT }), TypeError);
    assert.throws(() => buildTransferArgv({ to: BUILDER, amountUsdc: 1, from: "wallet-id" }), TypeError);
  });
});

describe("formatCommand", () => {
  it("joins the binary and argv for display", () => {
    assert.equal(formatCommand("circle", ["wallet", "list"]), "circle wallet list");
    assert.equal(formatCommand("/opt/bin/my circle", ["wallet"]), '"/opt/bin/my circle" wallet');
  });
});

describe("dry-run executor", () => {
  it("returns the argv without running anything", async () => {
    const executor = createDryRunExecutor();
    assert.equal(executor.mode, "dry-run");
    const result = await executor.transfer({ to: BUILDER, amountUsdc: 1.5, from: FROM_PLACEHOLDER });
    assert.equal(result.state, "dry-run");
    assert.equal(result.argv.join(" "), `wallet transfer ${BUILDER} --amount 1.5 --address ${FROM_PLACEHOLDER} --chain ARC-TESTNET --output json`);
  });
});
