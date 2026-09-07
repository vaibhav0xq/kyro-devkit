/**
 * Circle CLI side of the gate. This revision only builds the command and
 * prints it: the dry-run executor never spawns anything. The argv shape
 * follows the Circle CLI command reference for
 * `circle wallet transfer <to> --amount <n> --address <from> --chain <chain>`
 * with the global `--output json` option.
 */
import type { ExecutionResult, Executor, TransferRequest } from "./types";
import { CHAIN } from "./types";
import { isAddress, isValidUsdcAmount, normaliseAddress } from "./policy";

/** Stands in for the paying wallet in dry-run when AGENT_WALLET_ADDRESS is not set. */
export const FROM_PLACEHOLDER = "<AGENT_WALLET_ADDRESS>";

/** Up to six decimals, no exponent, no trailing zeros. */
export function formatUsdcAmount(amountUsdc: number): string {
  if (!isValidUsdcAmount(amountUsdc)) {
    throw new RangeError(`amount ${String(amountUsdc)} is not a valid USDC amount`);
  }
  return amountUsdc.toFixed(6).replace(/\.?0+$/, "");
}

export function buildTransferArgv(request: TransferRequest): string[] {
  if (!isAddress(request.to)) {
    throw new TypeError(`recipient ${JSON.stringify(request.to)} is not a 0x-prefixed 40-hex address`);
  }
  if (request.from !== FROM_PLACEHOLDER && !isAddress(request.from)) {
    throw new TypeError(`paying wallet ${JSON.stringify(request.from)} is not a 0x-prefixed 40-hex address`);
  }
  const from = request.from === FROM_PLACEHOLDER ? request.from : normaliseAddress(request.from);
  return [
    "wallet",
    "transfer",
    normaliseAddress(request.to),
    "--amount",
    formatUsdcAmount(request.amountUsdc),
    "--address",
    from,
    "--chain",
    CHAIN,
    "--output",
    "json",
  ];
}

/** Human-readable command line. Only for display; nothing here reaches a shell. */
export function formatCommand(bin: string, argv: string[]): string {
  return [bin, ...argv].map((part) => (/\s/.test(part) ? JSON.stringify(part) : part)).join(" ");
}

/** Builds the exact argv a live run would pass to the CLI and returns it unexecuted. */
export function createDryRunExecutor(): Executor {
  return {
    mode: "dry-run",
    async transfer(request: TransferRequest): Promise<ExecutionResult> {
      const argv = buildTransferArgv(request);
      return { state: "dry-run", argv };
    },
  };
}
