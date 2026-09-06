# @kyrodev/sdk

TypeScript SDK for the Kyro counterparty decision API. Wraps all 10 public v1
operations (score, profile, trust, interaction graph read and refresh,
decision, batch, receipts, intake) with typed methods, a shared error model and
rate limit metadata. Zero runtime dependencies. ESM and CJS builds, Node 18.17
or newer, any runtime with a WHATWG `fetch`.

## Install

```sh
npm install @kyrodev/sdk
# or
pnpm add @kyrodev/sdk
```

Published version: 0.1.0 (MIT, Node 18.17 or newer, zero runtime dependencies).
Its runtime code is byte-identical to the build this directory produces. The
published 0.1.0 type declarations predate the additive interaction graph native
value fields (`metrics.value`, `capabilities.value`); the declarations built
from this directory include them.

To build from source instead, clone
[kyro-devkit](https://github.com/vaibhav0xq/kyro-devkit), run `pnpm install`
and `pnpm build`, then depend on `packages/sdk` through your package manager's
workspace or link feature.

Types are generated from the frozen v1 spec vendored at
[`spec/kyro-openapi.yaml`](../../spec/kyro-openapi.yaml) in the same repository.

## Quick look

```ts
import { Kyro, KyroApiError } from "@kyrodev/sdk";

const kyro = new Kyro(); // anonymous: 20 rate units per minute per IP

const decision = await kyro.decisions.check("0xbb30481982786ea53fe1856e0745eec814d83252", {
  useCase: "payment",
});

if (decision.decision === "allow" && amountUsdc <= decision.recommendedLimit.amountUsdc) {
  // proceed with the transfer
}
```

Every method except `interactionGraph.refresh` works anonymously. Passing
`apiKey` raises the rate budget to the key's plan and unlocks the refresh. API
keys are server-side only.

```ts
const kyro = new Kyro({ apiKey: process.env.KYRO_API_KEY });
```

### Resources

| Method | Endpoint | Notes |
| --- | --- | --- |
| `kyro.score.get(wallet)` | `GET /api/v1/score/{wallet}` | Score snapshot. Unknown wallets answer a conservative baseline, `cacheStatus !== "cached"`. A read that starts a rescan of a stale known wallet costs 5 extra units. |
| `kyro.profile.get(username)` | `GET /api/v1/profile/{username}` | Public summary for a claimed Kyro username. |
| `kyro.trust.get(wallet)` | `GET /api/v1/trust/{wallet}` | Verified-relationship trust graph. |
| `kyro.interactionGraph.get(wallet)` | `GET /api/v1/interaction-graph/{wallet}` | Score-neutral observed counterparties. |
| `kyro.decisions.check(wallet, { useCase })` | `GET /api/v1/decision/{wallet}` | allow / caution / block with an advisory USDC limit. |
| `kyro.decisions.batch(inputs, { useCase })` | `POST /api/v1/decision/batch` | Up to 10 unique rows anonymously. N rows cost N units. |
| `kyro.receipts.create({ wallet, useCase })` | `POST /api/v1/decision-receipts` | Immutable receipt, deduped per UTC day. |
| `kyro.receipts.get(id)` | `GET /api/v1/decision-receipts/{id}` | Read a receipt by `rcp_` id. |
| `kyro.intake.start(wallet)` | `POST /api/v1/intake/{wallet}` | Index a wallet Kyro has not seen. 8 units anonymously. |
| `kyro.interactionGraph.refresh(wallet)` | `POST /api/v1/interaction-graph/{wallet}/refresh` | Keyed only. |

Use cases: `payment` (default), `escrow`, `lending`, `marketplace`.

### Errors

```ts
import { KyroApiError, KyroRequestError } from "@kyrodev/sdk";

try {
  await kyro.decisions.check(wallet);
} catch (error) {
  if (error instanceof KyroApiError) {
    // error.code is the machine-readable API code, e.g. RATE_LIMITED, INVALID_WALLET
    // error.status is the HTTP status, error.retryAfterSeconds is set on 429
  } else if (error instanceof KyroRequestError) {
    // TIMEOUT, NETWORK or BAD_RESPONSE: no valid Kyro envelope reached the client
  }
}
```

### Rate limit pacing

```ts
const kyro = new Kyro({
  onRateLimit: ({ remaining, retryAfterSeconds, path }) => {
    if (remaining !== undefined && remaining < 3) pause(retryAfterSeconds ?? 60);
  },
});
```

### Keyed interaction graph refresh

```ts
const refresh = await kyro.interactionGraph.refresh(wallet);
if (refresh.status === "started") {
  // A run began (5 units, mode "reindex" or "first_index").
  // Poll kyro.interactionGraph.get(wallet) for the persisted graph.
} else if (refresh.status === "indexing") {
  // Joined a run already in flight. Free.
} else {
  // "fresh": the snapshot is younger than 60 minutes; nothing started.
  // refresh.retryAfterSeconds says when a re-index may begin.
}
```

## Development

```bash
pnpm install              # dev dependencies only; the SDK has zero runtime deps
pnpm generate:types       # regenerate src/generated/openapi.ts from spec/kyro-openapi.yaml
pnpm check:generated      # fail if the committed types drift from the spec
pnpm typecheck
pnpm test                 # mocked fetch only, no network
pnpm build                # dist/: ESM + CJS + d.ts via tsup
pnpm test:dist            # smoke test both dist formats
```

Any change to `spec/kyro-openapi.yaml` must regenerate the types in the same
commit. Full API documentation lives at https://docs.thekyro.co.

## License

MIT. See [LICENSE](./LICENSE).
