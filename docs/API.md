# Kyro API v1 in one page

Base URL `https://www.thekyro.co/api/v1`. Full reference: https://docs.thekyro.co.
Machine-readable contract: [`spec/kyro-openapi.yaml`](../spec/kyro-openapi.yaml).

## Operations

| Method | Path | Auth | Cost | Returns |
| --- | --- | --- | --- | --- |
| GET | `/score/{wallet}` | anonymous | 1 unit, plus 5 when the read starts a background rescan of a stale known wallet | Score 0 to 100, `riskLevel`, `badge`, component `breakdown`, `activeChains`, counts, `cacheStatus`, `lastIndexedAt` |
| GET | `/profile/{username}` | anonymous | 1 unit | Public summary of a claimed Kyro username |
| GET | `/trust/{wallet}` | anonymous | 1 unit | Verified-relationship trust graph: edges, peers, metrics, anomalies |
| GET | `/interaction-graph/{wallet}` | anonymous | 1 unit | Score-neutral observed counterparties with coverage metadata |
| GET | `/decision/{wallet}?useCase=` | anonymous | 1 unit | `decision` allow / caution / block, `recommendedLimit` in USDC, `reasons`, `warnings`, `evidence`, `freshness`, `coverage` |
| POST | `/decision/batch` | anonymous | N units | One row per unique input, `summary` tally. 10 unique rows anonymously, more on keyed plans |
| POST | `/decision-receipts` | anonymous | 1 unit + inner decision | Immutable receipt with `id`, `createdAt`, `payloadHash`. Deduped per UTC day. Own budget of 5 creations per minute |
| GET | `/decision-receipts/{id}` | anonymous | 1 unit | A receipt by `rcp_` id |
| POST | `/intake/{wallet}` | anonymous | 8 units (5 keyed) | Starts indexing an unknown wallet: `started`, `indexing` or `already_indexed`. 25 starts per IP per UTC day anonymously |
| POST | `/interaction-graph/{wallet}/refresh` | key required | 5 units when a run starts | Re-index the observed graph: `started`, `indexing` or `fresh` |

`useCase` is one of `payment` (default), `escrow`, `lending`, `marketplace`.
Wallets are 0x-prefixed 40-hex addresses passed as path segments.

## Envelope

```json
{ "ok": true,  "version": "v1", "data": { } }
{ "ok": false, "version": "v1", "error": { "code": "RATE_LIMITED", "message": "human readable" } }
```

Error codes: `INVALID_WALLET`, `INVALID_USERNAME`, `INVALID_REQUEST`,
`INVALID_KEY`, `NOT_ALLOWED`, `INVALID_SORT`, `NOT_FOUND`, `RATE_LIMITED`,
`SCHEMA_MISSING`, `INTERNAL`. New codes can be added; branch on the ones you
handle.

## Authentication and rate limits

Nine of the ten operations work with no `Authorization` header; the
interaction graph re-index answers `401 NOT_ALLOWED` without a key. Anonymous
callers get 20 units per 60-second window per IP. Sending `Authorization:
Bearer kyro_live_...` raises the budget to the key's plan; a malformed or
revoked key answers `401 INVALID_KEY`. Keys are server-side only.

Responses carry `X-RateLimit-Limit` and `X-RateLimit-Remaining`. A `429`
adds `Retry-After` in seconds.

## No-score semantics

Kyro reports nothing instead of guessing. A valid wallet without a committed
score snapshot still answers HTTP 200:

- the score read returns a conservative baseline with `cacheStatus` other than `cached`,
- the decision read returns a conservative baseline verdict with `freshness.cacheStatus` of `indexing_required`,
- batch rows report `status: "no_score"` instead of a verdict.

To move such a wallet to a real answer: `POST /intake/{wallet}`, poll the
score read until `cacheStatus` is `cached`, then re-run the decision.

## What a decision contains

- `decision`: `allow`, `caution` or `block`.
- `recommendedLimit`: an advisory per-transaction cap in USDC for the use case, with a one-line `basis`.
- `reasons` and `warnings`: machine-readable `code` plus a `message`. Reasons explain the verdict; warnings describe data coverage (transient provider failures, capped history, unsupported chains) without changing it.
- `evidence.used` and `evidence.missing`: which inputs the verdict had and which it lacked.
- `freshness` and `coverage`: when the evidence was indexed and how complete each chain's coverage is.
- `scoreModelVersion` (`identity_score_v1`) and `decisionModelVersion` (`decision_v0.4.1`): both models are deterministic and versioned, so the same evidence always yields the same answer and a receipt can be traced to the model that produced it.

Kyro is wallet intelligence and counterparty decision infrastructure. It does
not perform AML screening and does not provide legal, sanctions or regulatory
compliance determinations. Verdicts and limits are advisory; the caller stays
in control of the transaction.
