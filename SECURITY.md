# Security policy

## Scope

This policy covers the code in this repository: `@kyrodev/sdk`, the examples,
the agent gate demo and the CI configuration. Reports about the hosted Kyro
API, the website, the docs site or the console are welcome through the same
channel. The same maintainer handles both.

## Supported versions

| Component | Supported |
| --- | --- |
| `@kyrodev/sdk` 0.1.x | Yes |
| `main` branch of this repository | Yes |
| Anything older | No, update first |

## Reporting a vulnerability

Do not open a public issue for a security problem. Email
arcidentity.build@gmail.com with the subject line `[Security] kyro-devkit`.

Include what you found, where it is (file, endpoint or package version), the
steps to reproduce it, the impact as you understand it and whether the issue
is already public anywhere. Proof-of-concept code is welcome. Exploitation
against other people's wallets, sessions or data is not.

You will get an acknowledgement, normally within three working days. Updates
follow while the fix is in progress. SDK fixes ship as a patch release on npm
with a note in the release. Fixes to the hosted service are dated in the
docs. If you want credit, say so and how you would like to be named.

## In scope

- Credential exposure in the SDK, the examples, the demo or CI. As a
  baseline, the SDK refuses to send an API key over plain `http` except to
  loopback hosts.
- Request forgery, injection or path handling issues in the SDK.
- The agent gate demo submitting a transfer that its policy, its caps or its
  idempotency rules should have stopped.
- Supply chain problems in the published package: a tarball that does not
  match this source or a compromised dependency.
- Authentication, authorization, rate limit bypass or data exposure in the
  hosted API, website or console.

## Out of scope

- Findings that require a compromised operator machine, a compromised Circle
  CLI session or a leaked `.env` file.
- Rate limiting working as designed, including the anonymous budget of 20
  rate units per minute per IP.
- Advisory verdicts you disagree with. Scoring and decision quality are
  product feedback, not vulnerabilities. Open an issue for those.
- Anything on Arc Testnet that has no monetary value.
- Automated scanner output without a demonstrated impact.

## Safe harbor

Good-faith research that follows this policy, stays within your own accounts
and test wallets, avoids service disruption and does not access or modify
other people's data will not be met with legal action from Kyro. There is no
bug bounty program at this time.

## Handling secrets when you use this code

- API keys (`kyro_live_...`) are server-side only. Never ship one to a
  browser or a mobile app. Anonymous access covers 9 of the 10 operations.
- The agent gate demo reads credentials from your Circle CLI session and your
  environment. Nothing in this repository stores them; `.env`, `*.log` and
  `dist/` are gitignored.
- If you think a key has leaked, report it through the channel above so it
  can be revoked.
