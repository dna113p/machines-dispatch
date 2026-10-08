import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, cp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
const exec = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const temp = await mkdtemp(join(tmpdir(), "machines-dispatch-package-"));
let child;
try {
  const packed = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
        { cwd: root },
      )
    ).stdout,
  )[0];
  assert.ok(
    packed.files.some((f) => f.path === "examples/demo/.machines/research.ts"),
  );
  const installedMachines = join(root, "node_modules/@dna113p/machines");
  const machines = JSON.parse(
    (
      await exec(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temp],
        { cwd: installedMachines },
      )
    ).stdout,
  )[0];
  await writeFile(
    join(temp, "package.json"),
    '{"private":true,"type":"module"}\n',
  );
  await exec(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      join(temp, machines.filename),
      join(temp, packed.filename),
    ],
    { cwd: temp },
  );
  assert.equal(packed.name, "@dna113p/machines-dispatch");
  await exec(process.execPath, ["--input-type=module", "-e",
    'import { tk, github, startDaemon, request } from "@dna113p/machines-dispatch"; ' +
    'if (![tk, github, startDaemon, request].every(value => typeof value === "function")) throw new Error("Missing public export");',
  ], { cwd: temp });
  for (const name of ["machines-dispatch", "auto-machines"]) {
    const help = await exec(join(temp, "node_modules/.bin", name), ["help"], { cwd: temp });
    assert.match(help.stdout, /^machines-dispatch <command>/);
  }
  const cli = join(temp, "node_modules/@dna113p/machines-dispatch/dist/src/cli.js");
  const demo = join(temp, "demo");
  await cp(
    join(temp, "node_modules/@dna113p/machines-dispatch/examples/demo"),
    demo,
    { recursive: true },
  );
  const state = join(temp, "state");
  const config = join(demo, "machines-dispatch.config.ts");
  const run = async (...args) =>
    JSON.parse(
      (
        await exec(
          process.execPath,
          [cli, ...args, "--state-dir", state, "--json"],
          { cwd: temp },
        )
      ).stdout,
    );
  child = spawn(
    process.execPath,
    [cli, "daemon", "--config", config, "--state-dir", state],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let diagnostics = "";
  child.stderr.on("data", (chunk) => (diagnostics += chunk));
  let waiting;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const status = await run("status");
      waiting = status.attempts.find((a) => a.status === "waiting");
      if (waiting) break;
      const failed = status.attempts.find(
        (a) => a.status === "failed" || a.delivery === "conflict",
      );
      if (failed) throw new Error(JSON.stringify(failed));
    } catch (error) {
      if (error.code !== 1 && error.code !== "ENOENT") throw error;
    }
    if (child.exitCode !== null) throw new Error(diagnostics);
    await delay(100);
  }
  assert.ok(
    waiting,
    diagnostics || "Installed daemon did not reach Human review",
  );
  await run("respond", waiting.id, waiting.human.requestId, "approve");
  let done = false;
  while (Date.now() < deadline) {
    const status = await run("status");
    if (
      status.attempts.length === 2 &&
      status.attempts.every((a) => a.delivery === "applied")
    ) {
      done = true;
      break;
    }
    await delay(100);
  }
  assert.ok(done, "Installed daemon did not finish writeback");
  await run("stop");
  await new Promise((resolve, reject) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(() => reject(new Error("Daemon failed to stop")), 5000).unref();
  });
  console.log(
    "Installed machines-dispatch package: public exports, canonical/legacy CLI, native tk tickets, routing, fake Agents, Human response, and durable writeback passed.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
  }
  await rm(temp, { recursive: true, force: true });
}
