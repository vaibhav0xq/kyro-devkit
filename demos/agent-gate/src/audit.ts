/**
 * Append-only JSONL audit log. One intent line per proposal once the action
 * is final, one result line per executor call. The duplicate guard reads it
 * back: only live results count as payments, a dry-run never moved anything.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Action, ConditionCode, ExecutionResult, Mode, RecentPayment } from "./types";

export interface AuditIntent {
  type: "intent";
  at: string;
  runId: string;
  mode: Mode;
  invoiceId: string;
  to: string;
  requestedUsdc: number;
  approvedUsdc: number | null;
  action: Action;
  humanApproved: boolean;
  conditions: ConditionCode[];
  verdict: "allow" | "caution" | "block" | null;
  advisoryLimitUsdc: number | null;
  cacheStatus: string | null;
  decisionModelVersion: string | null;
  kyroFailure: string | null;
  simulated: boolean;
}

export interface AuditResult {
  type: "result";
  at: string;
  runId: string;
  mode: Mode;
  invoiceId: string;
  to: string;
  amountUsdc: number;
  state: ExecutionResult["state"];
  argv: string[];
  txHash: string | null;
  exitCode: number | null;
  detail: string | null;
}

export type AuditEntry = AuditIntent | AuditResult;

export interface AuditLog {
  readonly path: string;
  append(entry: AuditEntry): Promise<void>;
  /** Live payments (any state except dry-run) recorded inside the window ending at now. */
  recentLivePayments(now: Date, windowMs: number): Promise<RecentPayment[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export async function readEntries(path: string): Promise<AuditEntry[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return [];
    throw error;
  }
  const entries: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const entry = toEntry(JSON.parse(line));
      if (entry !== undefined) entries.push(entry);
    } catch {
      // A torn line from an interrupted write is skipped, never trusted.
    }
  }
  return entries;
}

/** Accepts only lines that carry the fields the duplicate guard relies on. */
function toEntry(parsed: unknown): AuditEntry | undefined {
  if (!isRecord(parsed)) return undefined;
  if (typeof parsed.at !== "string" || typeof parsed.invoiceId !== "string") return undefined;
  if (parsed.mode !== "dry-run" && parsed.mode !== "live") return undefined;
  if (parsed.type === "intent") return parsed as unknown as AuditIntent;
  if (parsed.type !== "result") return undefined;
  if (typeof parsed.to !== "string" || typeof parsed.amountUsdc !== "number" || typeof parsed.state !== "string") {
    return undefined;
  }
  return parsed as unknown as AuditResult;
}

export function createAuditLog(path: string): AuditLog {
  let ready: Promise<void> | undefined;
  const ensureDir = (): Promise<void> => {
    ready ??= mkdir(dirname(path), { recursive: true }).then(() => undefined);
    return ready;
  };
  return {
    path,
    async append(entry) {
      await ensureDir();
      await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
    },
    async recentLivePayments(now, windowMs) {
      const floor = now.getTime() - windowMs;
      const entries = await readEntries(path);
      const payments: RecentPayment[] = [];
      for (const entry of entries) {
        if (entry.type !== "result" || entry.mode !== "live" || entry.state === "dry-run") continue;
        const at = Date.parse(entry.at);
        if (!Number.isFinite(at) || at < floor || at > now.getTime()) continue;
        payments.push({ to: entry.to, amountUsdc: entry.amountUsdc, at: entry.at });
      }
      return payments;
    },
  };
}
