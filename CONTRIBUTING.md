# Contributing to kyro-devkit

Thank you for taking the time. This repository is the public developer kit
for Kyro: the SDK, the OpenAPI snapshot, the examples, the agent gate demo and
their documentation. The Kyro API and website are a separate codebase, so
some kinds of change cannot land here. This page says what can and how.

## What belongs here

| Change | Where it goes |
| --- | --- |
| SDK bugs, types, ergonomics, docs | Pull request here |
| Example fixes or a new example (curl, Python, TypeScript) | Pull request here |
| Agent gate demo: policy, executor, tests, docs | Pull request here |
| A wrong claim in any README or doc | Issue or pull request here |
| API behavior, scoring, decision model, rate limits | Not changeable here. Open an issue describing the problem. The fix lands in the product and the spec snapshot is updated afterwards |
| Security vulnerabilities | [SECURITY.md](./SECURITY.md), never a public issue |

## Before you start

- Node 20 or newer and pnpm 9 or newer for the toolchain. `corepack enable`
  gives you the pinned pnpm version from `package.json`.
- `pnpm install`, then `pnpm verify`. Verify is what CI runs on Node 20 and
  22: spec drift check, typecheck, unit tests with a mocked `fetch`, build,
  dist smoke, example and demo typechecks and the demo tests.
- For anything larger than a typo, open an issue first so the change is
  agreed before the work is done.

## Rules that keep the repository honest

- `spec/kyro-openapi.yaml` is a byte-identical snapshot of the public spec
  with its SHA-256 in [`spec/README.md`](./spec/README.md). Do not hand-edit
  it. When the served spec changes, replace the file, update the checksum and
  the retrieval date and regenerate the SDK types in the same commit
  (`pnpm generate:types` inside `packages/sdk`, then `pnpm check:generated`).
- The SDK has zero runtime dependencies. Keep it that way. Dev dependencies
  are fine.
- Tests never touch the network. Anything that needs the live API belongs in
  an example or the demo and must run anonymously in its default mode.
- No credentials, wallet keys, API keys, audit logs or `.env` files in
  commits. Only `.env.example` files are tracked.
- The live executor in `demos/agent-gate` spawns the Circle CLI. Changes to
  it need a dry-run and the demo test suite green. Do not add a code path
  that submits a transfer without an idempotency key or outside the operator
  caps.
- Every claim in a README must be true at the commit that contains it. If you
  cannot verify a number, a date or a link, leave it out.

## Pull requests

- One change per pull request, small enough to review in one sitting.
- Say what changed, why it changed and how you verified it (`pnpm verify`
  output, a dry-run transcript, a curl call).
- Update the docs that mention the behavior you changed in the same pull
  request.
- Commit under your own identity. The history of this repository is part of
  its evidence.
- CI must be green on Node 20 and 22 before review.

## Writing style

Plain sentences and sentence case headings. Say what the code does, not what
it will do. Dates are written as 6 September 2026 and amounts as 1.5 USDC.
No marketing language.

## Conduct

Be direct and respectful. Review the work, not the person. Maintainers may
edit or remove comments that stop being about the work, close threads that
have run their course and block accounts that repeat the behavior.

## License

By contributing you agree that your contribution is licensed under the MIT
license in [LICENSE](./LICENSE).
