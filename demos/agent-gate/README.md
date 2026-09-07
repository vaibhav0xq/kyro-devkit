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

**This revision is dry-run only.** For a proceed the executor builds the exact
Circle CLI command and prints it without running it. Live transfers, decision
receipts and a model-driven planner are planned and listed in
[`CHANGELOG-ETHONLINE.md`](../../CHANGELOG-ETHONLINE.md). `--mode live` exits
with a message.

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
  inside the last ten minutes, in this run or as a live result in the audit log

Refuse beats hold beats proceed. Every triggered condition is printed, not
only the winning one. The capped alternative offered on a hold is the smallest
of the requested amount, the advisory limit, the per-transfer cap and what is
left of the run budget.

The operator caps live in the agent because Circle spending policies are
mainnet only.

## Audit log

Every proposal appends an `intent` line to `agent-gate.audit.log` (JSONL,
gitignored) once its action is final: the request, the verdict and advisory
limit, freshness, the decision model version, the action, every condition
and whether a human approved. Every executor call appends a `result` line
with the argv. Dry-run results never count as payments for the duplicate
guard, because nothing moved.

## Exit codes

- `0`: the run completed, whatever the mix of proceed, hold and refuse
- `1`: configuration or task file problem, printed to stderr
- `4`: a live transfer ended in an unknown state (not reachable in dry-run)

## Layout

```
src/main.ts              entry: flags, env, wiring, exit codes
src/config.ts            flags, environment, .env loader
src/planners/scripted.ts task file loader and validation
src/kyro.ts              decision read through @kyrodev/sdk, throttle, failure mapping, simulations
src/policy.ts            pre-screen, decision, capped alternative (pure)
src/circle.ts            Circle CLI argv builder and the dry-run executor
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
CLI tests spawn the real entry point with `--simulate` and the audit log goes
to a temporary directory.
