import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { startDaemon } from "../src/daemon.ts";
import { request } from "../src/client.ts";
import { tk } from "../src/tk.ts";
import { Store } from "../src/store.ts";
import { workspace, ticket, definition, until, readTicket } from "./helpers.ts";

test("parallel Human runs and routed work survive client disconnect", async (t) => {
  const root = await workspace(t);
  await definition(root, "research", "route");
  await definition(root, "implement", "complete", true);
  await ticket(root, "a");
  await ticket(root, "b", "machine: implement\n");
  const stateDir = join(root, "state");
  const sources = [
    tk({
      id: "op",
      cwd: root,
      home: join(root, "home"),
      defaultMachine: "research",
    }),
  ];
  const daemon = await startDaemon({ stateDir, sources, intervalMs: 30 });
  t.after(() => daemon.close());
  await assert.rejects(startDaemon({ stateDir, sources }), /already owns/);
  const runs = await until(
    () => daemon.engine.store.list(),
    (list) => list.filter((a) => a.status === "waiting").length === 2,
  );
  const waiting = runs.filter((a) => a.status === "waiting");
  assert.equal(new Set(waiting.map((a) => a.item.label)).size, 2);
  await assert.rejects(
    request(stateDir, "respond", {
      id: waiting[0]!.id,
      requestId: waiting[1]!.human!.requestId,
      response: "yes",
    }),
    /stale/,
  );
  await Promise.all(
    waiting.map((a) =>
      request(stateDir, "respond", {
        id: a.id,
        requestId: a.human!.requestId,
        response: "yes",
      }),
    ),
  );
  await until(
    () => daemon.engine.store.list(),
    (list) => list.length === 3 && list.every((a) => a.delivery === "applied"),
  );
  assert.match(await readTicket(root, "a"), /status: closed/);
  assert.match(await readTicket(root, "b"), /status: closed/);
  assert.ok(
    ((await request(stateDir, "logs", { id: waiting[0]!.id })) as unknown[])
      .length > 0,
  );
  await daemon.close();
  const restarted = await startDaemon({ stateDir, sources, intervalMs: 30 });
  t.after(() => restarted.close());
  assert.equal(restarted.engine.store.list().length, 3);
});
test("failed writeback retries without rerunning the Machine", async (t) => {
  const root = await workspace(t);
  await definition(root, "work");
  await ticket(root, "a", "machine: work\n");
  const source = tk({ id: "s", cwd: root, home: join(root, "home") });
  let writes = 0;
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [
      {
        ...source,
        async apply(report) {
          writes++;
          if (writes === 1) throw new Error("offline");
          await source.apply(report);
        },
      },
    ],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  await until(
    () => daemon.engine.store.list(),
    (list) => list.length === 1 && list[0]!.delivery === "applied",
  );
  assert.equal(writes, 2);
  assert.equal(daemon.engine.store.list().length, 1);
});
test("stop/restart marks interrupted work and accepts only deliberate retry", async (t) => {
  const root = await workspace(t);
  await definition(root, "work", "complete", true);
  await ticket(root, "a", "machine: work\n");
  const options = {
    stateDir: join(root, "state"),
    sources: [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  };
  const first = await startDaemon(options);
  t.after(() => first.close());
  const original = (
    await until(
      () => first.engine.store.list(),
      (list) => list[0]?.status === "waiting",
    )
  )[0]!;
  await first.close();
  const second = await startDaemon(options);
  t.after(() => second.close());
  await until(
    () => second.engine.store.get(original.id),
    (a) => a.delivery === "applied",
  );
  assert.equal(second.engine.store.get(original.id).status, "interrupted");
  assert.equal(second.engine.store.list().length, 1);
  await assert.rejects(
    second.engine.respond(original.id, original.human!.requestId, "yes"),
    /stale/,
  );
  const retry = await second.engine.retry(original.id);
  assert.notEqual(retry.id, original.id);
  await until(
    () => second.engine.store.get(retry.id),
    (a) => a.status === "waiting",
  );
  second.engine.cancel(retry.id);
  await until(
    () => second.engine.store.get(retry.id),
    (a) => a.delivery === "applied",
  );
  assert.equal(second.engine.store.get(retry.id).status, "cancelled");
});
test("bad selections and unavailable sources do not stall other projects", async (t) => {
  const one = await workspace(t);
  const two = await workspace(t);
  await definition(two, "ok");
  await ticket(two, "good", "machine: ok\n");
  await ticket(one, "bad", "machine: missing\n");
  const daemon = await startDaemon({
    stateDir: join(one, "state"),
    sources: [
      tk({
        id: "one",
        cwd: one,
        defaultMachine: "ok",
        home: join(one, "home"),
      }),
      tk({ id: "two", cwd: two, home: join(two, "home") }),
      tk({ id: "absent", cwd: join(one, "missing") }),
    ],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  await until(
    () => daemon.engine.store.list(),
    (list) => list.some((a) => a.delivery === "applied"),
  );
  await until(
    () => daemon.engine.sourcesStatus(),
    (list) =>
      list.some((s) =>
        s.issues.some((x) => x.includes("not in the discovered")),
      ),
  );
  assert.equal(daemon.engine.store.list().length, 1);
});
test("startup recovers a persisted starting attempt without replay", async (t) => {
  const root = await workspace(t);
  const path = join(root, "records.sqlite");
  const first = new Store(path);
  const a = first.create(
    "s",
    { key: "a:initial", label: "a", ref: null },
    { cwd: root, machine: "missing" },
  )!;
  first.close();
  const next = new Store(path);
  t.after(() => next.close());
  next.recover();
  assert.equal(next.get(a.id).status, "interrupted");
  assert.equal(next.get(a.id).delivery, "pending");
});

test("one shared DAG dispatches work into five repositories", async (t) => {
  const { mkdir, readFile } = await import("node:fs/promises");
  const root = await workspace(t);
  await writeFile(
    join(root, ".machines", "implement.ts"),
    `
import {writeFile} from "node:fs/promises";
export const description="Works in the ticket's repository";
export default ({machine,operation,final},input)=>machine({initial:"work",output:()=>({action:"complete",summary:"Verified"}),states:{
work:operation(async()=>{await writeFile(input.input.repository+"/result.txt",input.ticket.id);return {type:"done"};},{done:"done"}),done:final()}});`,
  );
  for (let i = 1; i <= 5; i++) {
    await mkdir(join(root, `repo-${i}`));
    await writeFile(
      join(root, ".tickets", `task-${i}.md`),
      `---\nid: task-${i}\nstatus: open\ndeps: [${i === 2 || i === 3 ? `task-${i - 1}` : ""}]\nmachine: implement\ninput:\n  repository: repo-${i}\n---\n# Work ${i}\n`,
    );
  }
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [tk({ id: "op", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  await until(
    () => daemon.engine.store.list(),
    (list) => list.length === 5 && list.every((a) => a.delivery === "applied"),
  );
  for (let i = 1; i <= 5; i++)
    assert.equal(
      await readFile(join(root, `repo-${i}/result.txt`), "utf8"),
      `task-${i}`,
    );
});
test("missing agent bindings fail before workflow effects and retain a retryable attempt", async (t) => {
  const { access } = await import("node:fs/promises");
  const root = await workspace(t);
  await ticket(root, "a", "machine: invalid\n");
  await writeFile(
    join(root, ".machines/invalid.ts"),
    `
import {writeFileSync} from "node:fs";
export const description="Fails preflight";export const agentRoles={unconfigured:"Required"};
export default ({machine,operation,agent,final})=>machine({initial:"work",states:{
work:operation(()=>{writeFileSync("effect.txt","wrong");return {type:"done"}},{done:"agent"}),
agent:agent("Work",{completed:"done"},{using:"unconfigured"}),done:final()}});`,
  );
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  const attempts = await until(
    () => daemon.engine.store.list(),
    (list) => list[0]?.status === "failed" && list[0].delivery === "applied",
  );
  assert.match(attempts[0]!.error!, /unconfigured/);
  await assert.rejects(access(join(root, "effect.txt")));
  assert.doesNotMatch(await readTicket(root, "a"), new RegExp(root));
});

test("where run status is published, each attempt's run is published under its ticket's name", async (t) => {
  const root = await workspace(t);
  await definition(root, "review", "complete", true);
  await ticket(root, "a", "", "# Fix the widget\n\nAcceptance criteria: verified.");
  await ticket(root, "b");
  const source = tk({
    id: "op",
    cwd: root,
    home: join(root, "home"),
    defaultMachine: "review",
  });
  const launches = await Promise.all(
    (await source.scan()).items.map((item) => source.prepare(item)),
  );
  assert.deepEqual(launches.map((launch) => launch!.label).sort(), [
    "a: Fix the widget",
    "b",
  ]);
  const directory = join(root, "runs");
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  t.after(() => {
    process.env.MACHINES_RUN_STATUS_DIR = "off";
  });
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [source],
    intervalMs: 30,
  });
  t.after(() => daemon.close());
  const records = async () =>
    Promise.all(
      (await readdir(directory).catch(() => []))
        .filter(
          (name) =>
            !name.startsWith(".") &&
            name.endsWith(".json") &&
            !name.endsWith(".checkpoint.json"),
        )
        .map(async (name) =>
          JSON.parse(await readFile(join(directory, name), "utf8")),
        ),
    );
  const published = await until(records, (list) =>
    list.length === 2 && list.every((record) => record.status === "sleeping"),
  );
  assert.deepEqual(
    published
      .map((record) => [record.label, record.machine, record.continuedBy])
      .sort(),
    [
      ["a: Fix the widget", "review", "host"],
      ["b", "review", "host"],
    ],
  );
});
