# ETHOnline 2026 changelog

ETHGlobal judges only event-window work. This file separates what existed
before the hacking window opened from what was built inside it, so nothing
pre-existing is presented as new.

Track: ETHGlobal Continuity Track. Partner prize: Arc, Best DeFi or Agentic
Application (the Continuity prize), entered on the agentic side with the
agent gate.

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

## Event window, 4 to 13 September 2026 (judged; submissions close 13 September, 12:00 pm EDT)

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
  no model planner yet; `--mode live` exits with a message in this slice.
- 2026-09-07: Architecture diagram exported to `docs/architecture.png`
  (1920x1080) and `docs/architecture@2x.png` (3840x2160). One board, six
  lanes: callers, public surface, engines, evidence, chains and execution
  with the caller's keys, separated by a custody boundary that no Kyro
  component crosses. The agent path from `demos/agent-gate` runs along the
  bottom as caller-side code. Every figure on the board (rate budget,
  operation count, receipt hashing and dedupe, agent gate caps and timeout,
  chain list, model versions) was checked against this repository before
  export. `docs/ARCHITECTURE.md` now embeds the board instead of announcing
  it. Arc Testnet only; Kyro stays advisory and non-custodial.
- 2026-09-09: Agent gate demo, live slice, at `demos/agent-gate`.
  `--mode live` runs the same gate with a real executor: one
  `circle wallet transfer` on ARC-TESTNET per proceed, spawned once, never
  retried. The CLI's JSON envelope is read, not its prose: exit 0 with
  `data.state` CONFIRMED or COMPLETE, a well-formed `data.txHash` and a
  recipient, amount and chain that match the request is `submitted`; an
  error envelope whose `error.code` says nothing moved (AUTH_REQUIRED,
  VERSION_BLOCKED, INVALID_ARGUMENT; INTERNAL with a terminal onchain
  reason) or a binary that cannot start is `failed`; TIMEOUT, anything
  unreadable, a mismatch or a spawn stopped by `CIRCLE_TIMEOUT_MS` is
  `unknown`, which prints the `circle transaction list` reconcile steps and
  exits 4. Every live proceed gets a UUID v4 `--idempotency-key`, written on
  the audit intent line before the spawn and reused only when the previous
  attempt for the same invoice, recipient and amount ended unknown or never
  reported. Live intents now count for the ten-minute duplicate guard, so an
  interrupted run holds the payment. A live run holds an exclusive lock
  next to the audit log so two runs cannot pay the same invoice twice. Live
  needs `AGENT_WALLET_ADDRESS` and refuses `--simulate`; the caps stay
  5 USDC per transfer and 10 per run.
  Dry-run output is unchanged. Tests cover the success and failure
  envelopes, timeout as unknown, key placement and reuse, the no-retry
  rule and the timeout kill, against fixtures and a stand-in CLI script;
  nothing in the suite reaches Circle. No live transfer had been run
  through the gate at this point; the first one is the last entry of this
  list.
- 2026-09-09: Agent gate demo, Windows spawn fix at `demos/agent-gate`. The
  first live attempt on Windows failed before the Circle CLI started:
  `CIRCLE_BIN` pointed at `circle.cmd`, the batch shim a global npm install
  leaves, and Node refuses to spawn batch files without a shell (`EINVAL`,
  CVE-2024-27980). The gate reported `failed` with `SPAWN_FAILED` and nothing
  was paid, as designed. Now a `.cmd` or `.bat` `CIRCLE_BIN` on Windows is
  started through `cmd.exe /d /s /c` with one pre-quoted line built from the
  same argv, after the path is refused for any character cmd.exe acts on and
  every argument is checked against the set the gate produces. Everything
  else is spawned directly as before. Still one process start per proceed,
  same idempotency key, same audit argv; the `EINVAL` and `ENOENT` details on
  Windows now name the `circle.cmd` path to use. Tests drive the executor
  through a recording spawn on every OS. No live transfer had been run at
  this point.
- 2026-09-09: First live transfer through the gate, on Arc Testnet. The same
  day, after the spawn fix, `--mode live --only inv-001` on Windows paid
  1.5 USDC to the inv-001 recipient through the Circle CLI. The CLI reported
  state `COMPLETE` and transaction
  `0xe855692eff6927a7711c7dc483db6b82c4132d29eadbdd63f8a49165fe14f873`
  (https://testnet.arcscan.app/tx/0xe855692eff6927a7711c7dc483db6b82c4132d29eadbdd63f8a49165fe14f873).
  One spawn with the run's own idempotency key, nothing retried; the audit
  log holds the intent and result lines. inv-002 and inv-003 were not run
  live. No code change: this file, the status paragraph of
  `demos/agent-gate/README.md` and one sentence of the root README are the
  only edits.
- 2026-09-11: Correction. Arc replaced its prize list during the event and
  the Launch on Arc Testnet and Push to Mainnet track no longer exists. The
  tracks line above and the README now name the ETHGlobal Continuity Track
  and Arc's Best DeFi or Agentic Application prize. The window heading now
  ends on the submission deadline, 13 September, instead of 16 September,
  which is the mainnet activation date. No code change.
- 2026-09-11: Repository housekeeping, docs only. Root README rewritten
  around a header image, a contents list, a rendered frame of the 7 September
  dry-run (`docs/agent-gate-dry-run.png`, from the same captured output as
  the video), the architecture board, a disclaimers and trademarks section
  and a links table; the claim that every example runs without credentials
  now says read examples and the default dry-run, since live mode needs the
  operator's wallet and Circle CLI session. Added `CONTRIBUTING.md`,
  `SECURITY.md` (email reporting), `.editorconfig` and the AI assistance
  section below. `packages/sdk/README.md` expanded into a
  guide: configuration table, response shapes, error classes and codes,
  timeouts and cancellation, rate limits, low-level requests, the full export
  list and compatibility notes. Root `package.json` gained author, bugs and
  keywords. No code, spec or dependency change; the published 0.1.0 package
  is untouched.

## AI assistance (disclosed)

Replit Agent was used as a coding assistant during the event window:
planning, notes, implementation support and review of code and copy across
this repository, under the maintainer's direction. Design decisions, the
Circle CLI session, the live transfer and the review of every commit were the
maintainer's. The same statement is on the ETHGlobal submission form.

## Planned (not yet done, listed so the plan is public)

- Agent gate demo, next steps: decision receipts inside the run and a
  model-driven planner. The first live transfer is in the dated list above.
- Slides for live judging, if Kyro is selected for round 2.
- Demo video.
- Arc mainnet activation on 16 September 2026, after the submission
  deadline. Arc accepts mainnet evidence until 30 September 2026; the live
  URL serving Arc mainnet and the first verified mainnet attestation
  transaction will be added here when it happens.

Entries move from this section to the dated list above only when they ship.
