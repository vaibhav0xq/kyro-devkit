# Python quickstart

One file, standard library only, Python 3.8 or newer. No package to install.

```sh
python3 kyro_quickstart.py                                                    # default wallet, payment, 25 USDC
python3 kyro_quickstart.py 0x000000000000000000000000000000000000dEaD payment 25  # never indexed: caution
python3 kyro_quickstart.py 0xbb30481982786ea53fe1856e0745eec814d83252 escrow 5000 # over the advisory limit
```

Exit codes: 0 proceed, 2 hold, 3 block, 1 request failure. Rate limit headers
are echoed to stderr so the JSON-free stdout stays easy to parse.

The `kyro_get` helper is the whole client: it builds the URL, adds the
optional `Authorization: Bearer` header (only over https), unwraps the
`{ ok, version, data | error }` envelope and turns error envelopes into a
`KyroError` with the machine-readable `code`, the HTTP status and
`retry_after` on 429. Copy it into your own project as is.

There is no Python package for Kyro yet. The full surface is documented by the
OpenAPI 3.1 spec at [`spec/kyro-openapi.yaml`](../../spec/kyro-openapi.yaml);
any OpenAPI client generator can produce a typed client from it.
