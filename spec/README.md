# Kyro OpenAPI snapshot

`kyro-openapi.yaml` is a byte-identical copy of the public spec served at
https://www.thekyro.co/kyro-openapi.yaml.

| | |
| --- | --- |
| Spec version | OpenAPI 3.1.0, Kyro API `v1` |
| Retrieved | 2026-09-06 |
| SHA-256 | `7e5b2d106461b2a5ae683df1cce8360492878e6f6908e9e406733f8bc8b77c46` |
| Operations | 10 (6 GET, 4 POST) across 10 paths |
| Auth | anonymous on 9 of 10 operations; `Authorization: Bearer kyro_live_...` raises the budget and is required for `POST /api/v1/interaction-graph/{wallet}/refresh` |

The v1 surface is frozen: fields and error codes may be added, nothing
existing is removed or renamed. The TypeScript types in
`packages/sdk/src/generated/openapi.ts` are generated from this file and CI
fails if they drift.

## Refreshing the snapshot

```sh
curl -sS -o spec/kyro-openapi.yaml https://www.thekyro.co/kyro-openapi.yaml
sha256sum spec/kyro-openapi.yaml            # update the table above
pnpm --filter @kyrodev/sdk generate:types   # regenerate the SDK types
pnpm --filter @kyrodev/sdk check:generated  # must pass before committing
```

Commit the spec and the regenerated types together.

## Using the spec directly

Any OpenAPI 3.1 tool works: import it into Postman, Insomnia or Bruno, render
it with Redoc or Swagger UI or generate a client for another language with
`openapi-generator` or `openapi-python-client`. The interactive reference for
humans lives at https://docs.thekyro.co.
