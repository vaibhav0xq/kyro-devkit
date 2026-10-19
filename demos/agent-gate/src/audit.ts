/**
 * Append-only JSONL audit log. One intent line per proposal once the action
 * is final, one result line per executor call. The duplicate guard reads it
 * back: only live entries count as payments, a dry-run never moved anything.
 *
 * In live mode the intent line for a proceed is written before the Circle
 * CLI is spawned and carries the idempotency key. That makes the log the
 * record of truth for a retry: an interrupted run leaves an intent without
 * a result, which the guard treats as a payment and whose key a later run
 * of the same invoice reuses.
 *
 * The guard and the key reuse both read the log before they write it, so
 * they are only safe when one live run at a time uses a log. `acquireLiveLock`
 * enforces that with an exclusive lock file next to the log.
 */
import { appendFile, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { UnresolvedAttempt } from "./reconcile";
import type { Action, ConditionCode, ConfirmedPayment, ExecutionResult, Mode, RecentPayment } from "./types";

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
  /** Circle idempotency key for a live proceed, recorded before the spawn. Null otherwise. */
  idempotencyKey: string | null;
  /**
   * The decision receipt minted for this proposal when receipts are on and
   * the policy said proceed, recorded before the executor runs. All null when
   * receipts are off, when nothing was to be paid or when the creation
   * failed (then `conditions` carries RECEIPT_UNAVAILABLE and the action is
   * refuse). A receipt that disagreed with the read is still recorded, with
   * RECEIPT_MISMATCH and a hold.
   */
  receiptId: string | null;
  receiptPayloadHash: string | null;
  receiptDeduped: boolean | null;
  receiptUrl: string | null;
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
  transactionId: string | null;
  idempotencyKey: string | null;
  exitCode: number | null;
  errorCode: string | null;
  detail: string | null;
}

/**
 * What a reconcile concluded about an attempt that ended unknown. Written
 * by `resume`, never by a run that pays. It is a new line, not an edit: the
 * intent and result lines it settles stay exactly as they were, so the log
 * remains append-only and the history of the uncertainty is kept.
 */
export interface AuditResolution {
  type: "resolution";
  at: string;
  runId: string;
  mode: Mode;
  invoiceId: string;
  to: string;
  amountUsdc: number;
  /** The key the attempt was sent with. Identifies which attempt this settles. */
  idempotencyKey: string;
  outcome: "confirmed" | "failed" | "unknown";
  /** The provider's transaction id when one was matched. Null when nothing resolved. */
  transactionId: string | null;
  txHash: string | null;
  /** How this was decided, for example "circle transaction list". */
  source: string;
  /** Why, in words. Always set, including on an unknown that resolved nothing. */
  detail: string;
}

export type AuditEntry = AuditIntent | AuditResult | AuditResolution;

export interface PriorAttempt {
  idempotencyKey: string;
  at: string;
  /** When the intent that first carried this key was written; the reconcile window starts here. */
  intentAt: string;
  /** Last recorded state of that attempt; "unknown" also covers an intent that never got a result. */
  state: ExecutionResult["state"];
}

export interface AuditLog {
  readonly path: string;
  append(entry: AuditEntry): Promise<void>;
  /**
   * Live payments recorded inside the window ending at now: every live
   * result that is not a dry-run plus every live proceed intent, so a run
   * interrupted between spawn and result still counts.
   */
  recentLivePayments(now: Date, windowMs: number): Promise<RecentPayment[]>;
  /**
   * The most recent live attempt at this exact payment (invoice, recipient,
   * amount) that carried an idempotency key, with its last known state.
   */
  lastLiveAttempt(invoiceId: string, to: string, amountUsdc: number): Promise<PriorAttempt | undefined>;
  /**
   * Live attempts the log never settled, oldest first: a proceed intent
   * carrying an idempotency key with no terminal result and no resolution
   * after it. A result of `unknown` leaves the attempt here, because that
   * is exactly the case that needs chasing, and so does a resolution whose
   * own outcome was unknown. Dry-run entries are ignored, nothing moved.
   */
  unresolvedLiveAttempts(): Promise<UnresolvedAttempt[]>;
  /**
   * Payments a reconcile confirmed, with no time window. The duplicate
   * guard forgets after ten minutes, which is right for a payment nobody
   * ever verified, and wrong for one the log proves went through: that is
   * the single case where this demo has hard evidence USDC moved.
   */
  confirmedLivePayments(): Promise<ConfirmedPayment[]>;
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
  if (parsed.type === "intent") {
    if (typeof parsed.to !== "string" || typeof parsed.action !== "string") return undefined;
    return parsed as unknown as AuditIntent;
  }
  if (parsed.type === "resolution") {
    if (typeof parsed.to !== "string" || typeof parsed.amountUsdc !== "number") return undefined;
    if (typeof parsed.idempotencyKey !== "string" || parsed.idempotencyKey === "") return undefined;
    if (parsed.outcome !== "confirmed" && parsed.outcome !== "failed" && parsed.outcome !== "unknown") {
      return undefined;
    }
    return parsed as unknown as AuditResolution;
  }
  if (parsed.type !== "result") return undefined;
  if (typeof parsed.to !== "string" || typeof parsed.amountUsdc !== "number" || typeof parsed.state !== "string") {
    return undefined;
  }
  return parsed as unknown as AuditResult;
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export class LiveLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LiveLockError";
  }
}

export interface LiveLock {
  readonly path: string;
  release(): Promise<void>;
}

/**
 * Exclusive lock for live runs sharing one audit log: the file is created
 * with O_EXCL and removed when the run ends. Two live runs against the same
 * log could otherwise both read an empty history and pay the same invoice
 * twice with two keys. Throws LiveLockError when another run holds it.
 */
export async function acquireLiveLock(auditPath: string, pid: number = process.pid, now: Date = new Date()): Promise<LiveLock> {
  const path = `${auditPath}.lock`;
  await mkdir(dirname(auditPath), { recursive: true });
  let handle;
  try {
    handle = await open(path, "wx");
  } catch (error) {
    if (isRecord(error) && error.code === "EEXIST") {
      let holder = "";
      try {
        holder = (await readFile(path, "utf8")).trim();
      } catch {
        // The holder may have just released it; the message still names the file.
      }
      throw new LiveLockError(
        `another live run holds ${path}${holder !== "" ? ` (${holder})` : ""}. ` +
          "Wait for it to finish; if no run is active, delete the file and start again. Nothing was read or spawned.",
      );
    }
    throw error;
  }
  try {
    await handle.writeFile(`pid ${String(pid)} since ${now.toISOString()}\n`, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path,
    async release() {
      await rm(path, { force: true });
    },
  };
}

/**
 * Releases the lock without letting a cleanup failure replace the run's
 * outcome: an exit 4 or a pending error about an unknown transfer matters
 * more than a lock file that has to be deleted by hand.
 */
export async function releaseLockQuietly(lock: LiveLock, warn: (line: string) => void): Promise<void> {
  try {
    await lock.release();
  } catch (error) {
    const reason = isRecord(error) && typeof error.code === "string" ? error.code : String(error);
    warn(`could not remove ${lock.path} (${reason}); delete it by hand before the next live run`);
  }
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
        if (entry.mode !== "live") continue;
        const at = Date.parse(entry.at);
        if (!Number.isFinite(at) || at < floor || at > now.getTime()) continue;
        if (entry.type === "result" && entry.state !== "dry-run") {
          payments.push({ to: entry.to, amountUsdc: entry.amountUsdc, at: entry.at });
        } else if (entry.type === "intent" && entry.action === "proceed" && typeof entry.approvedUsdc === "number") {
          payments.push({ to: entry.to, amountUsdc: entry.approvedUsdc, at: entry.at });
        }
      }
      return payments;
    },
    async lastLiveAttempt(invoiceId, to, amountUsdc) {
      const entries = await readEntries(path);
      let found: PriorAttempt | undefined;
      const firstIntentAt = new Map<string, string>();
      for (const entry of entries) {
        if (entry.mode !== "live" || entry.invoiceId !== invoiceId || !sameAddress(entry.to, to)) continue;
        if (entry.type === "intent") {
          if (entry.action !== "proceed" || entry.approvedUsdc !== amountUsdc) continue;
          if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey === "") continue;
          if (!firstIntentAt.has(entry.idempotencyKey)) firstIntentAt.set(entry.idempotencyKey, entry.at);
          found = {
            idempotencyKey: entry.idempotencyKey,
            at: entry.at,
            intentAt: firstIntentAt.get(entry.idempotencyKey) ?? entry.at,
            state: "unknown",
          };
          // A resolution line settles an attempt, it is not an attempt, so it
          // never becomes the prior attempt whose key a later run reuses.
        } else if (entry.type === "result" && entry.amountUsdc === amountUsdc && entry.state !== "dry-run") {
          if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey === "") continue;
          found = {
            idempotencyKey: entry.idempotencyKey,
            at: entry.at,
            intentAt: firstIntentAt.get(entry.idempotencyKey) ?? entry.at,
            state: entry.state,
          };
        }
      }
      return found;
    },
    async unresolvedLiveAttempts() {
      const entries = await readEntries(path);
      // Keyed by idempotency key: a reused key is one attempt being chased
      // across runs, not two, and its window starts at the first intent.
      const open = new Map<string, UnresolvedAttempt>();
      const settled = new Set<string>();
      for (const entry of entries) {
        if (entry.mode !== "live") continue;
        if (entry.type === "intent") {
          if (entry.action !== "proceed" || typeof entry.approvedUsdc !== "number") continue;
          if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey === "") continue;
          if (open.has(entry.idempotencyKey)) continue;
          open.set(entry.idempotencyKey, {
            invoiceId: entry.invoiceId,
            to: entry.to,
            amountUsdc: entry.approvedUsdc,
            idempotencyKey: entry.idempotencyKey,
            intentAt: entry.at,
          });
          continue;
        }
        if (typeof entry.idempotencyKey !== "string" || entry.idempotencyKey === "") continue;
        if (entry.type === "result") {
          // submitted and failed are terminal answers. unknown is the
          // whole reason this list exists, so it settles nothing.
          if (entry.state === "submitted" || entry.state === "failed") settled.add(entry.idempotencyKey);
          continue;
        }
        if (entry.outcome === "confirmed" || entry.outcome === "failed") settled.add(entry.idempotencyKey);
      }
      return [...open.entries()].filter(([key]) => !settled.has(key)).map(([, attempt]) => attempt);
    },
    async confirmedLivePayments() {
      const entries = await readEntries(path);
      const confirmed: ConfirmedPayment[] = [];
      for (const entry of entries) {
        if (entry.mode !== "live" || entry.type !== "resolution") continue;
        if (entry.outcome !== "confirmed") continue;
        confirmed.push({
          invoiceId: entry.invoiceId,
          to: entry.to,
          amountUsdc: entry.amountUsdc,
          at: entry.at,
          transactionId: entry.transactionId,
        });
      }
      return confirmed;
    },
  };
}
