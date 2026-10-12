import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { writeFile, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { request } from "../src/client.ts";
import type { Attempt } from "../src/contracts.ts";
import { workspace, ticket, until } from "./helpers.ts";

test("SIGKILL releases the singleton lock, kills the hosted process, and never replays it", async (t) => {
  const root = await workspace(t);
  const stateDir = join(root, "state");
  await ticket(root, "a", "machine: waiting\n");
  await writeFile(
    join(root, ".machines/waiting.ts"),
    `
import {writeFileSync} from "node:fs";
export const description="Wait with observable process identity";
export default ({machine,operation,human,final})=>machine({initial:"record",states:{
record:operation(()=>{writeFileSync("host.pid",String(process.pid));return {type:"done"}},{done:"wait"}),
wait:human("Wait",{submitted:"done"}),done:final()}});`,
  );
  const config = join(root, "config.ts");
  await writeFile(
    config,
    'export const update="off";export default ({tk})=>[tk({id:"s",cwd:".",home:"./home"})];',
  );
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
  });
  function start() {
    const child = spawn(
      process.execPath,
      [
        resolve("src/cli.ts"),
        "daemon",
        "--config",
        config,
        "--state-dir",
        stateDir,
      ],
      { stdio: "ignore" },
    );
    children.push(child);
    return child;
  }
  const first = start();
  const runs = await until(
    async () => {
      try {
        return ((await request(stateDir, "status")) as { attempts: Attempt[] })
          .attempts;
      } catch {
        return [];
      }
    },
    (list) => list[0]?.status === "waiting",
  );
  const pid = Number(await readFile(join(root, "host.pid"), "utf8"));
  const exited = once(first, "exit");
  first.kill("SIGKILL");
  await exited;
  await until(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, Boolean);
  start();
  const recovered = await until(
    async () => {
      try {
        return ((await request(stateDir, "status")) as { attempts: Attempt[] })
          .attempts;
      } catch {
        return [];
      }
    },
    (list) =>
      list[0]?.status === "interrupted" && list[0]?.delivery === "applied",
  );
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]!.id, runs[0]!.id);
  await assert.rejects(
    request(stateDir, "respond", {
      id: runs[0]!.id,
      requestId: runs[0]!.human!.requestId,
      response: "yes",
    }),
    /stale/,
  );
  await request(stateDir, "stop");
});

test("detached CLI start is idempotent and leaves the daemon owned by its state directory", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const root = await workspace(t);
  const stateDir = join(root, "state");
  const config = join(root, "config.ts");
  await writeFile(
    config,
    'export const update="off";export default ({tk})=>[tk({id:"s",cwd:"."})];',
  );
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [
          resolve("src/cli.ts"),
          ...args,
          "--state-dir",
          stateDir,
          "--json",
        ])
      ).stdout,
    );
  t.after(async () => {
    await request(stateDir, "stop").catch(() => {});
  });
  const first = await run("start", "--config", config);
  const second = await run("start", "--config", config);
  assert.equal(first.pid, second.pid);
  assert.equal((await run("status")).sources[0].id, "s");
  await run("stop");
  await until(async () => {
    try {
      await request(stateDir, "ping");
      return false;
    } catch {
      return true;
    }
  }, Boolean);
});
