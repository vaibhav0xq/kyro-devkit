/**
 * Kyro quickstart with @kyrodev/sdk.
 *
 * Checks one wallet for one use case, then gates a USDC amount on the verdict
 * and the advisory limit. No credentials needed: the anonymous tier allows
 * 20 rate units per minute per IP and this script spends one.
 *
 *   pnpm quickstart                          # default wallet, payment, 25 USDC
 *   pnpm quickstart 0xabc... escrow 300      # wallet, use case, amount in USDC
 *
 * Exit codes: 0 proceed, 2 hold (caution or over the advisory limit), 3 block,
 * 1 request failure. The verdict is advisory. Kyro is not custodial and never
 * moves funds; the caller decides what to do with the answer.
 */
import { Kyro, KyroApiError, KyroRequestError } from "@kyrodev/sdk";
import type { KyroUseCase } from "@kyrodev/sdk";

const USE_CASES: readonly KyroUseCase[] = ["payment", "escrow", "lending", "marketplace"];

// npm forwards a literal "--" when invoked as `npm start -- args`; drop it.
const args = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
const wallet = args[0] ?? "0xbb30481982786ea53fe1856e0745eec814d83252";
const useCaseArg = args[1] ?? "payment";
const amountUsdc = Number(args[2] ?? "25");

if (!USE_CASES.includes(useCaseArg as KyroUseCase)) {
  console.error(`Unknown use case "${useCaseArg}". Valid values: ${USE_CASES.join(", ")}.`);
  process.exit(1);
}
const useCase = useCaseArg as KyroUseCase;
if (!Number.isFinite(amountUsdc) || amountUsdc < 0) {
  console.error(`Amount must be a non-negative number of USDC, got "${args[2]}".`);
  process.exit(1);
}

const kyro = new Kyro({
  // apiKey: process.env.KYRO_API_KEY, // optional, raises the rate budget; server-side only
  onRateLimit: ({ remaining, limit }) => {
    if (remaining !== undefined && remaining <= 2) {
      console.error(`rate budget nearly spent: ${remaining}/${limit ?? "?"} units left this minute`);
    }
  },
});

try {
  const decision = await kyro.decisions.check(wallet, { useCase });

  console.log(`wallet      ${decision.wallet}${decision.username ? ` (${decision.username})` : ""}`);
  console.log(`use case    ${decision.useCase}`);
  console.log(`verdict     ${decision.decision}`);
  console.log(`score       ${decision.score} (${decision.riskLevel}, ${decision.scoreModelVersion})`);
  console.log(`limit       ${decision.recommendedLimit.amountUsdc} ${decision.recommendedLimit.currency} advisory`);
  console.log(`freshness   ${decision.freshness.cacheStatus}`);
  console.log(`reasons     ${decision.reasons.map((reason) => reason.code).join(", ") || "none"}`);
  console.log(`model       ${decision.decisionModelVersion}`);

  if (decision.decision === "block") {
    console.log(`\nHOLD: block verdict for ${amountUsdc} USDC.`);
    process.exit(3);
  }
  if (decision.decision === "caution") {
    console.log(`\nHOLD: caution verdict, route ${amountUsdc} USDC to manual review.`);
    process.exit(2);
  }
  if (amountUsdc > decision.recommendedLimit.amountUsdc) {
    console.log(`\nHOLD: ${amountUsdc} USDC exceeds the advisory limit of ${decision.recommendedLimit.amountUsdc} USDC.`);
    process.exit(2);
  }
  console.log(`\nPROCEED: ${amountUsdc} USDC is within the advisory limit.`);
} catch (error) {
  if (error instanceof KyroApiError) {
    const retry = error.retryAfterSeconds !== undefined ? ` (retry in ${error.retryAfterSeconds}s)` : "";
    console.error(`Kyro API error ${error.status} ${error.code}: ${error.message}${retry}`);
  } else if (error instanceof KyroRequestError) {
    console.error(`request failed before a Kyro answer arrived (${error.code}): ${error.message}`);
  } else {
    console.error(error);
  }
  process.exit(1);
}
