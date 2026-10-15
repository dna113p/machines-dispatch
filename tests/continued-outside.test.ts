import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { join } from "node:path";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  state?: string;
  note?: string;
  error?: string;
  runId?: string;
  sleeping?: { human?: { requestId: string } };
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
const machine = join(import.meta.dirname, "..", "node_modules", ".bin", "machine");
async function respond(
  directory: string,
  runId: string,
  requestId: string,
  response: string,
) {
  await promisify(execFile)(
    machine,
    ["respond", runId, requestId, "--", response],
    { env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory } },
  );
}
/** Wakes a sleeping run by hand, as a person would; a run that fails exits non-zero. */
async function continueRun(directory: string, root: string, runId: string) {
  await promisify(execFile)(machine, ["continue", runId], {
    cwd: root,
    env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory },
  }).catch(() => undefined);
}
/** Polls explicitly, so nothing but the test's own polls can change the attempt. */
async function setupEngine(t: TestContext, root: string) {
  await ticket(root, "a", "machine: work\n");
  const store = new Store(":memory:");
  const engine = new Engine(
    store,
    [tk({ id: "s", cwd: root, home: join(root, "home") })],
    60_000,
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
  assert.ok(attempt?.runId && attempt.sleeping && "human" in attempt.sleeping);
  return {
    engine,
    store,
    attempt: attempt!,
    runId: attempt.runId,
    requestId: attempt.sleeping.human.requestId,
    seen: () => store.get(attempt.id) as unknown as Seen,
  };
}

test("a run woken with machine continue that finishes leaves its ticket open and shows continued-outside", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  await ticket(root, "a", "machine: work\n");
  const options = {
    stateDir: join(root, "state"),
    sources: [tk({ id: "s", cwd: root, home: join(root, "home") })],
    intervalMs: 30,
  };
  const daemon = await startDaemon(options);
  t.after(() => daemon.close());
  const [attempt] = await until(
    () => attempts(options.stateDir),
    (list) => list[0]?.status === "sleeping",
  );
  const runId = attempt!.runId!;
  // Closed first, so Dispatch cannot wake the run before the person does.
  await daemon.close();
  await respond(runs, runId, attempt!.sleeping!.human!.requestId, "yes");
  await continueRun(runs, root, runId);
  const finished = await record(runs, runId);
  assert.equal(finished.status, "completed");
  assert.ok(finished.note, "the finished record has a summary");
  const before = await readTicket(root, "a");

  const restarted = await startDaemon(options);
  t.after(() => restarted.close());
  const list = await until(
    () => attempts(options.stateDir),
    (list) => list[0]?.status === "continued-outside",
  );
  assert.equal(list.length, 1);
  const [seen] = list;
  assert.equal(seen!.id, attempt!.id);
  assert.equal(seen!.runId, runId);
  assert.equal(seen!.state, finished.state);
  assert.equal(seen!.note, finished.note);
  assert.equal(seen!.delivery, "none");
  await delay(300);
  assert.equal((await attempts(options.stateDir))[0]!.delivery, "none");
  const after = await readTicket(root, "a");
  assert.equal(after, before);
  assert.match(after, /status: open/);
  assert.doesNotMatch(after, /Machines Dispatch/);
  assert.equal(restarted.engine.idle(), true);
  await assert.doesNotReject(async () => {
    await restarted.engine.retry(attempt!.id).catch((cause: Error) => {
      if (/Wait for the prior attempt/.test(cause.message)) throw cause;
    });
  });
});

test("a run woken with machine continue that fails shows continued-outside with its error", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await writeFile(
    join(root, ".machines", "work.ts"),
    `
export const description = "Fails after its Human request";
export default function ({machine, human, operation}) {
  return machine({ initial: "review", states: {
    review: human("Approve?", {submitted:"work"}, {choices:["yes"]}),
    work: operation(() => { throw new Error("outside failure"); }, {})
  }});
}`,
  );
  const { engine, attempt, runId, requestId, seen } = await setupEngine(t, root);
  await respond(runs, runId, requestId, "yes");
  await continueRun(runs, root, runId);
  const failed = await record(runs, runId);
  assert.equal(failed.status, "failed");
  assert.match(failed.error, /outside failure/);
  engine.poll();
  const marked = await until(seen, (value) => value.status === "continued-outside");
  assert.equal(marked.id, attempt.id);
  assert.equal(marked.error, failed.error);
  assert.equal(marked.delivery, "none");
  assert.match(await readTicket(root, "a"), /status: open/);
  assert.equal(engine.idle(), true);
});

test("a sleeping attempt whose run record was removed is marked run record not found on the next poll", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, runId, seen } = await setupEngine(t, root);
  assert.equal(engine.idle(), false);
  await rm(join(runs, `${runId}.json`));
  engine.poll();
  const marked = await until(seen, (value) => value.status !== "sleeping");
  assert.equal(marked.status, "continued-outside");
  assert.equal(marked.note, "run record not found");
  assert.equal(marked.delivery, "none");
  assert.equal(engine.idle(), true);
  assert.match(await readTicket(root, "a"), /status: open/);
  assert.doesNotMatch(await readTicket(root, "a"), /Machines Dispatch/);
});

test("an unreadable run record leaves the attempt sleeping until it can be read", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any file");
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, runId, requestId, seen } = await setupEngine(t, root);
  const file = join(runs, `${runId}.json`);
  await chmod(file, 0o000);
  t.after(() => chmod(file, 0o644).catch(() => undefined));
  engine.poll();
  await delay(200);
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");
  assert.equal(seen().note, undefined);
  assert.equal(engine.idle(), false);

  // Readable again and finished by hand, it is noticed.
  await chmod(file, 0o644);
  await respond(runs, runId, requestId, "yes");
  await continueRun(runs, root, runId);
  assert.equal((await record(runs, runId)).status, "completed");
  engine.poll();
  const marked = await until(seen, (value) => value.status === "continued-outside");
  assert.notEqual(marked.note, "run record not found");
  assert.equal(marked.note, (await record(runs, runId)).note);
});

test("a missing or changed run-status directory leaves the attempt sleeping", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, seen } = await setupEngine(t, root);

  await rm(runs, { recursive: true });
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");

  const elsewhere = join(root, "elsewhere");
  await mkdir(elsewhere);
  process.env.MACHINES_RUN_STATUS_DIR = elsewhere;
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");
  assert.equal(seen().note, undefined);

  // Back in the directory it slept in, which now lacks its record.
  await mkdir(runs);
  process.env.MACHINES_RUN_STATUS_DIR = runs;
  engine.poll();
  const marked = await until(seen, (value) => value.status !== "sleeping");
  assert.equal(marked.status, "continued-outside");
  assert.equal(marked.note, "run record not found");
});

test("a directory that permits lookup but cannot be listed leaves the attempt sleeping", async (t) => {
  if (process.getuid?.() === 0) return t.skip("root reads any directory");
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, runId, seen } = await setupEngine(t, root);
  await rm(join(runs, `${runId}.json`));
  await chmod(runs, 0o111);
  t.after(() => chmod(runs, 0o700).catch(() => undefined));
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");
  assert.equal(seen().note, undefined);
  assert.equal(engine.idle(), false);

  await chmod(runs, 0o700);
  engine.poll();
  assert.equal(seen().status, "continued-outside");
  assert.equal(seen().note, "run record not found");
});

test("a malformed record is not mistaken for a missing record", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, runId, seen } = await setupEngine(t, root);
  await writeFile(join(runs, `${runId}.json`), "{broken");
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");
  assert.equal(seen().note, undefined);
  assert.equal(engine.idle(), false);
});

test("an older sleeping attempt without a stored directory is not marked missing", async (t) => {
  const root = await workspace(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await definition(root, "work", "complete", true);
  const { engine, store, attempt, runId, seen } = await setupEngine(t, root);
  store.update(attempt.id, { runStatusDir: undefined });
  await rm(join(runs, `${runId}.json`));
  engine.poll();
  await delay(200);
  assert.equal(seen().status, "sleeping");
  assert.equal(seen().note, undefined);
  assert.equal(engine.idle(), false);
});
