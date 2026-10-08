import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { startDaemon } from "../src/daemon.ts";
import { workspace } from "./helpers.ts";

const exec = promisify(execFile);
const client = new URL("../src/client.ts", import.meta.url).href;
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const evaluate = (root: string, homeOnly = false) => {
  const env = { ...process.env, HOME: root, XDG_STATE_HOME: root };
  if (homeOnly) delete (env as NodeJS.ProcessEnv).XDG_STATE_HOME;
  return spawnSync(process.execPath, ["--input-type=module", "-e",
    `import { defaultStateDir } from ${JSON.stringify(client)}; console.log(defaultStateDir());`,
  ], { env, encoding: "utf8" });
};

test("new installs use machines-dispatch without creating state during resolution", async (t) => {
  const root = await workspace(t);
  const result = evaluate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), join(root, "machines-dispatch"));
  assert.equal(existsSync(join(root, "machines-dispatch")), false);
  const home = evaluate(root, true);
  assert.equal(home.status, 0, home.stderr);
  assert.equal(home.stdout.trim(), join(root, ".local/state/machines-dispatch"));
});

test("legacy state is reused in place instead of creating another execution journal", async (t) => {
  const root = await workspace(t);
  const legacy = join(root, "auto-machines");
  await mkdir(legacy);
  await writeFile(join(legacy, "executions.sqlite"), "synthetic journal sentinel");
  const result = evaluate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), legacy);
  assert.equal(await readFile(join(legacy, "executions.sqlite"), "utf8"), "synthetic journal sentinel");
  assert.equal(existsSync(join(root, "machines-dispatch")), false);
});

test("canonical state works and aliases to the same directory are not a conflict", async (t) => {
  const root = await workspace(t);
  const current = join(root, "machines-dispatch");
  await mkdir(current);
  assert.equal(evaluate(root).stdout.trim(), current);
  await symlink("machines-dispatch", join(root, "auto-machines"), "dir");
  const result = evaluate(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), current);
});

test("two different state directories require an explicit choice, but help still works", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, "auto-machines"));
  await mkdir(join(root, "machines-dispatch"));
  const result = evaluate(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--state-dir/);
  const help = await exec(process.execPath, [cli, "help"], {
    env: { ...process.env, XDG_STATE_HOME: root },
  });
  assert.match(help.stdout, /^machines-dispatch <command>/);
});

test("explicit --state-dir bypasses default-directory ambiguity", async (t) => {
  const root = await workspace(t);
  await mkdir(join(root, "auto-machines"));
  await mkdir(join(root, "machines-dispatch"));
  const stateDir = join(root, "selected");
  const daemon = await startDaemon({ stateDir, sources: [] });
  t.after(() => daemon.close());
  const result = await exec(process.execPath, [cli, "status", "--state-dir", stateDir, "--json"], {
    env: { ...process.env, XDG_STATE_HOME: root },
  });
  assert.deepEqual(JSON.parse(result.stdout), { sources: [], attempts: [] });
});

test("a dangling legacy alias does not silently create a second namespace", async (t) => {
  const root = await workspace(t);
  await symlink("missing-state", join(root, "auto-machines"), "dir");
  const result = evaluate(root);
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(join(root, "machines-dispatch")), false);
});

test("a state path occupied by a file fails rather than discarding legacy history", async (t) => {
  const root = await workspace(t);
  await writeFile(join(root, "auto-machines"), "not a directory");
  const result = evaluate(root);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /not a directory/);
});
