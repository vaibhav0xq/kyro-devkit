# curl examples

Every call below is anonymous. No account, no key, no wallet connection. The
anonymous tier allows 20 rate units per minute per IP. Each read costs 1 unit;
a score read that starts a background rescan of a stale known wallet costs 5
more, a batch of N unique rows costs N and an intake start costs 8.

```sh
BASE=https://www.thekyro.co/api/v1
WALLET=0xbb30481982786ea53fe1856e0745eec814d83252   # a claimed identity with a committed score
FRESH=0x000000000000000000000000000000000000dEaD    # a wallet Kyro has never indexed

# 1. Score snapshot
curl -s "$BASE/score/$WALLET"

# 2. Pre-transaction decision for a use case: allow / caution / block plus an advisory USDC limit
curl -s "$BASE/decision/$WALLET?useCase=payment"

# 3. Same read for a wallet with no evidence: a conservative baseline, never a guess
curl -s "$BASE/decision/$FRESH?useCase=payment"

# 4. Batch screening, up to 10 unique rows anonymously (N rows cost N units)
curl -s -X POST "$BASE/decision/batch" \
  -H 'content-type: application/json' \
  -d "{\"inputs\":[\"$WALLET\",\"$FRESH\"],\"useCase\":\"escrow\"}"

# 5. Verified-relationship trust graph and the public profile of a claimed username
curl -s "$BASE/trust/$WALLET"
curl -s "$BASE/profile/vaibhav_meta.kyro"

# 6. Mint an immutable receipt of a decision, then read it back by id (POST creates data)
curl -s -X POST "$BASE/decision-receipts" \
  -H 'content-type: application/json' \
  -d "{\"wallet\":\"$WALLET\",\"useCase\":\"payment\"}"
curl -s "$BASE/decision-receipts/rcp_XXXXXXXXXXXXXXXX"

# 7. Ask Kyro to index a wallet it has not seen (8 units, capped at 25 starts per IP per day)
curl -s -X POST "$BASE/intake/$FRESH"
```

Pipe any of them through `jq .` to pretty print. Add `-i` to see the
`X-RateLimit-Limit` and `X-RateLimit-Remaining` headers.

Every response is a versioned envelope:

```json
{ "ok": true,  "version": "v1", "data": { } }
{ "ok": false, "version": "v1", "error": { "code": "RATE_LIMITED", "message": "..." } }
```

## kyro.sh

`kyro.sh` wraps the same calls with argument validation, rate-limit headers on
stderr and optional pretty printing through `jq`.

```sh
./kyro.sh decision 0xbb30481982786ea53fe1856e0745eec814d83252 payment
./kyro.sh batch escrow 0xbb30481982786ea53fe1856e0745eec814d83252 vaibhav_meta.kyro
KYRO_API_KEY=kyro_live_... ./kyro.sh refresh 0xbb30481982786ea53fe1856e0745eec814d83252
```

The script exits non-zero when the API answers with an error envelope, so it
can gate a step in a larger shell script. Set `KYRO_BASE_URL` to point it at
another origin.

## Notes

- The score path takes the wallet as a path segment. `?wallet=` is not a
  supported form.
- A valid wallet without a committed snapshot answers HTTP 200 with a
  conservative baseline (`cacheStatus` is not `cached`); batch rows report
  `no_score` for it. Use intake to index it, then poll the score read.
- Kyro does not perform AML screening and does not provide legal, sanctions or
  regulatory compliance determinations. Verdicts and limits are advisory.
