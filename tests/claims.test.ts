import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Engine } from "../src/engine.ts";
import { Store } from "../src/store.ts";
import { tk } from "../src/tk.ts";
import { gitClaims } from "../src/git-claims.ts";
import { loadConfiguration } from "../src/config.ts";
import type { Attempt } from "../src/contracts.ts";
import { definition, readTicket, ticket, until } from "./helpers.ts";

const exec = promisify(execFile);
const ttlMs = 1_500;

function publishTo(t: TestContext, directory: string) {
  process.env.MACHINES_RUN_STATUS_DIR = directory;
  t.after(() => {
    process.env.MACHINES_RUN_STATUS_DIR = "off";
  });
}
/** Logs "start" in its workspace, then waits for a `go` file there. */
async function gate(cwd: string, outcome: object) {
  await writeFile(
    join(cwd, ".machines", "gate.ts"),
    `
import {appendFileSync, existsSync} from "node:fs";
export const description = "Waits for a go file";
export default function ({machine, operation, final}) {
  return machine({ initial: "work", output: () => (${JSON.stringify(outcome)}), states: {
    work: operation(async () => {
      appendFileSync(${JSON.stringify(join(cwd, "log.txt"))}, "start\\n");
      while (!existsSync(${JSON.stringify(join(cwd, "go"))})) await new Promise((r) => setTimeout(r, 20));
      return {type:"done"};
    }, {done:"done"}),
    done: final()
  }});
}`,
  );
}
const starts = async (cwd: string) =>
  (await readFile(join(cwd, "log.txt"), "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line === "start").length;

/**
 * Two computers: clones "alpha" and "beta" of one bare remote, each with its
 * own state directory, Engine and copy of the same tickets.
 */
async function computers(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "machines-dispatch-claims-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = join(root, "remote.git");
  await exec("git", ["init", "-q", "--bare", remote]);
  const sides = {} as Record<"alpha" | "beta", { cwd: string; state: string }>;
  for (const name of ["alpha", "beta"] as const) {
    const cwd = join(root, name);
    await exec("git", ["clone", "-q", remote, cwd]);
    for (const directory of [".machines", ".tickets", "home"])
      await mkdir(join(cwd, directory));
    const state = join(root, `state-${name}`);
    await mkdir(state);
    sides[name] = { cwd, state };
  }
  const running = new Set<() => Promise<void>>();
  t.after(async () => {
    for (const stop of running) await stop();
  });
  /**
   * Starts (or restarts) one computer's daemon on its own state directory.
   * `plain` configures the source without claims; `none` configures no source.
   */
  const start = (name: "alpha" | "beta", mode: "claims" | "plain" | "none" = "claims") => {
    const { cwd, state } = sides[name];
    const store = new Store(join(state, "executions.sqlite"));
    const engine = new Engine(
      store,
      mode === "none"
        ? []
        : [
            tk({
              id: "op",
              cwd,
              home: join(cwd, "home"),
              ...(mode === "claims" ? { claims: gitClaims({ cwd, ttlMs }) } : {}),
            }),
          ],
      40,
      { host: name, claimBackoffMs: 50, finishedBackoffMs: 50 },
    );
    engine.start();
    let stopped = false;
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      running.delete(stop);
      await engine.close();
      store.close();
    };
    running.add(stop);
    return { engine, store, stop };
  };
  /** Writes the same file into both computers' copies. */
  const both = async (write: (cwd: string) => Promise<void>) => {
    await write(sides.alpha.cwd);
    await write(sides.beta.cwd);
  };
  return { root, remote, sides, start, both };
}
type Daemon = ReturnType<Awaited<ReturnType<typeof computers>>["start"]>;
const issues = (daemon: Daemon) =>
  daemon.engine.sourcesStatus().flatMap((source) => source.issues);
const only = (daemon: Daemon): Attempt[] => daemon.store.list();

test("one computer runs a contended ticket; its finished request never runs on the other; a new request can run on either", async (t) => {
  const { sides, start, both } = await computers(t);
  await both(async (cwd) => {
    await gate(cwd, { action: "route", machine: "finisher", summary: "Investigated" });
    await ticket(cwd, "t1", "machine: gate\n");
  });
  const daemons = { alpha: start("alpha"), beta: start("beta") };

  // 1. Exactly one launches; the other reports who holds the ticket.
  const [winnerName] = await until(
    () =>
      (["alpha", "beta"] as const).filter((name) => only(daemons[name]).length),
    (names) =>
      names.length === 1 &&
      issues(daemons[names[0] === "alpha" ? "beta" : "alpha"]).some((issue) =>
        new RegExp(`^t1: claimed by ${names[0]} until `).test(issue),
      ),
  );
  const loserName = winnerName === "alpha" ? "beta" : "alpha";
  const winner = daemons[winnerName!];
  const loser = daemons[loserName];
  // Only the loser can run the routed request, so the winner never claims it.
  await definition(sides[loserName].cwd, "finisher");
  // Renewal keeps it held past several TTLs while it runs.
  await delay(ttlMs * 2);
  assert.equal(only(loser).length, 0);
  assert.equal(await starts(sides[loserName].cwd), 0);
  const [running] = only(winner);
  assert.equal(running!.claim?.state, "held");
  assert.deepEqual(running!.claim?.lease.holder, {
    ...winner.engine.identity,
    attempt: running!.id,
  });

  // 2. The winner completes and delivers; the loser's stale copy still shows
  // the request open, but it is finished, even after the TTL.
  await writeFile(join(sides[winnerName!].cwd, "go"), "");
  const [done] = await until(
    () => only(winner),
    (list) => list[0]?.delivery === "applied" && list[0]?.claim?.state === "done",
  );
  assert.equal(done!.status, "completed");
  assert.match(await readTicket(sides[winnerName!].cwd, "t1"), /machines-dispatch-request:/);
  assert.match(await readTicket(sides[loserName].cwd, "t1"), /status: open/);
  await until(
    () => issues(loser),
    (list) => list.includes("t1: already finished on another computer"),
  );
  await delay(ttlMs * 1.5);
  assert.equal(only(loser).length, 0);
  assert.ok(issues(loser).includes("t1: already finished on another computer"));

  // 3. The routed request has a new key. Copied to the other computer, it runs there.
  await copyFile(
    join(sides[winnerName!].cwd, ".tickets", "t1.md"),
    join(sides[loserName].cwd, ".tickets", "t1.md"),
  );
  const [routed] = await until(
    () => only(loser),
    (list) => list[0]?.delivery === "applied" && list[0]?.claim?.state === "done",
  );
  assert.equal(routed!.status, "completed");
  assert.equal(routed!.item.key, `t1:${done!.id}`);
  assert.match(await readTicket(sides[loserName].cwd, "t1"), /status: closed/);
  assert.equal(only(winner).length, 1);
  assert.equal(await starts(sides[loserName].cwd), 0);
});

test("a dead holder loses the ticket after the TTL; on restart it does not continue and notes the lost claim", async (t) => {
  const { root, sides, start, both } = await computers(t);
  publishTo(t, join(root, "runs"));
  await both(async (cwd) => {
    await gate(cwd, { action: "hold", summary: "Held" });
    await ticket(cwd, "t1", "machine: gate\n");
  });
  const alpha = start("alpha");
  const [held] = await until(
    () => only(alpha),
    (list) => list[0]?.status === "running" && !!list[0]?.runId,
  );
  await until(() => starts(sides.alpha.cwd), (count) => count === 1);
  const beta = start("beta");
  await until(
    () => issues(beta),
    (list) => list.some((issue) => issue.startsWith("t1: claimed by alpha until ")),
  );
  // Alpha stops renewing: its run is cut off and would otherwise continue on restart.
  await alpha.stop();
  const store = new Store(join(sides.alpha.state, "executions.sqlite"));
  const [cut] = store.list();
  store.close();
  assert.equal(cut!.cutOff, true);
  assert.equal(cut!.claim?.state, "held");

  // Beta takes the ticket over once alpha's lease expires.
  const [taken] = await until(
    () => only(beta),
    (list) => list[0]?.status === "running",
  );
  assert.ok(Date.now() >= Date.parse(held!.claim!.lease.expiresAt) - 100);
  await until(() => starts(sides.beta.cwd), (count) => count === 1);

  // Released, alpha's run would finish at once if it were continued.
  await writeFile(join(sides.alpha.cwd, "go"), "");
  const restarted = start("alpha");
  const [lost] = await until(
    () => only(restarted),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(lost!.id, held!.id);
  assert.equal(lost!.status, "interrupted");
  assert.equal(lost!.error, "Claim lost to beta; another computer took this ticket");
  assert.equal(lost!.claim?.state, "lost");
  assert.deepEqual(lost!.claim?.lostTo, taken!.claim?.lease.holder);
  assert.equal(lost!.continued, undefined);
  assert.equal(await starts(sides.alpha.cwd), 1);
  assert.match(
    await readTicket(sides.alpha.cwd, "t1"),
    /Attempt interrupted: Claim lost to beta; another computer took this ticket\./,
  );
  assert.equal(only(restarted).length, 1);

  // Beta still holds it and finishes; the loser never finished the key.
  await writeFile(join(sides.beta.cwd, "go"), "");
  await until(
    () => only(beta),
    (list) => list[0]?.claim?.state === "done",
  );
  await delay(200);
  assert.equal(only(restarted).length, 1);
  assert.equal(only(restarted)[0]!.claim?.state, "lost");
});

const eventTypes = (daemon: Daemon, id: string) =>
  daemon.store.events(id).map((entry) => (entry as { event: { type?: string } }).event.type);

test("a claimed cut-off run whose claim store is no longer configured stays stopped until claims return", async (t) => {
  const { root, sides, start, both } = await computers(t);
  publishTo(t, join(root, "runs"));
  await both(async (cwd) => {
    await gate(cwd, { action: "hold", summary: "Held" });
    await ticket(cwd, "t1", "machine: gate\n");
  });
  const alpha = start("alpha");
  const [held] = await until(
    () => only(alpha),
    (list) => list[0]?.status === "running" && !!list[0]?.runId,
  );
  await until(() => starts(sides.alpha.cwd), (count) => count === 1);
  await alpha.stop();
  // Released, the run would finish at once if it were continued.
  await writeFile(join(sides.alpha.cwd, "go"), "");

  // Restarted with the source but without claims: it cannot renew, so it stays cut off.
  const plain = start("alpha", "plain");
  await until(
    () => issues(plain),
    (list) =>
      list.some((issue) =>
        issue.startsWith(`t1: claim store unavailable: source "op" is no longer configured with claims; attempt ${held!.id} holds a claim`),
      ),
  );
  await delay(300);
  let [kept] = only(plain);
  assert.equal(kept!.cutOff, true);
  assert.equal(kept!.continued, undefined);
  assert.equal(kept!.claim?.state, "held");
  assert.match(kept!.claim!.error!, /^claim store unavailable: source "op" is no longer configured with claims/);
  assert.ok(!eventTypes(plain, held!.id).includes("continued"));
  assert.equal(only(plain).length, 1);
  await plain.stop();

  // Restarted with the source removed: still stopped, reported on the attempt.
  const none = start("alpha", "none");
  await until(
    () => only(none)[0]?.claim?.error,
    (error) => (error ?? "").startsWith('claim store unavailable: source "op" is no longer configured;'),
  );
  await delay(300);
  [kept] = only(none);
  assert.equal(kept!.cutOff, true);
  assert.equal(kept!.continued, undefined);
  await none.stop();
  assert.equal(await starts(sides.alpha.cwd), 1);

  // With claims configured again, it renews first, then continues.
  const restored = start("alpha");
  const [continued] = await until(
    () => only(restored),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(continued!.continued, 1);
  assert.equal(continued!.claim?.error, undefined);
  assert.ok(eventTypes(restored, held!.id).includes("continued"));
});

/** Answers a sleeping run through its own inbox, as an operator would. */
async function respond(directory: string, runId: string, requestId: string) {
  await exec(
    join(import.meta.dirname, "..", "node_modules", ".bin", "machine"),
    ["respond", runId, requestId, "--", "yes"],
    { env: { ...process.env, MACHINES_RUN_STATUS_DIR: directory } },
  );
}

test("a sleeping attempt keeps its claim across many TTLs, and wakes only after renewing it", async (t) => {
  const { root, start, both } = await computers(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await both(async (cwd) => {
    await definition(cwd, "work", "complete", true);
    await ticket(cwd, "t1", "machine: work\n");
  });
  const alpha = start("alpha");
  const [asleep] = await until(
    () => only(alpha),
    (list) => list[0]?.status === "sleeping",
  );
  const beta = start("beta");
  await until(
    () => issues(beta),
    (list) => list.some((issue) => issue.startsWith("t1: claimed by alpha until ")),
  );
  await delay(ttlMs * 3);
  const [still] = only(alpha);
  assert.equal(still!.status, "sleeping");
  assert.equal(still!.claim?.state, "held");
  assert.notDeepEqual(still!.claim?.lease.data, asleep!.claim?.lease.data);
  assert.ok(Date.parse(still!.claim!.lease.expiresAt) > Date.now());
  assert.equal(only(beta).length, 0);

  await respond(runs, asleep!.runId!, (asleep!.sleeping as { human: { requestId: string } }).human.requestId);
  const [woken] = await until(
    () => only(alpha),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(woken!.status, "completed");
  assert.ok(alpha.store.events(woken!.id).some((entry) => (entry as { event: { type?: string } }).event.type === "woken"));
  await until(
    () => issues(beta),
    (list) => list.includes("t1: already finished on another computer"),
  );
  assert.equal(only(beta).length, 0);
});

test("a sleeping attempt whose claim was taken over is never woken", async (t) => {
  const { root, sides, start, both } = await computers(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await both(async (cwd) => {
    await definition(cwd, "work", "complete", true);
    await ticket(cwd, "t1", "machine: work\n");
  });
  const alpha = start("alpha");
  const [asleep] = await until(
    () => only(alpha),
    (list) => list[0]?.status === "sleeping",
  );
  await alpha.stop();
  const beta = start("beta");
  await until(
    () => only(beta),
    (list) => list[0]?.status === "sleeping",
  );
  // Alpha's run is answered while alpha is down; it would wake on restart.
  await respond(runs, asleep!.runId!, (asleep!.sleeping as { human: { requestId: string } }).human.requestId);
  const restarted = start("alpha");
  const [lost] = await until(
    () => only(restarted),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(lost!.status, "interrupted");
  assert.equal(lost!.claim?.state, "lost");
  assert.match(lost!.error!, /^Claim lost to beta;/);
  assert.ok(!restarted.store.events(lost!.id).some((entry) => (entry as { event: { type?: string } }).event.type === "woken"));
  assert.match(await readTicket(sides.alpha.cwd, "t1"), /Claim lost to beta/);
  assert.equal(only(beta)[0]!.status, "sleeping");
});

test("a claimed sleeping run whose claim store is no longer configured is not woken until claims return", async (t) => {
  const { root, start, both } = await computers(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await both(async (cwd) => {
    await definition(cwd, "work", "complete", true);
    await ticket(cwd, "t1", "machine: work\n");
  });
  const alpha = start("alpha");
  const [asleep] = await until(
    () => only(alpha),
    (list) => list[0]?.status === "sleeping",
  );
  await alpha.stop();
  await respond(runs, asleep!.runId!, (asleep!.sleeping as { human: { requestId: string } }).human.requestId);

  // Answered, it would wake at once; without its claim store it must not.
  const plain = start("alpha", "plain");
  await until(
    () => issues(plain),
    (list) => list.some((issue) => issue.startsWith('t1: claim store unavailable: source "op" is no longer configured with claims')),
  );
  await delay(300);
  const [kept] = only(plain);
  assert.equal(kept!.status, "sleeping");
  assert.equal(kept!.claim?.state, "held");
  assert.ok(!eventTypes(plain, asleep!.id).includes("woken"));
  await plain.stop();

  const restored = start("alpha");
  const [woken] = await until(
    () => only(restored),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(woken!.status, "completed");
  assert.ok(eventTypes(restored, asleep!.id).includes("woken"));
});

test("an unreachable remote blocks launch with an issue until it returns; retry runs a finished request again", async (t) => {
  const { remote, sides, start, both } = await computers(t);
  await both(async (cwd) => {
    await definition(cwd, "work", "hold");
    await ticket(cwd, "t1", "machine: work\n");
  });
  await rename(remote, `${remote}.away`);
  const alpha = start("alpha");
  await until(
    () => issues(alpha),
    (list) => list.some((issue) => issue.startsWith("t1: claim check failed, not launched: ")),
  );
  await delay(300);
  assert.equal(only(alpha).length, 0);
  await rename(`${remote}.away`, remote);
  const [first] = await until(
    () => only(alpha),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(first!.status, "completed");
  assert.match(await readTicket(sides.alpha.cwd, "t1"), /status: open/);

  // The other computer's copy is open with the same request: finished.
  const beta = start("beta");
  await until(
    () => issues(beta),
    (list) => list.includes("t1: already finished on another computer"),
  );
  await assert.rejects(beta.engine.retry("missing"), /Unknown attempt/);

  // An explicit retry on the computer that finished it runs again.
  const again = await alpha.engine.retry(first!.id);
  assert.notEqual(again.id, first!.id);
  assert.equal(again.claim?.state, "held");
  await until(
    () => only(alpha),
    (list) => list.length === 2 && list[0]?.claim?.state === "done",
  );
  assert.equal(only(beta).length, 0);
});

test("configuration resolves gitClaims beside the file and rejects malformed claims", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "machines-dispatch-claims-config-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "op"));
  await exec("git", ["init", "-q", join(root, "op")]);
  await writeFile(join(root, "package.json"), '{"type":"module"}\n');
  const config = join(root, "machines-dispatch.config.ts");
  await writeFile(
    config,
    `export default ({ tk, gitClaims }) => [tk({ id: "op", cwd: "./op", claims: gitClaims({ cwd: "./op", remote: "nowhere" }) })];\n`,
  );
  const [source] = await loadConfiguration(config);
  assert.ok(source!.claims);
  // Run from elsewhere, the relative cwd still resolves beside the configuration.
  await assert.rejects(
    source!.claims.acquire({ scope: "op/t1", key: "k", holder: { daemon: "d", attempt: "a", host: "h" }, retry: false }),
    /nowhere/,
  );
  const bad = join(root, "bad.config.ts");
  await writeFile(
    bad,
    `export default ({ tk }) => [{ ...tk({ id: "op", cwd: "./op" }), claims: { acquire() {} } }];\n`,
  );
  await assert.rejects(loadConfiguration(bad), /Invalid claims for source op/);
});

test("a cut-off run from before claims takes a claim before it continues", async (t) => {
  const { root, sides, start, both } = await computers(t);
  publishTo(t, join(root, "runs"));
  await both(async (cwd) => {
    await gate(cwd, { action: "hold", summary: "Held" });
    await ticket(cwd, "t1", "machine: gate\n");
  });
  const plain = start("alpha", "plain");
  const [cut] = await until(
    () => only(plain),
    (list) => list[0]?.status === "running" && !!list[0]?.runId,
  );
  await until(() => starts(sides.alpha.cwd), (count) => count === 1);
  await plain.stop();
  await writeFile(join(sides.alpha.cwd, "go"), "");

  const claimed = start("alpha");
  const [continued] = await until(
    () => only(claimed),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(continued!.id, cut!.id);
  assert.equal(continued!.continued, 1);
  const types = eventTypes(claimed, cut!.id);
  assert.ok(types.indexOf("claim-adopted") < types.indexOf("continued"));
  // Continuing re-enters the interrupted step once.
  assert.equal(await starts(sides.alpha.cwd), 2);
});

test("a cut-off run from before claims is not continued while another computer holds its ticket", async (t) => {
  const { root, sides, start, both } = await computers(t);
  publishTo(t, join(root, "runs"));
  await both(async (cwd) => {
    await gate(cwd, { action: "hold", summary: "Held" });
    await ticket(cwd, "t1", "machine: gate\n");
  });
  const plain = start("alpha", "plain");
  const [cut] = await until(
    () => only(plain),
    (list) => list[0]?.status === "running" && !!list[0]?.runId,
  );
  await until(() => starts(sides.alpha.cwd), (count) => count === 1);
  await plain.stop();
  // Released, alpha's run would finish at once if it were continued.
  await writeFile(join(sides.alpha.cwd, "go"), "");

  const beta = start("beta");
  await until(() => starts(sides.beta.cwd), (count) => count === 1);
  const claimed = start("alpha");
  const [refused] = await until(
    () => only(claimed),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(refused!.id, cut!.id);
  assert.equal(refused!.status, "interrupted");
  assert.equal(refused!.claim, undefined);
  assert.equal(refused!.continued, undefined);
  assert.match(refused!.error!, /^Claims were enabled after this attempt started, and beta holds this ticket/);
  assert.ok(!eventTypes(claimed, cut!.id).includes("continued"));
  assert.ok(eventTypes(claimed, cut!.id).includes("claim-refused"));
  assert.equal(await starts(sides.alpha.cwd), 1);
  assert.match(await readTicket(sides.alpha.cwd, "t1"), /Claims were enabled after this attempt started/);
  await delay(200);
  assert.equal(only(claimed).length, 1);
  assert.equal(only(beta)[0]!.status, "running");
});

test("a sleeping run from before claims is not woken once another computer finished its request", async (t) => {
  const { root, start, both } = await computers(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await both(async (cwd) => {
    await definition(cwd, "work", "complete", true);
    await ticket(cwd, "t1", "machine: work\n");
  });
  const plain = start("alpha", "plain");
  const [asleep] = await until(
    () => only(plain),
    (list) => list[0]?.status === "sleeping",
  );
  await plain.stop();

  const beta = start("beta");
  const [other] = await until(
    () => only(beta),
    (list) => list[0]?.status === "sleeping",
  );
  await respond(runs, other!.runId!, (other!.sleeping as { human: { requestId: string } }).human.requestId);
  await until(
    () => only(beta),
    (list) => list[0]?.claim?.state === "done",
  );

  // Answered, alpha's run would wake at once on restart.
  await respond(runs, asleep!.runId!, (asleep!.sleeping as { human: { requestId: string } }).human.requestId);
  const claimed = start("alpha");
  const [refused] = await until(
    () => only(claimed),
    (list) => list[0]?.delivery === "applied",
  );
  assert.equal(refused!.status, "interrupted");
  assert.match(refused!.error!, /another computer already finished this request; not resumed$/);
  assert.ok(!eventTypes(claimed, asleep!.id).includes("woken"));
  await delay(200);
  assert.equal(only(claimed).length, 1);
});

test("a sleeping run from before claims wakes after taking its claim", async (t) => {
  const { root, start, both } = await computers(t);
  const runs = join(root, "runs");
  publishTo(t, runs);
  await both(async (cwd) => {
    await definition(cwd, "work", "complete", true);
    await ticket(cwd, "t1", "machine: work\n");
  });
  const plain = start("alpha", "plain");
  const [asleep] = await until(
    () => only(plain),
    (list) => list[0]?.status === "sleeping",
  );
  await plain.stop();
  await respond(runs, asleep!.runId!, (asleep!.sleeping as { human: { requestId: string } }).human.requestId);
  const claimed = start("alpha");
  const [woken] = await until(
    () => only(claimed),
    (list) => list[0]?.claim?.state === "done",
  );
  assert.equal(woken!.status, "completed");
  const types = eventTypes(claimed, asleep!.id);
  assert.ok(types.indexOf("claim-adopted") < types.indexOf("woken"));
  const beta = start("beta");
  await until(
    () => issues(beta),
    (list) => list.includes("t1: already finished on another computer"),
  );
  assert.equal(only(beta).length, 0);
});
