import { createHash } from "node:crypto";
import {
  readFile,
  readdir,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseDocument, type Document } from "yaml";
import * as v from "valibot";
import {
  ReportConflict,
  type LaunchRequest,
  type SourceScan,
  type WorkItem,
  type WorkSource,
} from "./contracts.ts";
import {
  errorMessage,
  jsonValue,
  nonempty,
  record,
  stringMap,
} from "./validation.ts";

export interface TkOptions {
  id: string;
  cwd: string;
  ticketsDir?: string;
  defaultMachine?: string;
  agents?: Readonly<Record<string, string>>;
  home?: string;
}
interface Ticket {
  id: string;
  path: string;
  text: string;
  body: string;
  doc: Document;
  data: Record<string, unknown>;
  status: string;
  deps: string[];
  request: string;
  fingerprint: string;
}
const reference = v.object({ id: nonempty, fingerprint: nonempty });
const common = { summary: v.string() };
const outcomeSchema = v.variant("action", [
  v.strictObject({ action: v.literal("complete"), ...common }),
  v.strictObject({ action: v.literal("hold"), ...common }),
  v.strictObject({
    action: v.literal("route"),
    ...common,
    machine: nonempty,
    input: v.optional(jsonValue),
    agents: v.optional(stringMap),
  }),
]);
export type TicketOutcome = v.InferOutput<typeof outcomeSchema>;

/** Reads and updates tk's native files, without a second ticket database. */
export function tk(options: TkOptions): WorkSource {
  const cwd = resolve(options.cwd);
  const directory = resolve(cwd, options.ticketsDir ?? ".tickets");
  const home =
    options.home === undefined ? undefined : resolve(cwd, options.home);
  // Only metadata updates serialize. Machine executions never take this queue.
  let writes: Promise<void> = Promise.resolve();
  const serial = (write: () => Promise<void>) => {
    const next = writes.then(write);
    writes = next.catch(() => {});
    return next;
  };
  async function tickets(): Promise<{
    entries: Map<string, Ticket>;
    issues: string[];
  }> {
    const entries = new Map<string, Ticket>();
    const issues: string[] = [];
    const files = (await readdir(directory))
      .filter((name) => name.endsWith(".md"))
      .sort();
    for (const file of files) {
      try {
        const entry = await readTicket(join(directory, file));
        entries.set(entry.id, entry);
      } catch (cause) {
        issues.push(`${file}: ${errorMessage(cause)}`);
      }
    }
    return { entries, issues };
  }
  function eligible(
    ticket: Ticket,
    entries: Map<string, Ticket>,
    issues: string[],
  ): boolean {
    if (ticket.status === "closed") return false;
    const visiting = new Set<string>();
    const checked = new Set<string>();
    function visit(id: string): boolean {
      const dep = entries.get(id);
      if (!dep) {
        issues.push(`${ticket.id}: missing dependency ${id}`);
        return false;
      }
      if (visiting.has(id)) {
        issues.push(`${ticket.id}: dependency cycle at ${id}`);
        return false;
      }
      if (checked.has(id)) return true;
      visiting.add(id);
      for (const next of dep.deps) if (!visit(next)) return false;
      visiting.delete(id);
      checked.add(id);
      return true;
    }
    return (
      visit(ticket.id) &&
      ticket.deps.every((id) => entries.get(id)?.status === "closed")
    );
  }
  function item(ticket: Ticket): WorkItem {
    return {
      key: `${ticket.id}:${ticket.request}`,
      label: ticket.id,
      ref: { id: ticket.id, fingerprint: ticket.fingerprint },
    };
  }
  return {
    id: options.id,
    async scan(): Promise<SourceScan> {
      const { entries, issues } = await tickets();
      const items = [...entries.values()]
        .filter((ticket) => eligible(ticket, entries, issues))
        .map(item);
      return { items, issues: [...new Set(issues)] };
    },
    async prepare(work): Promise<LaunchRequest | undefined> {
      const ref = v.parse(reference, work.ref);
      const { entries } = await tickets();
      const ticket = entries.get(ref.id);
      if (
        !ticket ||
        item(ticket).key !== work.key ||
        ticket.fingerprint !== ref.fingerprint ||
        !eligible(ticket, entries, [])
      )
        return undefined;
      const selection =
        ticket.data.machine === undefined
          ? options.defaultMachine
          : ticket.data.machine;
      if (selection === undefined)
        throw new Error(
          `${ticket.id}: no Machine selected and no default configured`,
        );
      const machine = v.parse(nonempty, selection);
      const input = v.parse(jsonValue, {
        ticket: {
          id: ticket.id,
          source: options.id,
          title: /^#\s+(.+)$/m.exec(ticket.body)?.[1] ?? ticket.id,
          body: ticket.body,
          metadata: ticket.data,
        },
        input: ticket.data.input ?? null,
      });
      const agents =
        ticket.data.agents === undefined
          ? options.agents
          : v.parse(stringMap, ticket.data.agents);
      return {
        cwd,
        machine,
        input,
        ...(home === undefined ? {} : { home }),
        ...(agents === undefined ? {} : { agents }),
      };
    },
    apply(report): Promise<void> {
      return serial(async () => {
        const ref = v.parse(reference, report.item.ref);
        if (!/^[\w.-]+$/.test(ref.id))
          throw new ReportConflict("Invalid ticket ID");
        const ticket = await readTicket(join(directory, `${ref.id}.md`));
        const marker = `<!-- machines-dispatch:${report.attemptId} -->`;
        const legacyMarker = `<!-- auto-machines:${report.attemptId} -->`;
        // Historical writeback receipts keep their identity through the rename.
        if (ticket.body.includes(marker) || ticket.body.includes(legacyMarker)) return;
        if (
          ticket.fingerprint !== ref.fingerprint ||
          item(ticket).key !== report.item.key
        )
          throw new ReportConflict(
            `${ref.id}: ticket changed during execution; result is retained locally`,
          );
        let summary = `Attempt ${report.status}. Inspect the local execution record for details.`;
        if (report.status === "completed") {
          const parsed = v.safeParse(outcomeSchema, report.result?.output);
          if (!parsed.success)
            throw new ReportConflict(
              `${ref.id}: expected a complete, route, or hold result with a summary`,
            );
          const outcome = parsed.output;
          summary = outcome.summary;
          if (outcome.action === "complete") ticket.doc.set("status", "closed");
          else if (outcome.action === "route") {
            ticket.doc.set("status", "open");
            ticket.doc.set("machine", outcome.machine);
            if (outcome.input !== undefined)
              ticket.doc.set("input", outcome.input);
            if (outcome.agents !== undefined)
              ticket.doc.set("agents", outcome.agents);
            // Derived from the persisted attempt, so replaying writeback is idempotent.
            ticket.doc.set("machines-dispatch-request", report.attemptId);
            ticket.doc.delete("auto-machines-request");
          }
        }
        const text = `---\n${ticket.doc.toString()}---\n${ticket.body.trimEnd()}\n\n## Machines Dispatch\n\n${marker}\n${summary}\n`;
        await replace(ticket, text);
      });
    },
  };
}
async function readTicket(path: string): Promise<Ticket> {
  if (!(await lstat(path)).isFile())
    throw new Error("Ticket must be a regular file");
  const text = await readFile(path, "utf8");
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Expected YAML frontmatter");
  const doc = parseDocument(match[1]!);
  if (doc.errors.length)
    throw new Error(doc.errors.map((e) => e.message).join("; "));
  const data = v.parse(record, doc.toJS({ maxAliasCount: 100 }));
  v.parse(jsonValue, data);
  const id = v.parse(nonempty, data.id);
  if (!/^[\w.-]+$/.test(id) || basename(path) !== `${id}.md`)
    throw new Error("Ticket ID must match its filename");
  const status = v.parse(
    v.picklist(["open", "in_progress", "closed"]),
    data.status,
  );
  const deps = v.parse(v.array(nonempty), data.deps ?? []);
  const currentRequest = data["machines-dispatch-request"];
  const legacyRequest = data["auto-machines-request"];
  if (currentRequest !== undefined && legacyRequest !== undefined && currentRequest !== legacyRequest) {
    throw new Error("Conflicting machines-dispatch-request and auto-machines-request values");
  }
  const request = v.parse(nonempty, currentRequest ?? legacyRequest ?? "initial");
  const body = match[2]!;
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ data, body }))
    .digest("hex");
  return {
    id,
    path,
    text,
    body,
    doc,
    data,
    status,
    deps,
    request,
    fingerprint,
  };
}
async function replace(ticket: Ticket, text: string): Promise<void> {
  const temp = `${ticket.path}.${crypto.randomUUID()}.tmp`;
  try {
    const handle = await open(
      temp,
      "wx",
      (await lstat(ticket.path)).mode & 0o777,
    );
    try {
      await handle.writeFile(text);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if ((await readFile(ticket.path, "utf8")) !== ticket.text)
      throw new ReportConflict("Ticket changed during writeback");
    await rename(temp, ticket.path);
    const directory = await open(resolve(ticket.path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temp).catch(() => {});
  }
}
