# ETHOnline 2026 changelog

ETHGlobal judges only event-window work. This file separates what existed
before the hacking window opened from what was built inside it, so nothing
pre-existing is presented as new.

Tracks: Arc, Launch on Arc Testnet and Push to Mainnet (primary). Arc, Best
Agentic Economy with Circle Agent Stack (secondary, same open-source
artifact).

## Pre-existing before 4 September 2026 (disclosed, not judged)

- Kyro live on Arc Testnet at https://www.thekyro.co: wallet check, claimed
  identities with usernames, verified attestations, trust graph, public
  directory, developer page and docs site at https://docs.thekyro.co.
- Frozen public API v1 with 10 operations, anonymous tier, keyed
  tier, versioned envelope, published OpenAPI 3.1 spec.
- Scoring model `identity_score_v1` and decision model `decision_v0.4.1`
  (allow / caution / block with advisory USDC limits for payment, escrow,
  lending and marketplace), batch screening, immutable decision receipts,
  on-demand intake.
- TypeScript SDK `@kyrodev/sdk` 0.1.0 written inside the private repository
  with tests and a dual-format build, published to npm on 25 August 2026
  (https://www.npmjs.com/package/@kyrodev/sdk). The source was not public
  before this repository.
- Dual-chain machinery for an Arc mainnet activation built and dormant behind
  configuration, testnet primary.
- 32 claimed identities on the public directory (count taken 6 September 2026).
- Public build log on the Arc community hub since 26 August 2026
  ("Kyro: Trust before your funds move", then "Kyro build log #2" onward).

Source: the private product repository, not part of this submission.

## Event window, 4 to 16 September 2026 (judged)

- 2026-09-06: Public devkit repository scaffolded (this repository). SDK
  extracted from the private repository into `packages/sdk` with its tests,
  spec check and build intact; public OpenAPI snapshot vendored at
  `spec/kyro-openapi.yaml` with provenance; judge quickstart README; curl,
  Python and TypeScript examples verified against the live API; API one-pager
  and architecture outline; CI workflow.
- 2026-09-06: Correction. An earlier revision of this file and the READMEs
  said `@kyrodev/sdk` was not on npm. It had been published as 0.1.0 on
  25 August 2026, before the window, so the npm release is pre-existing work
  and is not claimed here. The published runtime is byte-identical to this
  repository's build; its type declarations predate the additive interaction
  graph native value fields.
- 2026-09-07: Agent gate demo, dry-run slice, at `demos/agent-gate`. A
  scripted planner proposes USDC invoices on Arc Testnet; each proposal goes
  through a pre-screen, an anonymous Kyro decision read through
  `@kyrodev/sdk`, an operator policy (proceed, hold or refuse with every
  triggered condition named), an optional human approval of a capped amount
  and a JSONL audit log. The executor builds the exact Circle CLI transfer
  command and prints it without running it. Failures to reach Kyro (timeout,
  rate limit, server error, malformed answer) refuse the payment, with
  `--simulate` to reproduce each offline. Tests cover policy precedence,
  the command builder, the gateway, the audit-backed duplicate guard and the
  CLI; they run inside `pnpm run verify`. No live transfer, no receipts and
  no model planner yet; `--mode live` exits with a message.

## Planned inside the window (not yet done, listed so the plan is public)

- Agent gate demo, live slice: the same gate executing real Arc Testnet
  transfers from a fresh agent through the Circle CLI and Agent Wallets,
  decision receipts for the recorded take and the recorded take itself.
- Architecture diagram export and two submission slides.
- Demo video.
- Arc mainnet activation on 16 September 2026 with evidence links (live URL
  serving Arc mainnet and the first verified mainnet attestation
  transaction). Arc accepts mainnet evidence until 30 September 2026.

Entries move from this section to the dated list above only when they ship.
