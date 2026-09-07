/**
 * Scripted planner: reads a task file and proposes each invoice once, in
 * order. The task file is validated by hand so a typo fails the run before
 * any request is made.
 */
import { readFile } from "node:fs/promises";
import type { Proposal } from "../types";
import { CHAIN } from "../types";

export interface TaskList {
  chain: string;
  invoices: Proposal[];
}

export class TaskFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTaskList(raw: unknown, source: string): TaskList {
  if (!isRecord(raw)) throw new TaskFileError(`${source}: the task file must be a JSON object`);
  const chain = raw.chain === undefined ? CHAIN : raw.chain;
  if (typeof chain !== "string") throw new TaskFileError(`${source}: chain must be a string when present`);
  if (!Array.isArray(raw.invoices) || raw.invoices.length === 0) {
    throw new TaskFileError(`${source}: invoices must be a non-empty array`);
  }
  const seen = new Set<string>();
  const invoices: Proposal[] = raw.invoices.map((entry: unknown, index: number) => {
    const where = `${source}: invoices[${index}]`;
    if (!isRecord(entry)) throw new TaskFileError(`${where} must be an object`);
    if (typeof entry.id !== "string" || entry.id.trim() === "") {
      throw new TaskFileError(`${where}.id must be a non-empty string`);
    }
    if (seen.has(entry.id)) throw new TaskFileError(`${where}.id ${JSON.stringify(entry.id)} is used twice`);
    seen.add(entry.id);
    if (typeof entry.to !== "string" || entry.to.trim() === "") {
      throw new TaskFileError(`${where}.to must be a non-empty string`);
    }
    if (typeof entry.amountUsdc !== "number") {
      throw new TaskFileError(`${where}.amountUsdc must be a JSON number`);
    }
    if (entry.memo !== undefined && typeof entry.memo !== "string") {
      throw new TaskFileError(`${where}.memo must be a string when present`);
    }
    const proposal: Proposal = {
      invoiceId: entry.id,
      to: entry.to.trim(),
      amountUsdc: entry.amountUsdc,
      chain,
    };
    if (typeof entry.memo === "string") proposal.memo = entry.memo;
    return proposal;
  });
  return { chain, invoices };
}

export async function loadTaskList(path: string): Promise<TaskList> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskFileError(`cannot read task file ${path}: ${message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TaskFileError(`${path} is not valid JSON: ${message}`);
  }
  return parseTaskList(raw, path);
}

/** Proposes every invoice once (or only the requested one). */
export function plan(tasks: TaskList, only: string | undefined): Proposal[] {
  if (only === undefined) return tasks.invoices;
  const match = tasks.invoices.filter((invoice) => invoice.invoiceId === only);
  if (match.length === 0) {
    const ids = tasks.invoices.map((invoice) => invoice.invoiceId).join(", ");
    throw new TaskFileError(`no invoice with id ${JSON.stringify(only)}; known ids: ${ids}`);
  }
  return match;
}
