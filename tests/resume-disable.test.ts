import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { tk } from "../src/tk.ts";
import { ReportConflict } from "../src/contracts.ts";
import { definition, readTicket, ticket, until, workspace } from "./helpers.ts";

const resume = "input:\n  resume: true\n";

for (const [name, replacement] of Object.entries({
  removed: "",
  false: "input:\n  resume: false\n",
  string: 'input:\n  resume: "true"\n',
  topLevel: "resume: true\n",
})) {
  test(`disabling resume (${name}) does not admit edited work after restart`, async (t) => {
    const root = await workspace(t);
    await ticket(root, "a", resume);
    const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
    const item = (await source.scan()).items[0]!;
    const launch = (await source.prepare(item))!;
    const path = join(root, "state.sqlite");
    const before = new Store(path);
    try {
      const attempt = before.create(source.id, item, launch)!;
      const result = { state: "done", output: { action: "hold", summary: "Waiting" } };
      await source.apply({ attemptId: attempt.id, item, status: "completed", result });
      before.update(attempt.id, { status: "completed", result, delivery: "applied" });
    } finally {
      before.close();
    }
    await writeFile(join(root, ".tickets/a.md"), (await readTicket(root, "a"))
      .replace(resume, replacement)
      .replace("Acceptance criteria: verified.", "Acceptance criteria: edited."));

    // Recreate both adapter and database: suppressing work must survive a restart.
    const restarted = tk({ id: "s", cwd: root, defaultMachine: "park" });
    const store = new Store(path);
    let prepared = 0;
    const engine = new Engine(store, [{
      ...restarted,
      async prepare() { prepared++; return undefined; },
    }]);
    t.after(async () => { await engine.close(); store.close(); });
    engine.poll();
    await until(() => engine.sourcesStatus()[0]?.checkedAt, Boolean);
    assert.equal(prepared, 0, "removing resume must not admit a new key");
    assert.equal(store.list().length, 1);
    const scan = await restarted.scan();
    assert.equal(scan.items.length, 1, "retry can still find the ticket");
    const current = scan.items[0]!;
    const currentLaunch = (await restarted.prepare(current))!;
    assert.equal(store.create(source.id, current, currentLaunch), undefined,
      "the store also rejects the consumed request at creation");
    assert.ok(store.create("another-source", current, currentLaunch),
      "another source's identical key is independent");
    assert.ok(store.create(source.id, current, currentLaunch, true),
      "explicit retry can still create an attempt");
    for (const attempt of store.list())
      store.update(attempt.id, { status: "completed", delivery: "applied" });

    // A genuinely new route still runs, even with resume disabled.
    await ticket(root, "a", "machines-dispatch-request: next-route\n");
    engine.poll();
    await until(() => prepared, (count) => count === 1);
    assert.equal(prepared, 1);
  });
}

test("editing a running resume ticket preserves the writeback conflict and offers a new revision", async (t) => {
  const root = await workspace(t);
  await ticket(root, "a", resume);
  const source = tk({ id: "s", cwd: root, defaultMachine: "park" });
  const first = (await source.scan()).items[0]!;
  assert.ok(await source.prepare(first));
  await ticket(root, "a", resume, "# a\n\nA revised requirement.");
  await assert.rejects(source.apply({
    attemptId: "before-edit",
    item: first,
    status: "completed",
    result: { state: "done", output: { action: "hold", summary: "Old findings" } },
  }), ReportConflict);
  assert.doesNotMatch(await readTicket(root, "a"), /Old findings/);
  assert.equal(await source.prepare(first), undefined);
  const edited = (await source.scan()).items[0]!;
  assert.notEqual(edited.key, first.key);
  const launch = (await source.prepare(edited))!;
  assert.deepEqual((launch.input as { input: unknown }).input, { resume: true });
});

test("the engine keeps a ticket parked after resume is removed, but retry and re-enabling resume work", async (t) => {
  const root = await workspace(t);
  await definition(root, "park", "hold");
  await ticket(root, "a", `machine: park\n${resume}`);
  const store = new Store(join(root, "state.sqlite"));
  const engine = new Engine(store,
    [tk({ id: "s", cwd: root, home: join(root, "home") })], 30);
  t.after(async () => { await engine.close(); store.close(); });
  engine.start();
  const settled = (count: number) => until(() => engine.store.list(),
    (list) => list.length === count && list.every((a) => a.delivery === "applied"));
  const [first] = await settled(1);
  assert.equal(first!.status, "completed");
  // Hold admissions while writing, so the editor cannot expose a partial file.
  await until(() => engine.hold(), Boolean);
  await writeFile(join(root, ".tickets/a.md"), (await readTicket(root, "a"))
    .replace(resume, "")
    .replace("Acceptance criteria: verified.", "Acceptance criteria: edited."));
  engine.release();
  const checked = () => engine.sourcesStatus()[0]!.checkedAt;
  const scans = new Set([checked()]);
  await until(checked, (at) => scans.add(at).size >= 3);
  assert.equal(engine.store.list().length, 1);

  const retried = await engine.retry(first!.id);
  assert.equal((retried.launch.input as { input: unknown }).input, null);
  await settled(2);
  await until(() => engine.hold(), Boolean);
  await writeFile(join(root, ".tickets/a.md"), (await readTicket(root, "a"))
    .replace("deps: []\n", `deps: []\n${resume}`));
  engine.release();
  const [resumed] = await settled(3);
  assert.deepEqual((resumed!.launch.input as { input: unknown }).input, { resume: true });
  assert.notEqual(resumed!.item.key, first!.item.key);
});
