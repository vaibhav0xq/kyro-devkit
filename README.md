# Kyro devkit

Kyro is a pre-transaction decision layer for wallets on Arc. Before funds
move, a caller checks a wallet and gets an **allow / caution / block** verdict,
an advisory USDC limit for the use case, the evidence behind the answer and an
optional immutable receipt.

This repository is the public developer kit: the TypeScript SDK, the OpenAPI
contract, runnable examples and documentation. The product itself runs at
https://www.thekyro.co.

## Status, stated plainly

- Live on **Arc Testnet** today. Every example in this repository runs against
  the production deployment with no credentials.
- Arc **mainnet** activation is scheduled for 16 September 2026. Until the
  evidence links appear in [`CHANGELOG-ETHONLINE.md`](./CHANGELOG-ETHONLINE.md),
  Kyro is not on mainnet.
- Advisory and non-custodial. Kyro never holds keys or funds and never moves
  them. It does not perform AML screening and does not provide legal,
  sanctions or regulatory compliance determinations.
- Independent community project, no external audit yet. Evidence for young
  wallets is thin by definition and the API says so instead of guessing.

## Try it in 60 seconds

No account, no key, no wallet connection. Anonymous callers get 20 rate units
per minute per IP. Each call below spends one unit; a score read that finds a
known wallet stale can spend five more while it starts a background rescan.

```sh
BASE=https://www.thekyro.co/api/v1
WALLET=0xbb30481982786ea53fe1856e0745eec814d83252

# 1. Score snapshot
curl -s "$BASE/score/$WALLET"

# 2. Decision for a payment: verdict, advisory USDC limit, reasons, evidence, freshness
curl -s "$BASE/decision/$WALLET?useCase=payment"

# 3. The same read for a wallet Kyro has never indexed: a conservative baseline, not a guess
curl -s "$BASE/decision/0x000000000000000000000000000000000000dEaD?useCase=payment"
```

Trimmed answers from 6 September 2026:

```jsonc
// 1. score
{ "ok": true, "version": "v1", "data": {
  "wallet": "0xbb30481982786ea53fe1856e0745eec814d83252",
  "username": "vaibhav_meta.kyro",
  "score": 89, "scoreModelVersion": "identity_score_v1",
  "riskLevel": "Trusted", "badge": "Trusted Wallet Credential",
  "activeChains": ["Ethereum Mainnet", "Base", "Polygon", "Arc Testnet"],
  "cacheStatus": "cached", "lastIndexedAt": "2026-09-05T18:20:44.987Z" } }

// 2. decision, payment
{ "ok": true, "version": "v1", "data": {
  "decision": "allow",
  "recommendedLimit": { "amountUsdc": 1000, "currency": "USDC" },
  "score": 89, "riskLevel": "Trusted",
  // reasons[], warnings[], evidence.used[] and evidence.missing[] trimmed: each entry is a machine-readable code plus a message
  "freshness": { "cacheStatus": "cached" },
  "scoreModelVersion": "identity_score_v1",
  "decisionModelVersion": "decision_v0.4.1" } }

// 3. decision for a never-indexed wallet
{ "ok": true, "version": "v1", "data": {
  "decision": "caution",
  "recommendedLimit": { "amountUsdc": 50, "currency": "USDC" },
  "score": 0, "riskLevel": "High Risk",   // conservative baseline, not observed history
  // reasons[] name the missing evidence; warnings[] carry a not-indexed notice
  "freshness": { "cacheStatus": "indexing_required", "lastIndexedAt": null },
  "decisionModelVersion": "decision_v0.4.1" } }
```

More calls (batch, trust graph, profile, receipts, intake) in
[`examples/curl`](./examples/curl/README.md).

## Use the SDK

```ts
import { Kyro } from "@kyrodev/sdk";

const kyro = new Kyro();
const decision = await kyro.decisions.check(counterparty, { useCase: "payment" });

if (decision.decision === "allow" && amountUsdc <= decision.recommendedLimit.amountUsdc) {
  await sendUsdc(counterparty, amountUsdc);
} else {
  hold(decision.reasons); // caution, block or over the advisory limit
}
```

Install the published package, `@kyrodev/sdk` 0.1.0 on npm (MIT, Node 18.17
or newer, zero runtime dependencies):

```sh
npm install @kyrodev/sdk
# or
pnpm add @kyrodev/sdk
```

The runtime code on npm is byte-identical to the build this repository
produces. The published 0.1.0 type declarations predate the additive
interaction graph native value fields (`metrics.value`, `capabilities.value`);
the declarations built from this repository include them.

To work on the SDK or run the examples from source:

```sh
pnpm install       # Node 20 or newer for the toolchain; the built SDK runs on Node 18.17+
pnpm verify        # spec drift check, typecheck, tests, build, dist smoke
pnpm quickstart    # runs examples/typescript against the live API
```

The SDK wraps all 10 operations with typed methods, a shared error model,
rate-limit metadata and zero runtime dependencies. Details in
[`packages/sdk`](./packages/sdk/README.md).

## Not writing TypeScript?

- [`examples/python/kyro_quickstart.py`](./examples/python/kyro_quickstart.py):
  standard library only, exits 0 / 2 / 3 for proceed / hold / block.
- [`examples/curl/kyro.sh`](./examples/curl/kyro.sh): every operation from the
  shell with argument checks and rate-limit headers.
- [`spec/kyro-openapi.yaml`](./spec/kyro-openapi.yaml): OpenAPI 3.1, feed it
  to any client generator or API client. Provenance in
  [`spec/README.md`](./spec/README.md).
- [`docs/API.md`](./docs/API.md): the whole API on one page.

## Agent gate demo

[`demos/agent-gate`](./demos/agent-gate/README.md) is a small agent that pays
USDC invoices on Arc Testnet through the Circle CLI, with Kyro in the approval
path. A scripted planner proposes each payment, the gate reads the Kyro
decision anonymously, an operator policy turns the verdict into proceed, hold
or refuse and every step lands in an audit log. Kyro never moves funds and
never blocks a transaction; the agent's own policy does.

```bash
pnpm install
pnpm run build
pnpm agent-gate
```

No credentials are needed for the default dry-run: for a proceed it prints
the exact Circle CLI command it would run and executes nothing. The task file
ships three scenes, a claimed identity inside every limit, a wallet Kyro has
never indexed and an amount above the advisory limit. Run
`pnpm agent-gate -- --simulate timeout` to watch the gate fail closed when
Kyro cannot answer. `--mode live` runs the same gate with a real executor:
one Circle CLI transfer per proceed from an agent wallet you control, with an
idempotency key, the CLI's JSON answer read into submitted, failed or unknown
plus reconcile steps printed after an unknown. It needs a Circle CLI testnet
agent session and `AGENT_WALLET_ADDRESS`; the demo README walks through it.
The first live transfer through the gate ran on 9 September 2026 on Arc
Testnet: 1.5 USDC, state `COMPLETE`, transaction
`0xe855692eff6927a7711c7dc483db6b82c4132d29eadbdd63f8a49165fe14f873`;
`CHANGELOG-ETHONLINE.md` has the entry.

## How Kyro decides

- **Score** `identity_score_v1`: 0 to 100 from indexed evidence, with a
  published component breakdown, a risk level and a badge. Deterministic and
  versioned, so the same evidence always yields the same score.
- **Decision** `decision_v0.4.1`: verdict plus an advisory USDC limit for
  `payment`, `escrow`, `lending` or `marketplace`, with machine-readable
  reason and warning codes, the evidence used and missing plus freshness and
  coverage blocks.
- **Receipts**: an immutable record of a decision, hashed, deduped per UTC
  day, readable by anyone with the id.
- **No-score semantics**: a wallet without a committed snapshot gets a
  conservative baseline with `freshness.cacheStatus` of `indexing_required`,
  never a fabricated verdict. Intake indexes it on demand.

Architecture outline: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

## Repository map

```
packages/sdk          @kyrodev/sdk source, tests, build (MIT)
spec/                 OpenAPI 3.1 snapshot of the public contract
examples/curl         copy-paste calls and kyro.sh
examples/python       stdlib quickstart
examples/typescript   SDK quickstart wired to the workspace build
demos/agent-gate      Circle CLI agent with Kyro in the payment approval path
docs/                 API one-pager, architecture outline
CHANGELOG-ETHONLINE.md   pre-existing work versus event-window work
```

## ETHOnline 2026

Submitted on the ETHGlobal Continuity Track to Arc's Best DeFi or Agentic
Application prize, with the agent gate as the agentic case. The dated split
between pre-existing work and event-window work lives in
[`CHANGELOG-ETHONLINE.md`](./CHANGELOG-ETHONLINE.md).

## Links

- Live app: https://www.thekyro.co
- npm package: https://www.npmjs.com/package/@kyrodev/sdk
- Wallet check: https://www.thekyro.co/check
- Developer page: https://www.thekyro.co/developers
- Docs: https://docs.thekyro.co
- OpenAPI spec: https://www.thekyro.co/kyro-openapi.yaml

## License

MIT for everything in this repository unless a directory carries its own
LICENSE file. See [LICENSE](./LICENSE).
