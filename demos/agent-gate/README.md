# Agent gate

An agent that pays USDC invoices on Arc Testnet through the Circle CLI, with
Kyro in the approval path. Every payment the planner proposes passes through
one gate before anything is submitted:

```
planner  ->  pre-screen  ->  Kyro decision read  ->  operator policy  ->  audit  ->  executor
             (no network)    (anonymous, 1 unit)    (proceed / hold / refuse)         (Circle CLI)
```

Kyro answers with a verdict (allow, caution or block), an advisory USDC limit,
reasons, warnings and freshness. The agent's own policy decides what to do
with that. Kyro never moves funds and never blocks a transaction.

Two modes. **Dry-run**, the default, needs no credentials: for a proceed the
executor builds the exact Circle CLI command and prints it without running it.
**Live** spawns that command through the Circle CLI on the operator's machine,
once per proceed with an idempotency key, then reports what the CLI answered.
Everything before the executor is the same code in both modes.

**Status: the first live transfer through this gate ran on 9 September 2026
on Arc Testnet.** `--mode live --only inv-001` on Windows paid 1.5 USDC to the
inv-001 recipient through the Circle CLI, which reported state `COMPLETE` and
transaction
`0xe855692eff6927a7711c7dc483db6b82c4132d29eadbdd63f8a49165fe14f873`
([explorer](https://testnet.arcscan.app/tx/0xe855692eff6927a7711c7dc483db6b82c4132d29eadbdd63f8a49165fe14f873)).
One spawn with the run's own idempotency key, nothing retried; inv-002 and
inv-003 have not been run live. The test suite still uses a stand-in binary
and never reaches Circle. Decision receipts and a model-driven planner remain
planned, see [`CHANGELOG-ETHONLINE.md`](../../CHANGELOG-ETHONLINE.md).

## Run it

From the repository root, no credentials needed:

```bash
pnpm install
pnpm run build          # builds @kyrodev/sdk, which the demo imports from the workspace
pnpm agent-gate
```

Three scenes in [`tasks/invoices.example.json`](./tasks/invoices.example.json):

| Invoice | What it is | Kyro says | Policy does |
| --- | --- | --- | --- |
| inv-001 | 1.5 USDC to a claimed identity with committed evidence | allow, inside the advisory limit | proceed, prints the command |
| inv-002 | 2 USDC to a wallet Kyro has never indexed | caution, `indexing_required` baseline | hold |
| inv-003 | 1200 USDC to the same identity as inv-001 | allow, above the advisory limit | hold, offers a capped alternative |

A run costs three anonymous rate units against the live API.

Watch the gate fail closed without touching the network:

```bash
pnpm agent-gate -- --simulate timeout        # also rate_limit, server_error
pnpm agent-gate -- --only inv-002            # one scene
pnpm agent-gate -- --interactive             # a human may approve the capped amount on a hold
pnpm agent-gate -- --help
```

Simulated failures make no real read and say so wherever they surface: the
header, the Kyro line, the refusing condition and the summary. Flags and environment variables are listed by `--help` and in
[`.env.example`](./.env.example); flags win over the environment, the
environment wins over defaults. A `.env` file next to this README is read
without overriding variables that are already set.

## Live mode

Live mode is the same gate with a real executor. Nothing about the read, the
policy or the audit changes; what changes is that a proceed becomes one
`circle wallet transfer` on ARC-TESTNET, paid from an agent wallet the
operator controls. Kyro is not in the payment: it answered a read, the
operator policy decided and the Circle CLI moved the USDC.

### Requirements

- Circle CLI 1.0.0 or later on this machine (`npm install -g @circle-fin/cli`),
  its terms accepted and a testnet agent session
  (`circle wallet login <email> --type agent --testnet`). Mainnet and testnet
  sessions are separate; `circle wallet status` shows both. Accepting the
  terms and the telemetry choice are the operator's; the demo never sets
  `CIRCLE_ACCEPT_TERMS`, `DO_NOT_TRACK` or `CIRCLE_VERSION_CHECK` on your
  behalf. Export them yourself if you want a non-interactive run.
- `AGENT_WALLET_ADDRESS`: the agent wallet's address on ARC-TESTNET (from
  `circle wallet list --chain ARC-TESTNET --type agent`; run
  `circle wallet create --testnet` if none is listed, without `--testnet`
  the CLI creates mainnet wallets). Live mode refuses to start without it,
  before the first read.
- Testnet USDC in that wallet
  (`circle wallet fund --address <AGENT_WALLET_ADDRESS> --chain ARC-TESTNET`
  drips from the Circle faucet). Gas on Arc is paid in USDC too.
- A task file whose recipients you control. The shipped example pays a real
  claimed identity in `inv-001`; `inv-002` pays `0x...dead`, a burn address
  that is there to be held, not paid. Replace it before a live run.
- One live run at a time per audit log. Live mode takes an exclusive lock
  (`agent-gate.audit.log.lock` next to the log) before it reads anything and
  removes it when the run ends, because the duplicate guard and the key
  reuse read the log and then write it. A second live run exits 1 and names
  the holder. If a run was killed and the file is left behind, check that no
  run is active, then delete it.

### Windows

`npm install -g @circle-fin/cli` on Windows leaves `circle.cmd`, a batch
shim, and Node refuses to start batch files without a shell (`EINVAL`, its
CVE-2024-27980 hardening). Point `CIRCLE_BIN` at the shim's full path, what
`where circle` prints, for example
`C:\Users\<you>\AppData\Roaming\npm\circle.cmd`. A bare `circle` is not
found from Node on Windows (`ENOENT`) because PATH lookup without a shell
does not try `.cmd`; the demo says so in the failure.

When `CIRCLE_BIN` ends in `.cmd` or `.bat` on Windows the demo starts it
through `cmd.exe /d /s /c` with one pre-quoted line: the shim path in double
quotes, then the same arguments dry-run prints. Before that line is built the
path is refused if it holds a character cmd.exe acts on (`" % ! ^ & | < >`),
and every argument is checked against the set the gate produces (letters,
digits, `.`, `_`, `-`); anything else is a `failed` spawn with nothing
started. It is still one process start per proceed with the same idempotency
key, and the audit log still records the CLI argv, not the cmd.exe line.
Anything that is not a batch file, on Windows or elsewhere, is spawned
directly as before.

One difference to know: if a run through the shim overruns
`CIRCLE_TIMEOUT_MS`, the demo stops cmd.exe, not the CLI's own Node process
underneath, which may keep running; the demo then waits for it to end (it
holds the output pipes) before reporting, so the timeout is not a hard
deadline on Windows. The result is `unknown` either way, the key stays with
the intent and nothing is retried; reconcile as described below before
running again.

### Manual preflight

The demo does not probe the CLI before a run; do these yourself once:

```bash
circle --version
circle wallet list --chain ARC-TESTNET --type agent --output json
circle wallet balance --address <AGENT_WALLET_ADDRESS> --chain ARC-TESTNET --output json
```

Then:

```bash
AGENT_WALLET_ADDRESS=0x... pnpm agent-gate -- --mode live --only inv-001
```

`--simulate` is refused in live mode; simulated failures are for dry-run.

### What a live proceed prints

```
executor    circle wallet transfer 0xbb30...3252 --amount 1.5 --address 0x1a1a...1a1a --chain ARC-TESTNET --idempotency-key 3f2a9c1e-... --output json
            waiting for the Circle CLI, it answers once the transfer reaches a terminal state (up to 240 s)
tx          0xabab...abab (CONFIRMED), https://testnet.arcscan.app/tx/0xabab...abab
            circle transaction id 7f1e2d3c-..., idempotency key 3f2a9c1e-...
outcome     proceeded
```

The CLI's JSON envelope is read, not its prose. A transfer counts as
`submitted` only when the CLI exits 0 with `data.state` of `CONFIRMED` or
`COMPLETE`, a well-formed `data.txHash` plus a `destinationAddress`,
`amounts` and `blockchain` that match the request. Anything else is one of
two other states:

- `failed`: the CLI said nothing moved. It exited 1 with an error envelope
  whose code is `AUTH_REQUIRED`, `VERSION_BLOCKED` or `INVALID_ARGUMENT`; or
  `INTERNAL` with a terminal onchain reason (`Transaction failed|cancelled|denied`);
  or the binary could not be started at all. Fix the cause and run again; the
  next attempt gets a new idempotency key.
- `unknown`: the CLI answered `TIMEOUT` (it stopped waiting, the transfer may
  still be in flight); or it printed anything the demo cannot read, including
  an error envelope with a different exit code or no message; or it was
  stopped by `CIRCLE_TIMEOUT_MS`; or it exited 0 with an answer that does not
  match the request. The demo does not retry. It prints the reconcile steps
  and exits 4 at the end of the run, also when the run itself dies afterwards.

Each proceed is exactly one spawn. There is no automatic retry in any state.

### Idempotency

Every live proceed gets a UUID v4 idempotency key, written on the audit
`intent` line before the CLI starts and passed as `--idempotency-key`, so
Circle deduplicates a request it may already have. The key is per payment
intent, not per run: when a later run reaches the same invoice, recipient and
amount and the last live attempt ended `unknown` (or wrote an intent and no
result, an interrupted run), the earlier key is reused and the output says
so. After `submitted` or `failed` a fresh key is used. A different amount or
recipient is a different intent with its own key. Dry-run never carries a
key and its output is unchanged.

### Reconcile after an unknown

An unknown means the demo does not know whether USDC moved. Before running
again, look:

```bash
circle transaction list --address <AGENT_WALLET_ADDRESS> --chain ARC-TESTNET --operation transfer --tx-type outbound --output json
```

Match `destinationAddress`, `amounts[0]` and a `createDate` after the time on
the intent line, then confirm on
`https://testnet.arcscan.app/address/<AGENT_WALLET_ADDRESS>`. The demo prints
this command, the values to match and the explorer link under every unknown.
A repeat of the same payment is held by the duplicate guard for ten minutes
after the intent (the intent alone counts, so an interrupted run holds too).
After that a run reuses the idempotency key rather than inventing one, and
its reconcile hint keeps the time of the intent that first sent the key,
because Circle answers a reused key with the original transaction.

### Caps

`MAX_USDC_PER_TRANSFER` (default 5) and `MAX_USDC_PER_RUN` (default 10) apply
in both modes and are enforced by the policy before the executor. Circle
spending policies are mainnet only, so these caps are the only limits between
the planner and the wallet. Keep them small on testnet too.

## What the policy does

The verdict is Kyro's. The action is the operator's. They are never the same
word on purpose.

Refused before any read, so never sent to Kyro:

- the task file names a chain other than `ARC-TESTNET`
- the recipient is not a 0x-prefixed 40-hex address
- the recipient is the agent wallet itself
- the recipient is not on the task list (for planners that pick recipients)
- the amount is not a finite number above zero with at most six decimals

Refused after the read:

- Kyro gave no usable answer: timeout, rate limit, server error, network
  failure or a malformed payload. The gate fails closed, it never guesses.
- the verdict is block

Held (a human may approve a capped amount with `--interactive`):

- the verdict is caution
- the answer is a baseline, `freshness.cacheStatus` other than `cached`,
  so there is no committed evidence behind it
- the amount is above Kyro's advisory limit
- the amount is above `MAX_USDC_PER_TRANSFER` (default 5)
- the amount would take the run past `MAX_USDC_PER_RUN` (default 10)
- an identical payment (same recipient, same amount) went through the gate
  inside the last ten minutes, in this run or as a live intent or result in the
  audit log

Refuse beats hold beats proceed. Every triggered condition is printed, not
only the winning one. The capped alternative offered on a hold is the smallest
of the requested amount, the advisory limit, the per-transfer cap and what is
left of the run budget.

The operator caps live in the agent because Circle spending policies are
mainnet only.

## Audit log

Every proposal appends an `intent` line to `agent-gate.audit.log` (JSONL,
gitignored) once its action is final: the request, the verdict and advisory
limit, freshness, the decision model version, the action, every condition,
whether a human approved and, for a live proceed, the idempotency key
(`null` otherwise). Every executor call appends a `result` line with the
argv and, in live mode, the state (`submitted`, `failed` or `unknown`), the
transaction hash, the Circle transaction id, the error code and the key.
Dry-run results never count as payments for the duplicate guard, because
nothing moved. Live intents and results all do, including `failed` and
`unknown`, because the guard would rather hold once too often than pay twice.

## Exit codes

- `0`: the run completed, whatever the mix of proceed, hold and refuse
- `1`: configuration, task file or lock problem, printed to stderr; or, in
  live mode, at least one transfer the Circle CLI rejected with nothing moved
- `4`: at least one live transfer ended in an unknown state and needs the
  reconcile steps above (wins over 1, kept even if the run dies before its
  summary; not reachable in dry-run)

## Layout

```
src/main.ts              entry: flags, env, wiring, exit codes
src/config.ts            flags, environment, .env loader
src/planners/scripted.ts task file loader and validation
src/kyro.ts              decision read through @kyrodev/sdk, throttle, failure mapping, simulations
src/policy.ts            pre-screen, decision, capped alternative (pure)
src/circle.ts            Circle CLI argv builder, the dry-run executor, the live executor and its output reader
src/audit.ts             JSONL audit log and the duplicate-guard reader
src/gate.ts              the loop that ties them together
src/render.ts            terminal output
tests/                   node:test, run with pnpm test here or pnpm run verify at the root
```

## Tests

```bash
pnpm --filter @kyro-devkit/agent-gate test
```

The suite is offline: a queue-based fake fetch stands in for the API, the
CLI tests spawn the real entry point with `--simulate` or stop it at the
pre-screen and the audit log goes to a temporary directory. The live
executor is tested against fixtures of the Circle CLI 1.0.0 JSON output
(success envelope, error envelope, timeout, non-JSON) and against a stand-in
shell script that records its argv and answers like the CLI, including one
that overruns `CIRCLE_TIMEOUT_MS`. The Windows path runs on every OS through
a recording spawn: the cmd.exe line for a `.cmd` shim, the direct spawn for
everything else, the refused characters and the `EINVAL` hint, without
starting a process. No test reaches Circle or Arc.
