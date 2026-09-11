# @kyrodev/sdk

TypeScript SDK for the Kyro counterparty decision API. Wraps all 10 public v1
operations (score, profile, trust, interaction graph read and refresh,
decision, batch, receipts, intake) with typed methods, a shared error model and
rate limit metadata. Zero runtime dependencies. ESM and CJS builds, Node 18.17
or newer, any runtime with a WHATWG `fetch`.

Kyro is advisory and non-custodial: a verdict is an input to your own
decision, never a transfer. Product and API documentation live at
https://docs.thekyro.co.

## Contents

- [Install](#install)
- [Quick look](#quick-look)
- [Configuration](#configuration)
- [Resources](#resources)
- [Responses](#responses)
- [Errors](#errors)
- [Timeouts and cancellation](#timeouts-and-cancellation)
- [Rate limits](#rate-limits)
- [Keyed interaction graph refresh](#keyed-interaction-graph-refresh)
- [Low-level requests](#low-level-requests)
- [Exports](#exports)
- [Compatibility](#compatibility)
- [Development](#development)
- [License](#license)

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
} else {
  // hold: caution, block or over the advisory limit. decision.reasons says why.
}
```

Every method except `interactionGraph.refresh` works anonymously. Passing
`apiKey` raises the rate budget to the key's plan and unlocks the refresh. API
keys are server-side only.

```ts
const kyro = new Kyro({ apiKey: process.env.KYRO_API_KEY });
```

## Configuration

`new Kyro(config?)` accepts:

| Option | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | `string` | none (anonymous) | `kyro_live_...` key, requested through https://www.thekyro.co/developers and managed in the Kyro Console. Sent as `Authorization: Bearer`. Server-side only: a key shipped to a browser is handed to every visitor. |
| `baseUrl` | `string` | `https://www.thekyro.co` | API origin without a trailing slash. Must be `http` or `https`. |
| `timeoutMs` | `number` | `30000` | Per-request timeout. Must be a positive finite number. Override per call with `timeoutMs` in the request options. |
| `fetch` | `typeof fetch` | `globalThis.fetch` | Custom implementation for tests, polyfills or instrumentation. |
| `onRateLimit` | `(event) => void` | none | Called on every response that carries `X-RateLimit-*` headers. See [Rate limits](#rate-limits). |

The constructor validates eagerly and throws a `TypeError` for an empty
`apiKey`, an invalid `baseUrl` or a non-positive `timeoutMs`. It refuses to
combine an `apiKey` with a plain `http` base URL unless the host is loopback
(`localhost`, `127.0.0.1`, `::1`), so a key cannot leave the machine
unencrypted by accident. When no `fetch` is available it throws a `KyroError`
that says so.

## Resources

| Method | Endpoint | Notes |
| --- | --- | --- |
| `kyro.score.get(wallet)` | `GET /api/v1/score/{wallet}` | Score snapshot. Unknown wallets answer a conservative baseline, `cacheStatus !== "cached"`. A read that starts a rescan of a stale known wallet costs 5 extra units. |
| `kyro.profile.get(username)` | `GET /api/v1/profile/{username}` | Public summary for a claimed Kyro username. |
| `kyro.trust.get(wallet)` | `GET /api/v1/trust/{wallet}` | Verified-relationship trust graph. |
| `kyro.interactionGraph.get(wallet, { limit, cursor, sort })` | `GET /api/v1/interaction-graph/{wallet}` | Score-neutral observed counterparties. `limit` defaults to 25, capped at 50 by the API. `sort: "activity"` is a single-page ranking and cannot be combined with `cursor`. |
| `kyro.decisions.check(wallet, { useCase })` | `GET /api/v1/decision/{wallet}` | allow / caution / block with an advisory USDC limit. |
| `kyro.decisions.batch(inputs, { useCase })` | `POST /api/v1/decision/batch` | Up to 10 unique rows anonymously. N rows cost N units. |
| `kyro.receipts.create({ wallet, useCase })` | `POST /api/v1/decision-receipts` | Immutable receipt, deduped per UTC day. Pass exactly one of `wallet` or `username`. Creation has its own budget of 5 receipts per minute on top of the standard rate budget. |
| `kyro.receipts.get(id)` | `GET /api/v1/decision-receipts/{id}` | Read a receipt by `rcp_` id. |
| `kyro.intake.start(wallet)` | `POST /api/v1/intake/{wallet}` | Index a wallet Kyro has not seen. 8 units anonymously. |
| `kyro.interactionGraph.refresh(wallet)` | `POST /api/v1/interaction-graph/{wallet}/refresh` | Keyed only. |

Use cases: `payment` (default), `escrow`, `lending`, `marketplace`.

Every method takes an optional last argument of type `KyroRequestOptions`
(`signal`, `timeoutMs`). Methods with their own options (`decisions.check`,
`decisions.batch`, `interactionGraph.get`) extend that type, so the request
options ride along in the same object.

## Responses

Resource methods return the `data` field of the v1 envelope, already typed:
`KyroScore`, `KyroDecision`, `KyroBatchResult`, `KyroReceiptCreateResult`,
`KyroReceiptRead`, `KyroTrust`, `KyroInteractionGraphData`, `KyroProfile`,
`KyroIntakeResult` and `KyroInteractionGraphRefreshResult`. All of them are
aliases of schemas in the generated OpenAPI types, so the field names match
the public spec exactly and new fields arrive additively.

A decision carries `decision`, `recommendedLimit`, `score`, `riskLevel`,
`reasons[]`, `warnings[]`, `evidence.used[]`, `evidence.missing[]`,
`freshness`, `coverage` and the model versions. Reason and warning entries are
a stable code plus a message; branch on the codes you handle and ignore the
rest. A wallet without a committed snapshot answers a conservative baseline
with `freshness.cacheStatus` of `indexing_required`, never a fabricated
verdict.

## Errors

Every failure of a request that was sent extends `KyroError`. Argument
validation throws a native `TypeError` before any request is made.

```ts
import { KyroApiError, KyroRequestError } from "@kyrodev/sdk";

try {
  await kyro.decisions.check(wallet);
} catch (error) {
  if (error instanceof KyroApiError) {
    // The API answered with an error envelope.
    // error.code    stable machine-readable code, e.g. RATE_LIMITED, INVALID_WALLET
    // error.status  HTTP status
    // error.retryAfterSeconds  set on 429 when the server sent Retry-After
    // error.rateLimit          parsed X-RateLimit-* headers, when present
    // error.envelope, error.headers  the raw parsed body and the response headers
  } else if (error instanceof KyroRequestError) {
    // No valid Kyro envelope reached the client.
    // error.code    "TIMEOUT" | "NETWORK" | "BAD_RESPONSE"
    // error.status  HTTP status, when a response arrived with an unusable body
    // error.cause   the underlying fetch or abort error, when there is one
  } else {
    // Your own AbortSignal reason or a TypeError from argument validation.
    throw error;
  }
}
```

Error codes enumerated in the v1 spec: `INVALID_WALLET`, `INVALID_USERNAME`,
`INVALID_REQUEST`, `INVALID_KEY`, `INVALID_SORT`, `NOT_FOUND`,
`RATE_LIMITED`, `SCHEMA_MISSING`, `INTERNAL`. The keyed refresh also answers
`NOT_ALLOWED` to anonymous callers. Other codes can appear additively, so
`error.code` is typed as `KyroErrorCode | string`.

Argument mistakes (an empty wallet, a path without a leading slash, both
`wallet` and `username` on a receipt) are the `TypeError` case. Cancelling
through your own `AbortSignal` rethrows the signal's reason unchanged.

A read that fails is not a verdict. If your integration gates money on Kyro,
treat `KyroRequestError` and 5xx `KyroApiError` as "no answer" and fail
closed or hold for a human, the way the
[agent gate demo](../../demos/agent-gate/README.md) does.

## Timeouts and cancellation

```ts
const kyro = new Kyro({ timeoutMs: 8_000 });               // client-wide

await kyro.score.get(wallet, { timeoutMs: 2_000 });        // this call only

const controller = new AbortController();
setTimeout(() => controller.abort(new Error("shutting down")), 500);
await kyro.decisions.check(wallet, { signal: controller.signal });
```

A timeout aborts the underlying fetch and throws `KyroRequestError` with code
`TIMEOUT`. A caller-side abort rethrows your reason. The body read honors the
same signal, so a slow response cannot hold a request past its budget even
with a custom `fetch`.

## Rate limits

Anonymous callers share a budget of 20 rate units per minute per IP. Most
reads cost 1 unit; batch rows cost 1 each, intake costs 8 and a score read
that starts a rescan costs 5 extra. A key raises the budget to its plan.
Responses that spend units carry `X-RateLimit-Limit` and
`X-RateLimit-Remaining`; free answers such as intake `already_indexed` and
`indexing` or refresh `fresh` and `indexing` carry no rate headers. A 429
adds `Retry-After`.

```ts
const kyro = new Kyro({
  onRateLimit: ({ remaining, retryAfterSeconds, path }) => {
    if (remaining !== undefined && remaining < 3) pause(retryAfterSeconds ?? 60);
  },
});
```

The callback receives `{ limit?, remaining?, retryAfterSeconds?, path, status }`
for every response that carries the headers, successful or not. For one-off
reads the `rateLimit` field on a low-level response (below) or on a
`KyroApiError` carries the same numbers.

## Keyed interaction graph refresh

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

## Low-level requests

`kyro.request(method, path, options)` is the escape hatch every resource
method uses. It returns the whole response instead of the unwrapped payload:

```ts
const response = await kyro.request<KyroScore>("GET", "/api/v1/score/" + wallet);
response.data;       // typed payload
response.status;     // HTTP status
response.headers;    // Headers
response.rateLimit;  // { limit?, remaining? } or undefined
```

Options: `query` (undefined values are skipped), `body` (JSON-encoded for
POST), `signal` and `timeoutMs`. The path must start with a slash. Use it for
operations added to the API after this SDK version, with the same envelope
and error handling as the typed methods.

## Exports

| Export | Kind | What it is |
| --- | --- | --- |
| `Kyro` | class | The client. Resources: `score`, `profile`, `trust`, `interactionGraph`, `decisions`, `receipts`, `intake`; plus `request()`. |
| `KyroError` | class | Base class for SDK errors. |
| `KyroApiError` | class | The API answered with an error envelope. |
| `KyroRequestError` | class | Timeout, network failure or an invalid envelope. |
| `KyroConfig`, `KyroRequestInit`, `KyroRequestOptions` | types | Constructor, low-level request and per-call options. |
| `DecisionCheckOptions`, `DecisionBatchOptions`, `InteractionGraphGetOptions`, `ReceiptCreateParams` | types | Method-specific options. |
| `KyroScore`, `KyroProfile`, `KyroTrust`, `KyroTrustGraph`, `KyroInteractionGraph`, `KyroInteractionGraphData`, `KyroInteractionGraphRefreshResult`, `KyroDecision`, `KyroDecisionVerdict`, `KyroBatchResult`, `KyroBatchRow`, `KyroBatchSummary`, `KyroReceipt`, `KyroReceiptCreateResult`, `KyroReceiptRead`, `KyroIntakeResult`, `KyroUseCase`, `KyroErrorCode`, `KyroRequestErrorCode` | types | Payloads and enums, aliased from the generated spec types. |
| `KyroResponse<T>`, `KyroRateLimitInfo`, `KyroRateLimitEvent` | types | Low-level response shape and rate limit metadata. |
| `KyroOpenApiPaths`, `KyroOpenApiComponents` | types | The raw generated OpenAPI types, for anything the aliases do not cover. |

## Compatibility

- Node 18.17 or newer. Node 20 or 22 for the development toolchain.
- Any runtime with a WHATWG `fetch`, `AbortController` and `Headers` should
  work (Deno, Bun, edge runtimes, modern browsers); only Node is covered by
  the test suite. In a browser, use anonymous access only.
- ESM (`import`) and CJS (`require`) entry points with matching type
  declarations. `sideEffects: false` for tree shaking.
- Semantic versioning. While the major version is 0, a minor release may
  change TypeScript types. The wire contract is v1 regardless of the SDK
  version.

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
commit. Contribution guidelines and the security policy are in the repository
root ([CONTRIBUTING.md](../../CONTRIBUTING.md),
[SECURITY.md](../../SECURITY.md)). Full API documentation lives at
https://docs.thekyro.co.

## License

MIT. See [LICENSE](./LICENSE).
