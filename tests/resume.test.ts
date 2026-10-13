import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Attempt, WorkItem, WorkSource } from "../src/contracts.ts";
import { startDaemon } from "../src/daemon.ts";
import { tk } from "../src/tk.ts";
import { workspace, ticket, definition, until, readTicket } from "./helpers.ts";

const resume = "input:\n  resume: true\n";

/** A person's edit: a line in the ticket's own text, above any note the daemon appended. */
async function answer(root: string, id: string, line: string) {
  const text = await readTicket(root, id);
  const note = text.indexOf("\n## Machines Dispatch");
  const at = note < 0 ? text.length : note;
  await save(root, id, `${text.slice(0, at).trimEnd()}\n\n${line}\n${text.slice(at)}`);
}
/** Replaces the file in one step, as an editor does, so a running daemon never reads half of it. */
async function save(root: string, id: string, text: string) {
  const path = join(root, ".tickets", `${id}.md`);
  await writeFile(`${path}.edit`, text);
  await rename(`${path}.edit`, path);
}
/** What a scan lists that no attempt has run: the items the engine would launch. */
async function fresh(source: WorkSource, attempted: readonly WorkItem[]) {
  const keys = new Set(attempted.map((item) => item.key));
  return (await source.scan()).items.filter((item) => !keys.has(item.key));
}
/** The ticket as a scan lists it now. Each ticket is listed once at most. */
async function listed(source: WorkSource, label = "a") {
  const items = (await source.scan()).items.filter((x) => x.label === label);
  assert.equal(items.length, 1, `${label} is listed once`);
  return items[0]!;
}
/** Launches the item as the engine would, then writes back the outcome of its attempt. */
async function park(
  source: WorkSource,
  item: WorkItem,
  attemptId: string,
  summary = "Need a decision",
) {
  assert.ok(await source.prepare(item), `${item.label} launches`);
  await source.apply({
    attemptId,
    item,
    status: "completed",
    result: { state: "done", output: { action: "hold", summary } },
  });
}
const launchInput = (launch: { input?: unknown } | undefined) =>
  launch!.input as { ticket: { body: string }; input: unknown };

test("a parked ticket with input.resume: true is listed as new work once a person edits it", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", `priority: 2\n${resume}`);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const first = await listed(source);
  await park(source, first, "attempt-1");
  assert.match(await readTicket(root, "a"), /status: open/);

  await answer(root, "a", "Decision: take the second option.");
  assert.deepEqual((await fresh(source, [first])).map((x) => x.label), ["a"]);
  const second = await listed(source);
  assert.notEqual(second.key, first.key);
  assert.match(
    launchInput(await source.prepare(second)).ticket.body,
    /Decision: take the second option\./,
  );
  // The attempted item is stale, so the engine can only launch the new one.
  assert.equal(await source.prepare(first), undefined);
  await park(source, second, "attempt-2");

  // A field the daemon never sets is the owner's content as much as the body is.
  await save(
    root,
    "a",
    (await readTicket(root, "a")).replace("priority: 2\n", "priority: 1\n"),
  );
  const third = await listed(source);
  assert.equal(new Set([first.key, second.key, third.key]).size, 3);
  assert.ok(await source.prepare(third));
});

test("an answer appended below the daemon's note resumes the ticket exactly once", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", resume);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const first = await listed(source);
  await park(source, first, "attempt-1", "Need an answer.\n\n## Question\nWhich option?");
  assert.deepEqual(await fresh(source, [first]), []);

  await save(root, "a", `${await readTicket(root, "a")}\nAnswer: take the second option.\n`);
  const [second] = await fresh(source, [first]);
  assert.ok(second, "an answer at the very end is new work");
  assert.notEqual(second.key, first.key);
  const launch = launchInput(await source.prepare(second));
  assert.deepEqual(launch.input, { resume: true });
  assert.match(launch.ticket.body, /Answer: take the second option\.\n$/);
  await park(source, second, "attempt-2", "Still waiting.\r\n\r\n## Question\r\nWhen?");
  assert.deepEqual(await fresh(source, [first, second]), []);

  // A further answer beneath the next note also counts.
  await save(root, "a", `${await readTicket(root, "a")}Answer: today.\n`);
  const [third] = await fresh(source, [first, second]);
  assert.ok(third);
  await park(source, third, "attempt-3", "");
  assert.deepEqual(await fresh(source, [first, second, third]), []);
});

test("a ticket with input.resume: true is not listed again while its content is unchanged", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", resume);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const first = await listed(source);
  await park(source, first, "attempt-1");
  assert.deepEqual(await fresh(source, [first]), []);
  assert.deepEqual(await fresh(source, [first]), []);
  // Saving the same text again is not a change.
  await save(root, "a", await readTicket(root, "a"));
  assert.deepEqual(await fresh(source, [first]), []);

  await answer(root, "a", "Decision: take the second option.");
  const second = await listed(source);
  assert.notEqual(second.key, first.key);
  await park(source, second, "attempt-2");
  assert.deepEqual(await fresh(source, [first, second]), []);
  assert.deepEqual(await fresh(source, [first, second]), []);
});

test("the daemon's writeback is not a change: scan, launch, writeback, and scan again lists nothing", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", resume);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  // A summary is the Machine's own text, and may carry headings of its own.
  const summary =
    "Parked for a decision.\n\n## Open question\n\nWhich option should ship?\n\n## Next step\n\nAnswer in the ticket.";
  const first = await listed(source);
  await park(source, first, "attempt-1", summary);
  assert.match(await readTicket(root, "a"), /## Machines Dispatch\n\n<!-- machines-dispatch:attempt-1 -->\nParked for a decision\./);
  assert.ok((await readTicket(root, "a")).endsWith(`${summary.replace(/\s+/g, " ")}\n`),
    "the complete multiline summary is retained on one line");
  assert.deepEqual(await fresh(source, [first]), []);

  // A retried attempt that fails writes its own note under the same request.
  await source.apply({
    attemptId: "attempt-2",
    item: await listed(source),
    status: "failed",
    error: "Agent stopped",
  });
  assert.match(await readTicket(root, "a"), /<!-- machines-dispatch:attempt-2 -->\nAttempt failed\./);
  assert.deepEqual(await fresh(source, [first]), []);

  await answer(root, "a", "Decision: ship the second option.");
  const second = await listed(source);
  assert.notEqual(second.key, first.key);
  await park(source, second, "attempt-3", summary);
  assert.match(await readTicket(root, "a"), /<!-- machines-dispatch:attempt-3 -->\nParked for a decision\./);
  assert.deepEqual(await fresh(source, [first, second]), []);

  await answer(root, "a", "Decision: ship it this week.");
  const third = await listed(source);
  assert.equal(new Set([first.key, second.key, third.key]).size, 3);
});

test("the fields a route writes are not a person's edit", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", `machine: research\n${resume}`);
  const source = tk({ id: "s", cwd: root });
  const first = await listed(source);
  assert.ok(await source.prepare(first));
  await source.apply({
    attemptId: "route-1",
    item: first,
    status: "completed",
    result: {
      state: "done",
      output: {
        action: "route",
        machine: "implement",
        agents: { implementer: "codex" },
        summary: "Ready to implement",
      },
    },
  });
  const routed = await readTicket(root, "a");
  assert.match(routed, /machine: implement/);
  assert.match(routed, /implementer: codex/);
  assert.match(routed, /machines-dispatch-request: route-1/);
  // Routing is one new request, as before.
  const second = await listed(source);
  assert.notEqual(second.key, first.key);
  const launch = await source.prepare(second);
  assert.equal(launch?.machine, "implement");
  assert.deepEqual(launchInput(launch).input, { resume: true });
  await park(source, second, "attempt-2");
  assert.deepEqual(await fresh(source, [first, second]), []);

  await answer(root, "a", "Decision: take the second option.");
  const third = await listed(source);
  assert.equal(new Set([first.key, second.key, third.key]).size, 3);
  assert.equal((await source.prepare(third))?.machine, "implement");
});

test("changed content without input.resume: true is not listed again", async (t) => {
  const root = await workspace(t);
  const fields: Record<string, string> = {
    resumes: resume,
    absent: "",
    other: "input:\n  base: main\n",
    off: "input:\n  resume: false\n",
    text: 'input:\n  resume: "true"\n',
    outside: "resume: true\n",
  };
  for (const [id, field] of Object.entries(fields)) await ticket(root, id, field);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const attempted = (await source.scan()).items;
  assert.equal(attempted.length, Object.keys(fields).length);
  for (const item of attempted) await park(source, item, `first-${item.label}`);
  assert.deepEqual(await fresh(source, attempted), []);

  for (const id of Object.keys(fields))
    await answer(root, id, "Decision: take the second option.");
  assert.deepEqual(
    (await fresh(source, attempted)).map((item) => item.label),
    ["resumes"],
  );
  // Every ticket stays listed under its own name, so `retry` still finds it.
  assert.deepEqual(
    (await source.scan()).items.map((item) => item.label).sort(),
    Object.keys(fields).sort(),
  );

  // The owner then marks one of the edited tickets to resume.
  await save(
    root,
    "absent",
    (await readTicket(root, "absent")).replace("deps: []\n", `deps: []\n${resume}`),
  );
  assert.deepEqual(
    (await fresh(source, attempted)).map((item) => item.label).sort(),
    ["absent", "resumes"],
  );
});

test("the launch for a resumed item passes resume: true in input.input", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", "input:\n  resume: true\n  base: main\n");
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const first = await listed(source);
  await park(source, first, "attempt-1");
  await answer(root, "a", "Decision: take the second option.");
  const [resumed] = await fresh(source, [first]);
  assert.ok(resumed, "the edited ticket is listed as new work");
  const input = launchInput(await source.prepare(resumed));
  // What `npm run ticket -- <id> --resume` adds to the ticket's own input.
  assert.deepEqual(input.input, { resume: true, base: "main" });
  assert.match(input.ticket.body, /Decision: take the second option\./);
});

type Daemon = Awaited<ReturnType<typeof startDaemon>>;
const attempts = (daemon: Daemon, label: string): Attempt[] =>
  daemon.engine.store
    .list()
    .filter((attempt) => attempt.item.label === label)
    .reverse();
const settled = (list: Attempt[], count: number) =>
  list.length === count && list.every((a) => a.delivery === "applied");
/** Waits for two more scans to finish; the second began after this call. */
async function rescanned(daemon: Daemon) {
  const checked = () => daemon.engine.sourcesStatus()[0]!.checkedAt;
  const seen = new Set([checked()]);
  await until(checked, (at) => seen.add(at).size >= 3);
}

test("the daemon launches a parked resume: true ticket again after an edit, and not after its own writeback", async (t) => {
  const root = await workspace(t);
  await definition(root, "park", "hold");
  await ticket(root, "a", "machine: park\ninput:\n  resume: true\n  base: main\n");
  const source = tk({ id: "s", cwd: root, home: join(root, "home") });
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [source],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  const [first] = await until(
    () => attempts(daemon, "a"),
    (list) => settled(list, 1),
  );
  assert.equal(first!.status, "completed");
  assert.match(await readTicket(root, "a"), /## Machines Dispatch/);
  assert.match(await readTicket(root, "a"), /status: open/);
  await rescanned(daemon);
  assert.equal(attempts(daemon, "a").length, 1);

  await save(root, "a", `${await readTicket(root, "a")}\nDecision: take the second option.\n`);
  assert.notEqual((await listed(source)).key, first!.item.key);
  const [, second] = await until(
    () => attempts(daemon, "a"),
    (list) => settled(list, 2),
  );
  assert.equal(second!.status, "completed");
  assert.notEqual(second!.item.key, first!.item.key);
  const input = launchInput(second!.launch);
  assert.deepEqual(input.input, { resume: true, base: "main" });
  assert.match(input.ticket.body, /Decision: take the second option\./);
  assert.match(
    await readTicket(root, "a"),
    new RegExp(`<!-- machines-dispatch:${second!.id} -->`),
  );
  await rescanned(daemon);
  assert.equal(attempts(daemon, "a").length, 2);
});

test("retry still launches a parked ticket, with and without input.resume: true", async (t) => {
  const root = await workspace(t);
  await definition(root, "park", "hold");
  await ticket(root, "a", `machine: park\n${resume}`);
  await ticket(root, "b", "machine: park\n");
  const source = tk({ id: "s", cwd: root, home: join(root, "home") });
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [source],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  const parked = (label: string, count: number) =>
    until(
      () => attempts(daemon, label),
      (list) => settled(list, count),
    );
  const [firstA] = await parked("a", 1);
  const [firstB] = await parked("b", 1);

  // Unchanged tickets: only a deliberate retry runs them again.
  await rescanned(daemon);
  assert.equal(daemon.engine.store.list().length, 2);
  const retriedA = await daemon.engine.retry(firstA!.id);
  assert.notEqual(retriedA.id, firstA!.id);
  assert.deepEqual(launchInput(retriedA.launch).input, { resume: true });
  await parked("a", 2);

  // Edited tickets: the one marked to resume launches itself, the other waits for retry.
  await answer(root, "a", "Decision: take the second option.");
  await answer(root, "b", "Decision: take the second option.");
  assert.notEqual((await listed(source)).key, firstA!.item.key);
  const resumed = (await parked("a", 3))[2]!;
  assert.notEqual(resumed.item.key, firstA!.item.key);
  await rescanned(daemon);
  assert.equal(attempts(daemon, "b").length, 1);
  const retriedB = await daemon.engine.retry(firstB!.id);
  assert.notEqual(retriedB.id, firstB!.id);
  assert.equal(launchInput(retriedB.launch).input, null);
  assert.match(
    launchInput(retriedB.launch).ticket.body,
    /Decision: take the second option\./,
  );
  await parked("b", 2);

  // A resumed attempt can be retried too, and its writeback starts nothing more.
  const again = await daemon.engine.retry(resumed.id);
  assert.equal(again.item.key, resumed.item.key);
  await parked("a", 4);
  await rescanned(daemon);
  assert.equal(attempts(daemon, "a").length, 4);
  assert.equal(attempts(daemon, "b").length, 2);
  assert.ok(daemon.engine.store.list().every((a) => a.status === "completed"));
});

test("README explains the resume rule where it describes writeback and retry", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const sections = readme
    .split(/^(?=## )/m)
    .filter((section) => /writeback/i.test(section) && /`retry`/.test(section));
  assert.ok(sections.length > 0, "a section describes writeback and retry");
  const paragraphs = sections.flatMap((section) => section.split(/\n\s*\n/));
  assert.ok(
    paragraphs.some(
      (paragraph) =>
        /input\.resume|resume: true/.test(paragraph) &&
        /\bedit|\bchang/i.test(paragraph),
    ),
    "that section says an edited ticket carrying input.resume: true launches again",
  );
});
