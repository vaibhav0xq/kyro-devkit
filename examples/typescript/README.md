# TypeScript quickstart

Runs `@kyrodev/sdk` against the live API with no credentials and gates a USDC
amount on the verdict and the advisory limit.

```sh
# from the repository root
pnpm install
pnpm build          # builds packages/sdk, which this example links to
pnpm quickstart     # default wallet, use case payment, 25 USDC
pnpm quickstart 0x000000000000000000000000000000000000dEaD payment 25    # never indexed: caution
pnpm quickstart 0xbb30481982786ea53fe1856e0745eec814d83252 escrow 5000   # over the advisory limit
```

Exit codes: 0 proceed, 2 hold (caution or over the advisory limit), 3 block,
1 request failure. That makes the script usable as a step in a shell pipeline
or a CI gate.

Once `@kyrodev/sdk` is on npm the same file works outside this repository:
replace the workspace dependency with the published version and run it with
`tsx quickstart.ts`.
