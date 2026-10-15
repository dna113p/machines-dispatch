import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "../src/daemon.ts";
import { request } from "../src/client.ts";
import { tk } from "../src/tk.ts";
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
