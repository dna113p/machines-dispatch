import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { access, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "../src/daemon.ts";
import { request } from "../src/client.ts";
import { tk } from "../src/tk.ts";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { workspace, ticket, definition, until, readTicket } from "./helpers.ts";

/** An attempt as `status` reports it. */
interface Seen {
  id: string;
  status: string;
  delivery: string;
  error?: string;
  runId?: string;
  human?: { requestId: string };
  sleeping?: { due?: string; human?: { requestId: string } };
  cannotSleep?: string;
  wakeError?: string;
}
interface Logged {
  sequence: number;
  time: string;
  event: { type?: string; sleeping?: { due?: string } };
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
/** Answers a sleeping run through its own inbox, as an operator would. */
async function respond(
  directory: string,
  runId: string,
  requestId: string,
  response: string,
) {
  await promisify(execFile)(
    join(import.meta.dirname, "..", "node_modules", ".bin", "machine"),
    ["respond", runId, requestId, "--", response],
    { env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory } },
  );
}
async function setup(t: TestContext, root: string) {
  await ticket(root, "a", "machine: work\n");
  const options = {
    stateDir: join(root, "state"),
    sources: [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  };
  const daemon = await startDaemon(options);
  t.after(() => daemon.close());
  return { daemon, options, stateDir: options.stateDir };
}
/** Polls explicitly so retry timing and shutdown during startup are controllable. */
async function setupEngine(t: TestContext, root: string, intervalMs = 300) {
  await ticket(root, "a", "machine: work\n");
  const store = new Store(":memory:");
  const engine = new Engine(
    store,
    [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs,
  );
  t.after(async () => {
    await engine.close();
    store.close();
  });
  engine.poll();
  const [attempt] = await until(
    () => store.list(),
    (list) => list[0]?.status === "sleeping",
  );
  return { engine, store, attempt: attempt! };
}

test("an attempt sleeps at a Human request, keeps its ticket open, and stays asleep across a restart", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { daemon, options, stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const runId = attempt!.runId!;
  const requestId = attempt!.sleeping!.human!.requestId;
  assert.ok(runId && requestId);
  const published = await record(runs, runId);
  assert.equal(published.status, "sleeping");
  assert.equal(published.continuedBy, "host");
  assert.equal(published.human.requestId, requestId);
  assert.equal(attempt!.delivery, "none");
  const before = await readTicket(root, "a");
  assert.match(before, /status: open/);
  assert.doesNotMatch(before, /Machines Dispatch/);
  assert.equal(daemon.engine.idle(), false);
  assert.equal(daemon.engine.hold(), false);
  await assert.rejects(daemon.engine.retry(attempt!.id), /Wait for the prior attempt/);
  const stored = daemon.engine.store.get(attempt!.id);
  assert.equal(
    daemon.engine.store.create(
      stored.source,
      { ...stored.item, key: "another-request" },
      stored.launch,
    ),
    undefined,
    "a sleeping attempt blocks a new request for the same ticket",
  );

  // Answering goes through the run's own inbox, not Dispatch.
  await assert.rejects(
    request(stateDir, "respond", {
      id: attempt!.id,
      requestId,
      response: "yes",
    }),
    new RegExp(`machine respond ${runId} ${requestId}`),
  );

  await daemon.close();
  const restarted = await startDaemon(options);
  t.after(() => restarted.close());
  await until(
    () => restarted.engine.sourcesStatus(),
    (list) => list.every((source) => source.checkedAt !== undefined),
  );
  await delay(300);
  const [after] = await attempts(stateDir);
  assert.equal(after!.status, "sleeping");
  assert.equal(after!.delivery, "none");
  assert.equal(after!.error, undefined);
  assert.equal(after!.runId, runId);
  assert.equal(after!.sleeping!.human!.requestId, requestId);
  assert.equal(await readTicket(root, "a"), before);
  assert.equal((await record(runs, runId)).status, "sleeping");
});

test("an attempt sleeps at a timed wait and status shows when it is due", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await writeFile(
    join(root, ".machines", "work.ts"),
    `
export const description = "Timed wait fixture";
export default function ({machine, operation, wait, final}) {
  return machine({ initial: "work", output: () => ({action: "complete", summary: "Verified"}), states: {
    work: operation(() => ({type:"done"}), {done:"pause"}),
    pause: wait({every:"1h"}, {due:"done"}),
    done: final()
  }});
}`,
  );
  const { stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const due = attempt!.sleeping!.due!;
  assert.ok(Date.parse(due) > Date.now());
  assert.equal(due, (await record(runs, attempt!.runId!)).due);
  assert.equal(attempt!.delivery, "none");
  assert.match(await readTicket(root, "a"), /status: open/);
  await assert.rejects(
    request(stateDir, "respond", { id: attempt!.id, requestId: "none", response: "yes" }),
    /sleeping until .* and takes no response/,
  );
});

test("cancelling a sleeping attempt writes back but leaves its Machines run sleeping", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { daemon, stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  await request(stateDir, "cancel", { id: attempt!.id });
  const [cancelled] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(cancelled!.status, "cancelled");
  assert.equal(cancelled!.sleeping, undefined);
  assert.match(await readTicket(root, "a"), /Attempt cancelled\./);
  assert.ok((await readTicket(root, "a")).includes(`<!-- machines-dispatch:${attempt!.id} -->`));
  assert.match(await readTicket(root, "a"), /status: open/);
  assert.equal((await record(runs, attempt!.runId!)).status, "sleeping");
  assert.equal((await record(runs, attempt!.runId!)).continuedBy, "host");
  assert.equal(daemon.engine.idle(), true);
  // A cancelled attempt is never woken, even once its run is answered.
  await respond(runs, attempt!.runId!, attempt!.sleeping!.human!.requestId, "yes");
  await delay(300);
  assert.equal((await record(runs, attempt!.runId!)).status, "sleeping");
  assert.equal((await attempts(stateDir))[0]!.status, "cancelled");
});

test("a sleeping Human request is continued after machine respond and its ticket closes", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { daemon, stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const runId = attempt!.runId!;
  await respond(runs, runId, attempt!.sleeping!.human!.requestId, "yes");
  const list = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(list.length, 1, "the woken run stays the same attempt");
  const [done] = list;
  assert.equal(done!.id, attempt!.id);
  assert.equal(done!.runId, runId);
  assert.equal(done!.status, "completed");
  assert.equal(done!.sleeping, undefined);
  assert.equal(done!.wakeError, undefined);
  assert.match(await readTicket(root, "a"), /status: closed/);
  assert.equal((await record(runs, runId)).status, "completed");
  assert.equal(daemon.engine.idle(), true);
});

test("a repeating timed wait is continued only when due and sleeps again as the same attempt", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await writeFile(
    join(root, ".machines", "work.ts"),
    `
export const description = "Repeating timed wait fixture";
export default function ({machine, operation, wait, final}) {
  return machine({ initial: "work", output: () => ({action: "complete", summary: "Verified"}), states: {
    work: operation(() => ({type:"done"}), {done:"first"}),
    first: wait({every:600}, {due:"second"}),
    second: wait({every:600}, {due:"done"}),
    done: final()
  }});
}`,
  );
  const { daemon, stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const runId = attempt!.runId!;
  const list = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(list.length, 1, "each wake stays the same attempt");
  assert.equal(list[0]!.id, attempt!.id);
  assert.equal(list[0]!.runId, runId);
  assert.equal(list[0]!.status, "completed");
  assert.match(await readTicket(root, "a"), /status: closed/);

  const events = daemon.engine.store.events(attempt!.id) as Logged[];
  const sleeps = events.filter((entry) => entry.event.type === "sleeping");
  assert.equal(sleeps.length, 2, "the repeating wait slept again");
  assert.ok(
    Date.parse(sleeps[1]!.event.sleeping!.due!) >
      Date.parse(sleeps[0]!.event.sleeping!.due!),
  );
  // Nothing happens to a sleeping attempt before its wait is due.
  for (const sleep of sleeps) {
    const due = Date.parse(sleep.event.sleeping!.due!);
    const after = events.filter((entry) => entry.sequence > sleep.sequence);
    assert.ok(after.length > 0, "the run was continued");
    for (const entry of after)
      assert.ok(
        Date.parse(entry.time) >= due,
        `${JSON.stringify(entry)} came before its wait was due at ${sleep.event.sleeping!.due}`,
      );
  }
});

test("a failed wake keeps the attempt sleeping, shows the error, and logs a bounded number of events", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { daemon, options, stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const runId = attempt!.runId!;
  // Closed first, so the daemon cannot wake the run before its checkpoint is gone.
  await daemon.close();
  await respond(runs, runId, attempt!.sleeping!.human!.requestId, "yes");
  const checkpoint = join(runs, `${runId}.checkpoint.json`);
  await access(checkpoint);
  await rm(checkpoint);
  const before = await readTicket(root, "a");

  const restarted = await startDaemon(options);
  t.after(() => restarted.close());
  await until(
    () => restarted.engine.sourcesStatus(),
    (list) => list.every((source) => source.checkedAt !== undefined),
  );
  await delay(1_000);
  const [failed] = await attempts(stateDir);
  assert.equal(failed!.id, attempt!.id);
  assert.equal(failed!.status, "sleeping");
  assert.equal(failed!.runId, runId);
  assert.match(failed!.wakeError ?? "", /no checkpoint/);
  assert.equal(failed!.delivery, "none");
  assert.equal(await readTicket(root, "a"), before);
  assert.equal((await record(runs, runId)).status, "sleeping");
  assert.equal(restarted.engine.idle(), false);

  // The same error over many polls is logged once.
  const logged = () => restarted.engine.store.events(attempt!.id) as Logged[];
  const first = logged();
  assert.equal(
    first.filter((entry) => entry.event.type === "wake-failed").length,
    1,
  );
  await delay(300);
  assert.equal(logged().length, first.length);

  await request(stateDir, "cancel", { id: attempt!.id });
  const [cancelled] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(cancelled!.status, "cancelled");
  assert.match(await readTicket(root, "a"), /Attempt cancelled\./);
});

test("a failed wake waits a poll interval before retrying and clears its error after repair", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, store, attempt } = await setupEngine(t, root, 60_000);
  assert.ok(attempt.sleeping && "human" in attempt.sleeping);
  await respond(runs, attempt.runId!, attempt.sleeping.human.requestId, "yes");
  const checkpoint = join(runs, `${attempt.runId}.checkpoint.json`);
  const saved = await readFile(checkpoint);
  await rm(checkpoint);
  engine.poll();
  await until(() => store.get(attempt.id), (value) => !!value.wakeError);

  await writeFile(checkpoint, saved);
  // Explicit polls and execute()'s final poll must all honor the retry delay.
  engine.poll();
  await delay(100);
  engine.poll();
  assert.equal(store.get(attempt.id).status, "sleeping");
  assert.match(store.get(attempt.id).wakeError!, /no checkpoint/);
  assert.equal((await record(runs, attempt.runId!)).status, "sleeping");

  const now = Date.now.bind(Date);
  t.mock.method(Date, "now", () => now() + 60_000);
  engine.poll();
  const done = await until(
    () => store.get(attempt.id),
    (value) => value.delivery === "applied",
  );
  assert.equal(store.list().length, 1);
  assert.equal(done.runId, attempt.runId);
  assert.equal(done.status, "completed");
  assert.equal(done.wakeError, undefined);
  assert.match(await readTicket(root, "a"), /status: closed/);
});

test("closing during a wake's startup preserves the sleeping attempt and checkpoint", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, store, attempt } = await setupEngine(t, root);
  assert.ok(attempt.sleeping && "human" in attempt.sleeping);
  await respond(runs, attempt.runId!, attempt.sleeping.human.requestId, "yes");
  const before = await readTicket(root, "a");
  engine.poll();
  await engine.close();
  const stopped = store.get(attempt.id);
  assert.equal(stopped.status, "sleeping");
  assert.equal(stopped.delivery, "none");
  assert.equal(stopped.wakeError, undefined);
  assert.equal(await readTicket(root, "a"), before);
  assert.equal((await record(runs, attempt.runId!)).status, "sleeping");
  await access(join(runs, `${attempt.runId}.checkpoint.json`));
});

test("closing aborts a woken run after it starts", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await writeFile(
    join(root, ".machines", "work.ts"),
    `
export const description = "Wait for shutdown after waking";
export default function ({machine, operation, human}) {
  return machine({ initial: "review", states: {
    review: human("Approve?", {submitted:"work"}, {choices:["yes"]}),
    work: operation(() => new Promise(() => {}), {})
  }});
}`,
  );
  const { engine, store, attempt } = await setupEngine(t, root);
  assert.ok(attempt.sleeping && "human" in attempt.sleeping);
  await respond(runs, attempt.runId!, attempt.sleeping.human.requestId, "yes");
  engine.poll();
  await until(
    () => store.get(attempt.id),
    (value) => value.status === "running" && value.state === "work",
  );
  await engine.close();
  assert.equal(store.get(attempt.id).status, "interrupted");
  assert.equal(store.get(attempt.id).delivery, "pending");
  const stopped = await record(runs, attempt.runId!);
  assert.equal(stopped.status, "failed");
  assert.match(stopped.error, /terminated/);
});

test("with publication off the run waits in-process, status says it cannot sleep, and respond still answers it", async (t) => {
  const root = await workspace(t);
  await definition(root, "work", "complete", true);
  const { stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "waiting",
  );
  assert.equal(attempt!.sleeping, undefined);
  assert.match(attempt!.cannotSleep ?? "", /publication is off/);
  await request(stateDir, "respond", {
    id: attempt!.id,
    requestId: attempt!.human!.requestId,
    response: "yes",
  });
  await until(
    () => attempts(stateDir),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal((await attempts(stateDir))[0]!.status, "completed");
  assert.match(await readTicket(root, "a"), /status: closed/);
});

test("where the run-status directory cannot be written the run waits in-process and status says why", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  await writeFile(runs, "not a directory");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { stateDir } = await setup(t, root);
  const [attempt] = await until(
    () => attempts(stateDir),
    (list) => list[0]?.status === "waiting" || list[0]?.status === "sleeping",
  );
  assert.equal(attempt!.status, "waiting");
  assert.match(attempt!.cannotSleep ?? "", /cannot be written/);
});
