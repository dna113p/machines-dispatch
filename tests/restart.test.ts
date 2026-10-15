import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startMachineHost } from "@dna113p/machines/host";
import { startDaemon } from "../src/daemon.ts";
import { request } from "../src/client.ts";
import { tk } from "../src/tk.ts";
import { Store } from "../src/store.ts";
import { Engine } from "../src/engine.ts";
import type { Attempt } from "../src/contracts.ts";
import { workspace, ticket, definition, until, readTicket } from "./helpers.ts";

/** An attempt as `status` reports it, with the fields this ticket adds. */
type Seen = Attempt & { cutOff?: true; continued?: number };
interface Logged {
  event: { type?: string; runId?: string };
}
async function attempts(stateDir: string): Promise<Seen[]> {
  return ((await request(stateDir, "status")) as { attempts: Seen[] })
    .attempts;
}
function publishTo(t: TestContext, directory: string) {
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  t.after(() => {
    process.env.MACHINES_RUN_STATUS_DIR = "off";
  });
}
const record = async (directory: string, id: string) =>
  JSON.parse(await readFile(join(directory, `${id}.json`), "utf8"));
const lines = async (path: string) =>
  (await readFile(path, "utf8").catch(() => "")).split("\n").filter(Boolean);
const count = (list: string[], line: string) =>
  list.filter((entry) => entry === line).length;
/** Reads the journal while no daemon owns it. */
function journal(stateDir: string): Seen[] {
  const store = new Store(join(stateDir, "executions.sqlite"));
  try {
    return store.list() as Seen[];
  } finally {
    store.close();
  }
}

/**
 * `first` records itself once, then `second` records itself and holds until
 * a `go` file appears. Stopping the daemon in `second` cuts the run off with
 * a checkpoint at `second`; continuing it must not run `first` again.
 */
async function setup(t: TestContext) {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  const log = join(root, "log.txt");
  const go = join(root, "go");
  await writeFile(
    join(root, ".machines", "steps.ts"),
    `
import {appendFileSync, existsSync} from "node:fs";
export const description = "Two recorded steps, the second held until released";
export default function ({machine, operation, final}) {
  return machine({ initial: "first", output: () => ({action: "complete", summary: "Verified"}), states: {
    first: operation(() => { appendFileSync(${JSON.stringify(log)}, "first\\n"); return {type:"done"}; }, {done:"second"}),
    second: operation(async () => {
      appendFileSync(${JSON.stringify(log)}, "second\\n");
      while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 20));
      return {type:"done"};
    }, {done:"done"}),
    done: final()
  }});
}`,
  );
  await ticket(root, "a", "machine: steps\n");
  const options = {
    stateDir: join(root, "state"),
    sources: [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  };
  const start = async () => {
    const daemon = await startDaemon(options);
    t.after(() => daemon.close());
    return daemon;
  };
  /** Waits until the run is inside `second` for the given time. */
  const inSecond = (times: number) =>
    until(
      async () => ({ list: await attempts(options.stateDir), log: await lines(log) }),
      ({ list, log }) =>
        list[0]?.status === "running" &&
        list[0]?.state === "second" &&
        count(log, "second") === times,
    );
  return { root, runs, log, go, stateDir: options.stateDir, start, inSecond };
}

test("a run cut off by a stop continues from its checkpoint as the same attempt, once", async (t) => {
  const { root, runs, log, go, stateDir, start, inSecond } = await setup(t);
  const daemon = await start();
  const {
    list: [running],
  } = await inSecond(1);
  const runId = running!.runId!;
  assert.ok(runId);
  const before = await readTicket(root, "a");
  await daemon.close();

  // Stopped: the run is cut off, its checkpoint kept, and nothing is written back yet.
  const [stopped] = journal(stateDir);
  assert.equal(stopped!.id, running!.id);
  assert.equal(stopped!.status, "interrupted");
  assert.equal(stopped!.cutOff, true);
  assert.equal(stopped!.delivery, "none");
  assert.equal(await readTicket(root, "a"), before);
  await access(join(runs, `${runId}.checkpoint.json`));

  // A run Dispatch did not start, cut off in the same directory, is never continued.
  const foreignLog = join(root, "foreign.txt");
  await writeFile(
    join(root, ".machines", "foreign.ts"),
    `
import {appendFileSync} from "node:fs";
export const description = "A run nobody asked Dispatch for";
export default function ({machine, operation, final}) {
  return machine({ initial: "hang", states: {
    hang: operation(() => { appendFileSync(${JSON.stringify(foreignLog)}, "hang\\n"); return new Promise(() => {}); }, {}),
  }});
}`,
  );
  const controller = new AbortController();
  const foreign = await startMachineHost({
    cwd: root,
    home: join(root, "home"),
    machine: join(root, ".machines", "foreign.ts"),
    sleep: true,
    publishRunStatus: true,
    signal: controller.signal,
  });
  const foreignResult = foreign.result.catch(() => undefined);
  await until(() => lines(foreignLog), (list) => list.length === 1);
  controller.abort();
  await foreignResult;
  await until(
    () => record(runs, foreign.id),
    (value) => value.status === "failed",
  );
  await access(join(runs, `${foreign.id}.checkpoint.json`));

  const restarted = await start();
  await inSecond(2);
  await writeFile(go, "");
  const list = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(list.length, 1, "the continued run stays the same attempt");
  const [done] = list;
  assert.equal(done!.id, running!.id);
  assert.equal(done!.runId, runId);
  assert.equal(done!.status, "completed");
  assert.equal(done!.continued, 1);
  assert.equal(done!.cutOff, undefined);
  assert.equal(done!.error, undefined);
  assert.match(await readTicket(root, "a"), /status: closed/);
  assert.doesNotMatch(await readTicket(root, "a"), /Attempt interrupted/);
  assert.equal((await record(runs, runId)).status, "completed");

  const recorded = await lines(log);
  assert.equal(count(recorded, "first"), 1, "continued from the checkpoint, not replayed");
  assert.equal(count(recorded, "second"), 2);
  const events = restarted.engine.store.events(running!.id) as Logged[];
  const continued = events.filter((entry) => entry.event.type === "continued");
  assert.equal(continued.length, 1, "continued once");
  assert.equal(continued[0]!.event.runId, runId);

  assert.equal((await record(runs, foreign.id)).status, "failed");
  assert.deepEqual(await lines(foreignLog), ["hang"]);
});

test("a second cut-off of the same attempt is reported in status and not continued", async (t) => {
  const { root, runs, log, stateDir, start, inSecond } = await setup(t);
  const daemon = await start();
  const {
    list: [running],
  } = await inSecond(1);
  const runId = running!.runId!;
  await daemon.close();

  const continuing = await start();
  await inSecond(2);
  await continuing.close();
  const [again] = journal(stateDir);
  assert.equal(again!.status, "interrupted");
  assert.equal(again!.continued, 1);

  const last = await start();
  await until(
    () => last.engine.sourcesStatus(),
    (list) => list.every((source) => source.checkedAt !== undefined),
  );
  const [reported] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(reported!.id, running!.id);
  assert.equal(reported!.runId, runId);
  assert.equal(reported!.status, "interrupted");
  assert.equal(reported!.continued, 1);
  assert.equal(reported!.cutOff, undefined);
  assert.match(reported!.error ?? "", /Cut off again/);
  assert.match(await readTicket(root, "a"), /Attempt interrupted\./);
  assert.match(await readTicket(root, "a"), /status: open/);

  // Not continued a second time.
  await delay(500);
  assert.equal(count(await lines(log), "second"), 2);
  assert.equal(count(await lines(log), "first"), 1);
  assert.equal((await record(runs, runId)).status, "failed");
  const [after] = await attempts(stateDir);
  assert.equal(after!.status, "interrupted");
  const events = last.engine.store.events(running!.id) as Logged[];
  assert.equal(
    events.filter((entry) => entry.event.type === "continued").length,
    1,
  );
});

test("a recovered cut-off attempt refuses retry before startup decides its continuation", async (t) => {
  const root = await workspace(t);
  publishTo(t, join(root, "runs"));
  await definition(root, "work");
  await ticket(root, "a", "machine: work\n");
  const source = tk({ id: "s", cwd: root, home: join(root, "home") });
  const item = (await source.scan()).items[0]!;
  const launch = (await source.prepare(item))!;
  const store = new Store(":memory:");
  const attempt = store.create(source.id, item, launch)!;
  // The persisted journal still says running after an unclean exit.
  store.update(attempt.id, { status: "running", runId: "lost-run" });
  const engine = new Engine(store, [source]);
  t.after(async () => {
    await engine.close();
    store.close();
  });
  const recovered = store.get(attempt.id);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.cutOff, true);
  assert.equal(recovered.delivery, "none");
  assert.equal(engine.hold(), false);
  await assert.rejects(engine.retry(attempt.id), /prior attempt/);
  assert.equal(store.list().length, 1);
  engine.start();
  await until(() => store.get(attempt.id), (a) => a.delivery === "applied");
  assert.equal(store.get(attempt.id).cutOff, undefined);
  assert.equal(store.get(attempt.id).status, "interrupted");
  assert.equal(store.get(attempt.id).continued, undefined);
});

test("a missing checkpoint reports an interrupted attempt without replaying the workflow", async (t) => {
  const { root, runs, log } = await setup(t);
  const store = new Store(":memory:");
  const engines: Engine[] = [];
  t.after(async () => {
    for (const engine of engines) await engine.close();
    store.close();
  });
  const start = () => {
    const engine = new Engine(
      store,
      [tk({ id: "s", cwd: root, home: join(root, "home") })],
      30,
    );
    engines.push(engine);
    engine.start();
    return engine;
  };
  const engine = start();
  const running = await until(
    () => store.list()[0],
    (a) => a?.status === "running" && a.state === "second",
  );
  await until(() => lines(log), (list) => count(list, "second") === 1);
  await engine.close();
  await rm(join(runs, `${running!.runId}.checkpoint.json`));
  start();
  const reported = await until(
    () => store.get(running!.id),
    (a) => a.delivery === "applied",
  );
  assert.equal(store.list().length, 1);
  assert.equal(reported.runId, running!.runId);
  assert.equal(reported.status, "interrupted");
  assert.equal(reported.cutOff, undefined);
  assert.equal(reported.continued, 1);
  assert.match(
    reported.error ?? "",
    /Could not continue after a restart: .*no checkpoint/,
  );
  assert.deepEqual(await lines(log), ["first", "second"]);
  assert.match(await readTicket(root, "a"), /Attempt interrupted\./);
});
