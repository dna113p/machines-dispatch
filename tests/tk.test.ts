import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tk } from "../src/tk.ts";
import { workspace, ticket, readTicket } from "./helpers.ts";

test("readiness validates dependencies and isolates malformed tickets", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a");
  await ticket(root, "b", "machine: build\n");
  await writeFile(
    join(root, ".tickets", "c.md"),
    "---\nid: c\nstatus: open\ndeps: [a]\n---\n# depends\n",
  );
  await writeFile(
    join(root, ".tickets", "d.md"),
    "---\nid: d\nstatus: open\ndeps: [d]\n---\n# cycle\n",
  );
  await writeFile(
    join(root, ".tickets", "e.md"),
    "---\nid: e\nstatus: open\ndeps: [absent]\n---\n# missing\n",
  );
  await writeFile(join(root, ".tickets", "bad.md"), "broken");
  const source = tk({ id: "op", cwd: root, defaultMachine: "research" });
  const scan = await source.scan();
  assert.deepEqual(
    scan.items.map((x) => x.label),
    ["a", "b"],
  );
  assert.ok(scan.issues?.some((x) => x.includes("cycle")));
  assert.ok(scan.issues?.some((x) => x.includes("missing dependency")));
  assert.equal((await source.prepare(scan.items[0]!))?.machine, "research");
  assert.equal((await source.prepare(scan.items[1]!))?.machine, "build");
});
test("routing and completion preserve metadata and write results idempotently", async (t) => {
  const root = await workspace(t);
  await ticket(
    root,
    "a",
    "machine: research\ncustom: retained\ninput: false\n",
  );
  const source = tk({ id: "op", cwd: root });
  const item = (await source.scan()).items[0]!;
  const launch = await source.prepare(item);
  assert.equal((launch!.input as { input: unknown }).input, false);
  const report = {
    attemptId: "route-1",
    item,
    status: "completed" as const,
    result: {
      state: "done",
      output: {
        action: "route",
        machine: "implement",
        input: { task: "fix" },
        summary: "Ready",
      },
    },
  };
  await source.apply(report);
  const first = await readTicket(root, "a");
  await source.apply(report);
  assert.equal(await readTicket(root, "a"), first);
  assert.match(first, /custom: retained/);
  assert.match(first, /machines-dispatch-request: route-1/);
  const next = (await source.scan()).items[0]!;
  assert.notEqual(next.key, item.key);
  assert.equal((await source.prepare(next))?.machine, "implement");
  await source.apply({
    attemptId: "finish",
    item: next,
    status: "completed",
    result: { state: "done", output: { action: "complete", summary: "Done" } },
  });
  assert.equal((await source.scan()).items.length, 0);
});
test("edited tickets and invalid results never get silently closed", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", "machine: example\n");
  const source = tk({ id: "s", cwd: root });
  const item = (await source.scan()).items[0]!;
  await assert.rejects(
    source.apply({
      attemptId: "1",
      item,
      status: "completed",
      result: { state: "done" },
    }),
    /expected a complete/,
  );
  await writeFile(
    join(root, ".tickets/a.md"),
    (await readTicket(root, "a")) + "New requirement\n",
  );
  assert.equal(await source.prepare(item), undefined);
  await assert.rejects(
    source.apply({
      attemptId: "2",
      item,
      status: "completed",
      result: { state: "done", output: { action: "complete", summary: "ok" } },
    }),
    /changed during execution/,
  );
  assert.match(await readTicket(root, "a"), /status: open/);
});
test("hold records findings without closing or manufacturing another request", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a");
  const source = tk({ id: "s", cwd: root, defaultMachine: "research" });
  const item = (await source.scan()).items[0]!;
  await source.apply({
    attemptId: "hold",
    item,
    status: "completed",
    result: {
      state: "done",
      output: { action: "hold", summary: "Need a decision" },
    },
  });
  assert.equal((await source.scan()).items[0]!.key, item.key);
  assert.match(await readTicket(root, "a"), /Need a decision/);
});


test("legacy routed tickets retain identity and new routing writes canonical metadata", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", "machine: research\nauto-machines-request: old-attempt\n");
  const source = tk({ id: "s", cwd: root });
  const item = (await source.scan()).items[0]!;
  assert.equal(item.key, "a:old-attempt");
  assert.ok(await source.prepare(item));
  await source.apply({ attemptId: "new-attempt", item, status: "completed", result: {
    state: "done", output: { action: "route", machine: "implement", summary: "Ready" },
  } });
  const text = await readTicket(root, "a");
  assert.match(text, /machines-dispatch-request: new-attempt/);
  assert.doesNotMatch(text, /auto-machines-request:/);
  assert.match(text, /## Machines Dispatch/);
  assert.match(text, /<!-- machines-dispatch:new-attempt -->/);
  assert.equal((await source.scan()).items[0]!.key, "a:new-attempt");
});

test("legacy tk writeback markers prevent replay after the rename", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", "machine: research\n");
  const source = tk({ id: "s", cwd: root });
  const item = (await source.scan()).items[0]!;
  const applied = (await readTicket(root, "a")) + "\n## Auto Machines\n\n<!-- auto-machines:old-result -->\nAlready reported\n";
  await writeFile(join(root, ".tickets/a.md"), applied);
  await source.apply({ attemptId: "old-result", item, status: "completed", result: {
    state: "done", output: { action: "hold", summary: "Already reported" },
  } });
  assert.equal(await readTicket(root, "a"), applied);
});

test("conflicting legacy and canonical request IDs are not scheduled", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", "auto-machines-request: one\nmachines-dispatch-request: two\n");
  const source = tk({ id: "s", cwd: root, defaultMachine: "work" });
  const result = await source.scan();
  assert.equal(result.items.length, 0);
  assert.match(result.issues!.join(" "), /conflicting.*request/i);
  await ticket(root, "a", "auto-machines-request: one\nmachines-dispatch-request: one\n");
  assert.equal((await source.scan()).items[0]!.key, "a:one");
});
