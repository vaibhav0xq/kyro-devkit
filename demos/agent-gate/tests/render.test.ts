/**
 * The few render paths the gate tests cannot reach: the run summary and the
 * header, which main.ts prints around the gate.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderHeader, renderSummary } from "../src/render";
import type { HeaderInfo, SummaryInfo } from "../src/render";
import { CHAIN } from "../src/types";
import { AGENT, collectOut } from "./helpers";

const header: HeaderInfo = {
  mode: "dry-run",
  tasksPath: "tasks/invoices.example.json",
  invoiceCount: 3,
  chain: CHAIN,
  caps: { maxUsdcPerTransfer: 5, maxUsdcPerRun: 10 },
  baseUrl: "https://www.thekyro.co",
  timeoutMs: 8000,
  minIntervalMs: 1500,
  auditPath: "agent-gate.audit.log",
  agentWallet: AGENT,
  simulate: undefined,
  interactive: false,
  receipts: false,
};

const summary: SummaryInfo = {
  proceeded: 1,
  held: 2,
  refused: 0,
  failed: 0,
  unknown: 0,
  kyroReads: 3,
  simulated: false,
  receipts: { on: false, confirmed: 0, deduped: 0 },
  approvedUsdc: 1.5,
  caps: { maxUsdcPerTransfer: 5, maxUsdcPerRun: 10 },
  mode: "dry-run",
  auditPath: "agent-gate.audit.log",
};

describe("renderHeader", () => {
  it("shows the circle row only in live mode", () => {
    const dry = collectOut();
    renderHeader(dry.out, header);
    assert.match(dry.text(), /^Kyro agent gate \(dry-run\)/);
    assert.doesNotMatch(dry.text(), /^circle\s/m);

    const live = collectOut();
    renderHeader(live.out, { ...header, mode: "live", circle: { bin: "circle", timeoutMs: 240_000 } });
    assert.match(live.text(), /^Kyro agent gate \(live\)/);
    assert.match(live.text(), /^circle\s+circle, one spawn per proceed with its own --idempotency-key, up to 240 s each, never retried$/m);
  });

  it("says whether a proceed mints a receipt and, when off in dry-run, that live turns it on", () => {
    const off = collectOut();
    renderHeader(off.out, header);
    assert.match(off.text(), /^receipts\s+off, no decision receipt is minted \(--receipts on to change that, the default in live mode\)$/m);

    const liveOff = collectOut();
    renderHeader(liveOff.out, { ...header, mode: "live" });
    assert.match(liveOff.text(), /^receipts\s+off, no decision receipt is minted \(--receipts on to change that\)$/m);

    const on = collectOut();
    renderHeader(on.out, { ...header, receipts: true });
    assert.match(on.text(), /^receipts\s+on, a decision receipt is minted for every proceed before anything is paid; no receipt, no payment$/m);
  });
});

describe("renderSummary", () => {
  it("adds failed and unknown counts only when they are non-zero", () => {
    const plain = collectOut();
    renderSummary(plain.out, summary);
    assert.match(plain.text(), /proceeded 1, held 2, refused 0(?!, failed)(?!, unknown)/);

    const mixed = collectOut();
    renderSummary(mixed.out, { ...summary, mode: "live", proceeded: 0, failed: 1, unknown: 1 });
    assert.match(mixed.text(), /proceeded 0, held 2, refused 0, failed 1, unknown 1/);
  });

  it("counts minted receipts only when receipts were on", () => {
    const off = collectOut();
    renderSummary(off.out, summary);
    assert.doesNotMatch(off.text(), /Receipts/);
    assert.match(off.text(), /Kyro reads 3 \(1 anonymous rate unit each\)\. 1\.5 USDC approved/);

    const on = collectOut();
    renderSummary(on.out, { ...summary, receipts: { on: true, confirmed: 2, deduped: 1 } });
    assert.match(on.text(), /Kyro reads 3 \(1 anonymous rate unit each\)\. Receipts 2 \(1 new, 1 deduped\)\. 1\.5 USDC approved/);
  });
});
