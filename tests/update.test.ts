import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startDaemon } from "../src/daemon.ts";
import { request } from "../src/client.ts";
import { loadConfiguration, loadUpdateMode } from "../src/config.ts";
import { tk } from "../src/tk.ts";
import { Store } from "../src/store.ts";
import type { WorkSource } from "../src/contracts.ts";
import {
  newestVersion,
  type UpdateHooks,
  type UpdateStatus,
} from "../src/update.ts";
import { workspace, ticket, definition, until } from "./helpers.ts";

const name = "@dna113p/machines";
const registry = (version: string) =>
  `https://registry.npmjs.org/${name}/-/machines-${version}.tgz`;
const tarball = "file:../../tmp/machines-dispatch-dependency/machines.tgz";
async function copy(installRoot: string, version: string, resolved?: string) {
  const modules = join(installRoot, "node_modules");
  await mkdir(join(modules, name), { recursive: true });
  await writeFile(
    join(modules, name, "package.json"),
    JSON.stringify({ name, version }),
  );
  await writeFile(
    join(modules, ".package-lock.json"),
    JSON.stringify({
      packages: {
        [`node_modules/${name}`]: { version, ...(resolved ? { resolved } : {}) },
      },
    }),
  );
}
/** A temporary install root with a fake npm, log, and restart; nothing here is real. */
async function fixture(t: TestContext, installed: string, resolved?: string) {
  const root = await workspace(t);
  const installRoot = join(root, "app");
  await copy(installRoot, installed, resolved);
  const fake = {
    root,
    installRoot,
    stateDir: join(root, "state"),
    calls: [] as string[][],
    lines: [] as string[],
    restarts: 0,
    listed: JSON.stringify(installed) as string | Error,
    install: (version: string): Promise<void> =>
      copy(installRoot, version, registry(version)),
    restart: () => {},
    commands: (kind: string) => fake.calls.filter((call) => call[0] === kind),
  };
  const hooks: UpdateHooks = {
    installRoot,
    log: (line) => fake.lines.push(line),
    restart: () => {
      fake.restarts++;
      fake.restart();
    },
    run: async (command, args, options) => {
      assert.equal(command, "npm");
      assert.equal(options.cwd, installRoot);
      fake.calls.push([...args]);
      if (args[0] === "view") {
        if (fake.listed instanceof Error) throw fake.listed;
        return fake.listed;
      }
      assert.deepEqual(args.slice(0, -1), [
        "install",
        "--no-save",
        "--package-lock=false",
        "--no-audit",
        "--no-fund",
      ]);
      await fake.install(args.at(-1)!.slice(name.length + 1));
      return "";
    },
  };
  return Object.assign(fake, { hooks });
}
/** Counts scans, so a test can let several engine polls pass. */
function counted(source: WorkSource) {
  let scans = 0;
  return {
    source: {
      ...source,
      async scan() {
        scans++;
        return source.scan();
      },
    },
    async polls(count = 3) {
      const from = scans;
      await until(
        () => scans,
        (now) => now >= from + count,
      );
    },
  };
}
const nothing: WorkSource = {
  id: "none",
  scan: async () => ({ items: [] }),
  prepare: async () => undefined,
  apply: async () => {},
};
const state = (daemon: { updater: { status(): UpdateStatus } }, wanted: string) =>
  until(
    () => daemon.updater.status(),
    (status) => status.state === wanted,
  );

test("the newest stable version is chosen by numeric comparison", () => {
  assert.equal(newestVersion('"0.3.0"\n'), "0.3.0");
  assert.equal(newestVersion('["0.3.0","0.3.2","0.3.1"]'), "0.3.2");
  assert.equal(newestVersion('["0.3.9","0.3.10","0.3.2"]'), "0.3.10");
  assert.equal(newestVersion('["0.9.9","0.10.0","1.0.0","0.11.5"]'), "1.0.0");
  assert.equal(
    newestVersion('["0.3.1","0.3.2-beta.1","0.4.0-rc.0","0.3.3+build"]'),
    "0.3.1",
  );
  assert.equal(newestVersion('"0.4.0-rc.0"'), undefined);
  assert.equal(newestVersion(""), undefined);
  assert.throws(() => newestVersion("npm ERR! offline"), /unreadable/);
});

test("a registry copy at the newest version is current and nothing is installed", async (t) => {
  const fake = await fixture(t, "0.3.1", registry("0.3.1"));
  fake.listed = '["0.3.0","0.3.1"]';
  const quiet = counted(nothing);
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [quiet.source],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  const status = await state(daemon, "current");
  assert.equal(status.package, name);
  assert.equal(status.mode, "install");
  assert.equal(status.installed, "0.3.1");
  assert.equal(status.local, false);
  assert.equal(status.available, "0.3.1");
  assert.ok(status.checkedAt);
  assert.equal(status.error, undefined);
  await quiet.polls();
  const wanted = JSON.parse(await readFile("package.json", "utf8"))
    .dependencies[name];
  assert.deepEqual(fake.calls, [
    ["view", `${name}@${wanted}`, "version", "--json"],
  ]);
  assert.equal(fake.restarts, 0);
  assert.deepEqual(fake.lines, []);
});

test("the installed copy is read from where the runtime is loaded", async (t) => {
  const root = await workspace(t);
  const roots: string[] = [];
  const daemon = await startDaemon({
    stateDir: join(root, "state"),
    sources: [],
    update: "check",
    updateHooks: {
      log: () => {},
      restart: () => assert.fail("check mode must not restart"),
      run: async (_command, args, options) => {
        assert.equal(args[0], "view");
        roots.push(options.cwd);
        return '"0.0.0"';
      },
    },
  });
  t.after(() => daemon.close());
  const status = await state(daemon, "available");
  const manifest = join(roots[0]!, "node_modules", name, "package.json");
  assert.ok(
    fileURLToPath(import.meta.resolve(name)).startsWith(dirname(manifest) + sep),
  );
  assert.equal(
    status.installed,
    JSON.parse(await readFile(manifest, "utf8")).version,
  );
  assert.equal(typeof status.local, "boolean");
});

test("a local build with the same version number is not current", async (t) => {
  for (const resolved of [tarball, undefined]) {
    const fake = await fixture(t, "0.3.0", resolved);
    const daemon = await startDaemon({
      stateDir: fake.stateDir,
      sources: [],
      update: "check",
      updateHooks: fake.hooks,
    });
    t.after(() => daemon.close());
    const status = await state(daemon, "available");
    assert.equal(status.installed, "0.3.0");
    assert.equal(status.available, "0.3.0");
    assert.equal(status.local, true);
    assert.match(fake.lines.join("\n"), /0\.3\.0 is available .*local build/);
  }
});

test("check mode reports an update without installing; update --install installs it once idle", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '["0.3.0","0.3.1"]';
  const quiet = counted(nothing);
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [quiet.source],
    intervalMs: 20,
    update: "check",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  const status = await state(daemon, "available");
  assert.equal(status.mode, "check");
  assert.equal(status.installed, "0.3.0");
  assert.equal(status.local, false);
  assert.equal(status.available, "0.3.1");
  await quiet.polls();
  assert.deepEqual(fake.commands("install"), []);
  const checked = (await request(fake.stateDir, "update")) as UpdateStatus;
  assert.equal(checked.state, "available");
  await quiet.polls();
  assert.deepEqual(fake.commands("install"), []);
  assert.equal(fake.restarts, 0);
  const asked = (await request(fake.stateDir, "update", {
    install: true,
  })) as UpdateStatus;
  assert.equal(asked.state, "installing");
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  assert.deepEqual(fake.commands("install"), [
    [
      "install",
      "--no-save",
      "--package-lock=false",
      "--no-audit",
      "--no-fund",
      `${name}@0.3.1`,
    ],
  ]);
  assert.equal(
    fake.lines.filter((line) => /0\.3\.1 is available/.test(line)).length,
    1,
  );
});

test("install mode with an idle engine installs, verifies, closes, then restarts", async (t) => {
  const fake = await fixture(t, "0.3.0", tarball);
  fake.listed = '["0.3.0","0.3.1"]';
  const events: string[] = [];
  const socket = join(fake.stateDir, "daemon.sock");
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    intervalMs: 20,
    update: "install",
    updateHooks: {
      ...fake.hooks,
      run: async (command, args, options) => {
        events.push(
          `${args[0]} ${existsSync(socket) ? "serving" : "closed"} ${daemon.updater.status().state}`,
        );
        return fake.hooks.run!(command, args, options);
      },
    },
  });
  t.after(() => daemon.close());
  fake.restart = () =>
    events.push(`restart ${existsSync(socket) ? "serving" : "closed"}`);
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  assert.deepEqual(events, [
    "view serving checking",
    "install serving installing",
    "restart closed",
  ]);
  assert.equal(daemon.updater.status().installed, "0.3.1");
  assert.equal(daemon.updater.status().local, false);
  assert.deepEqual(
    fake.lines.map((line) => line.replace(/^machines-dispatch: /, "")),
    [
      `${name} 0.3.1 is available (installed: 0.3.0, a local build)`,
      `installing ${name} 0.3.1 in ${fake.installRoot}`,
      `restarting to load ${name} 0.3.1`,
    ],
  );
  // The closed daemon released its lock: the replacement process can own the state.
  const next = await startDaemon({ stateDir: fake.stateDir, sources: [] });
  t.after(() => next.close());
  // That process finds its copy current, so a restart cannot loop.
  fake.calls.length = 0;
  const again = await startDaemon({
    stateDir: join(fake.root, "state-after"),
    sources: [],
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => again.close());
  await state(again, "current");
  assert.deepEqual(fake.commands("install"), []);
  assert.equal(fake.restarts, 1);
});

test("a running, waiting, or delivery-pending attempt defers the install until it ends", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  const go = join(fake.root, "go");
  await ticket(fake.root, "a", "machine: phased\n");
  await writeFile(
    join(fake.root, ".machines", "phased.ts"),
    `
import {existsSync} from "node:fs";
export const description="Runs until released, then asks a Human";
export default ({machine,operation,human,final})=>machine({initial:"work",output:()=>({action:"complete",summary:"Verified"}),states:{
work:operation(async()=>{while(!existsSync(${JSON.stringify(go)}))await new Promise(r=>setTimeout(r,20));return {type:"done"}},{done:"review"}),
review:human("Approve?",{submitted:"done"},{choices:["yes","no"]}),done:final()}});`,
  );
  const source = tk({ id: "s", cwd: fake.root, home: join(fake.root, "home") });
  let deliver!: () => void;
  const delivery = new Promise<void>((resolve) => (deliver = resolve));
  const busy = counted({
    ...source,
    async apply(report) {
      await delivery;
      await source.apply(report);
    },
  });
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [busy.source],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  const attempt = () => daemon.engine.store.list()[0];
  const deferred = async () => {
    await state(daemon, "waiting");
    await busy.polls();
    assert.equal(daemon.updater.status().state, "waiting");
    assert.deepEqual(fake.commands("install"), []);
  };
  await until(attempt, (a) => a?.status === "running");
  await deferred();
  await writeFile(go, "");
  const waiting = await until(attempt, (a) => a?.status === "waiting");
  await deferred();
  await daemon.engine.respond(waiting!.id, waiting!.human!.requestId, "yes");
  await until(
    attempt,
    (a) => a?.status === "completed" && a.delivery === "pending",
  );
  await deferred();
  assert.equal(fake.restarts, 0);
  deliver();
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  // One check found the update; the install followed the attempt, not a later check.
  assert.equal(fake.commands("view").length, 1);
  assert.deepEqual(
    fake.commands("install").map((call) => call.at(-1)),
    [`${name}@0.3.1`],
  );
  const journal = new Store(join(fake.stateDir, "executions.sqlite"));
  t.after(() => journal.close());
  assert.deepEqual(
    journal.list().map((a) => [a.status, a.delivery]),
    [["completed", "applied"]],
  );
});

test("no attempt is admitted between the hold and the restart", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  await definition(fake.root, "work");
  const source = counted(
    tk({ id: "s", cwd: fake.root, home: join(fake.root, "home") }),
  );
  let started!: () => void;
  const installing = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  fake.install = async (version) => {
    started();
    await finished;
    await copy(fake.installRoot, version, registry(version));
  };
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [source.source],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  await installing;
  await ticket(fake.root, "a", "machine: work\n");
  await source.polls(5);
  assert.deepEqual(daemon.engine.store.list(), []);
  assert.equal(daemon.updater.status().state, "installing");
  finish();
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  const journal = new Store(join(fake.stateDir, "executions.sqlite"));
  assert.deepEqual(journal.list(), []);
  journal.close();
  // The ticket is still there for the replacement process.
  const next = await startDaemon({
    stateDir: fake.stateDir,
    sources: [source.source],
    intervalMs: 20,
  });
  t.after(() => next.close());
  await until(
    () => next.engine.store.list(),
    (list) => list.length === 1 && list[0]!.delivery === "applied",
  );
});

test("a failed install, or one that leaves the wrong copy, releases the hold and does not restart", async (t) => {
  const installs: [string, () => Promise<void>, RegExp][] = [
    [
      "0.3.0",
      async () => {
        throw new Error("npm install exited with code 1");
      },
      /install exited with code 1/,
    ],
    // npm reports success, but the copy on disk is still the local build.
    ["0.3.1", async () => {}, /left @dna113p\/machines 0\.3\.1 \(a local build\)/],
  ];
  for (const [installed, install, error] of installs) {
    const fake = await fixture(t, installed, tarball);
    fake.listed = '"0.3.1"';
    fake.install = install;
    await definition(fake.root, "work");
    const daemon = await startDaemon({
      stateDir: fake.stateDir,
      sources: [tk({ id: "s", cwd: fake.root, home: join(fake.root, "home") })],
      intervalMs: 20,
      update: "install",
      updateHooks: fake.hooks,
    });
    t.after(() => daemon.close());
    const failed = await state(daemon, "failed");
    assert.match(failed.error!, error);
    assert.equal(failed.installed, installed);
    assert.equal(failed.local, true);
    assert.equal(fake.commands("install").length, 1);
    // Work continues on the copy that is loaded.
    await ticket(fake.root, "a", "machine: work\n");
    await until(
      () => daemon.engine.store.list(),
      (list) => list.length === 1 && list[0]!.delivery === "applied",
    );
    assert.equal(daemon.updater.status().state, "failed");
    // A later check tries again, without repeating the same lines.
    await daemon.updater.check();
    await until(
      () => fake.commands("install").length,
      (count) => count === 2,
    );
    await state(daemon, "failed");
    assert.equal(fake.restarts, 0);
    assert.deepEqual(
      fake.lines.map((line) => line.split(" ").slice(1, 4).join(" ")),
      [
        `${name} 0.3.1 is`,
        `installing ${name} 0.3.1`,
        `${name} install failed:`,
      ],
    );
    await request(fake.stateDir, "ping");
  }
});

test("a failed check is reported and work continues", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = new Error("spawn npm ENOENT");
  await definition(fake.root, "work");
  await ticket(fake.root, "a", "machine: work\n");
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [tk({ id: "s", cwd: fake.root, home: join(fake.root, "home") })],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  const failed = await state(daemon, "failed");
  assert.equal(failed.error, "spawn npm ENOENT");
  assert.equal(failed.installed, "0.3.0");
  assert.equal(failed.available, undefined);
  assert.ok(failed.checkedAt);
  await until(
    () => daemon.engine.store.list(),
    (list) => list.length === 1 && list[0]!.delivery === "applied",
  );
  fake.listed = "not json";
  assert.match((await daemon.updater.check()).error!, /unreadable/);
  fake.listed = '["0.4.0-rc.1"]';
  assert.match((await daemon.updater.check()).error!, /no stable/);
  assert.match((await daemon.updater.check()).error!, /no stable/);
  assert.deepEqual(
    fake.lines.map((line) => line.replace(/^.* check failed: /, "")),
    [
      "spawn npm ENOENT",
      "npm printed an unreadable version list",
      `npm lists no stable ${name} version matching ${
        JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).dependencies[name]
      }`,
    ],
  );
  // The next check succeeds and clears the failure.
  fake.listed = '"0.3.0"';
  const recovered = await daemon.updater.check();
  assert.equal(recovered.state, "current");
  assert.equal(recovered.error, undefined);
  assert.deepEqual(fake.commands("install"), []);
  assert.equal(fake.restarts, 0);
});

test("checks repeat on the interval and report an update once", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    update: "check",
    updateHooks: { ...fake.hooks, checkIntervalMs: 20 },
  });
  t.after(() => daemon.close());
  await until(
    () => fake.commands("view").length,
    (count) => count >= 4,
  );
  assert.equal(fake.lines.length, 1);
  assert.deepEqual(fake.commands("install"), []);
  await daemon.close();
  const checks = fake.calls.length;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(fake.calls.length, checks);
});

test("off checks nothing, and a daemon given sources runs no command", async (t) => {
  const fake = await fixture(t, "0.3.0", tarball);
  fake.listed = '"0.3.1"';
  const off = { package: name, mode: "off", state: "off" };
  const implicit = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    intervalMs: 20,
    updateHooks: { ...fake.hooks, checkIntervalMs: 20 },
  });
  t.after(() => implicit.close());
  const config = join(fake.root, "config.ts");
  await writeFile(
    config,
    'export const update = "install";\nexport default ({tk})=>[tk({id:"s",cwd:"."})];',
  );
  const explicit = await startDaemon({
    stateDir: join(fake.root, "state-explicit"),
    config,
    intervalMs: 20,
    update: "off",
    updateHooks: { ...fake.hooks, checkIntervalMs: 20 },
  });
  t.after(() => explicit.close());
  await new Promise((resolve) => setTimeout(resolve, 150));
  for (const daemon of [implicit, explicit])
    assert.deepEqual(daemon.updater.status(), off);
  assert.deepEqual(await request(fake.stateDir, "update"), off);
  await assert.rejects(
    request(fake.stateDir, "update", { install: true }),
    /Updates are off/,
  );
  assert.deepEqual(fake.calls, []);
  assert.deepEqual(fake.lines, []);
  assert.equal(fake.restarts, 0);
});

test("the configuration's update export selects the mode and leaves the sources alone", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  const write = async (file: string, update: string) => {
    const path = join(fake.root, file);
    await writeFile(
      path,
      `${update}export default ({tk})=>[tk({id:"s",cwd:"."})];`,
    );
    return path;
  };
  const plain = await write("plain.ts", "");
  const installs = await write("install.ts", 'export const update="install";');
  const invalid = await write("invalid.ts", 'export const update="always";');
  const boolean = await write("boolean.ts", "export const update=true;");
  assert.equal(await loadUpdateMode(plain), undefined);
  assert.equal(await loadUpdateMode(installs), "install");
  for (const path of [plain, installs]) {
    const sources = await loadConfiguration(path);
    assert.ok(Array.isArray(sources));
    assert.deepEqual(
      sources.map((source) => source.id),
      ["s"],
    );
  }
  for (const path of [invalid, boolean]) {
    await assert.rejects(loadUpdateMode(path), /"update" must be one of/);
    await assert.rejects(loadConfiguration(path), /"update" must be one of/);
    await assert.rejects(
      startDaemon({ stateDir: join(fake.root, "state-invalid"), config: path }),
      /"check", "install", "off"/,
    );
  }
  const started = async (config: string, update?: "check") => {
    const daemon = await startDaemon({
      stateDir: join(fake.root, `state-${fake.calls.length}-${update}`),
      config,
      ...(update ? { update } : {}),
      updateHooks: fake.hooks,
    });
    t.after(() => daemon.close());
    const status = await state(daemon, "current");
    await daemon.close();
    return status.mode;
  };
  assert.equal(await started(plain), "check");
  assert.equal(await started(installs), "install");
  assert.equal(await started(installs, "check"), "check");
});

test("status carries the update state beside unchanged sources and attempts", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  await definition(fake.root, "work");
  await ticket(fake.root, "a", "machine: work\n");
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [tk({ id: "s", cwd: fake.root, home: join(fake.root, "home") })],
    intervalMs: 20,
    update: "check",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  await state(daemon, "available");
  await until(
    () => daemon.engine.store.list(),
    (list) => list.length === 1 && list[0]!.delivery === "applied",
  );
  const status = (await request(fake.stateDir, "status")) as Record<
    string,
    unknown
  >;
  assert.deepEqual(Object.keys(status), ["sources", "attempts", "update"]);
  assert.deepEqual(status.sources, daemon.engine.sourcesStatus());
  assert.deepEqual(status.attempts, daemon.engine.store.list());
  assert.deepEqual(status.update, daemon.updater.status());
  assert.deepEqual(
    await request(fake.stateDir, "status", {
      id: daemon.engine.store.list()[0]!.id,
    }),
    daemon.engine.store.list()[0],
  );
});

test("the update command reaches the daemon over its socket", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    intervalMs: 20,
    update: "check",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  await state(daemon, "current");
  const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
  const run = async (...args: string[]) =>
    JSON.parse(
      (
        await promisify(execFile)(process.execPath, [
          cli,
          ...args,
          "--state-dir",
          fake.stateDir,
          "--json",
        ])
      ).stdout,
    ) as UpdateStatus;
  fake.listed = '["0.3.0","0.3.1","0.3.2-next.0"]';
  const found = await run("update");
  assert.equal(found.state, "available");
  assert.equal(found.available, "0.3.1");
  assert.equal(fake.commands("view").length, 2);
  assert.deepEqual(found, daemon.updater.status());
  assert.deepEqual(fake.commands("install"), []);
  await assert.rejects(run("status", "--install"), /update \[--install\]/);
  await assert.rejects(
    request(fake.stateDir, "update", { install: "yes" }),
    /boolean/i,
  );
  const asked = await run("update", "--install");
  assert.equal(asked.state, "installing");
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  assert.deepEqual(
    fake.commands("install").map((call) => call.at(-1)),
    [`${name}@0.3.1`],
  );
});

test("without process.execve, install mode only checks and says why", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  const quiet = counted(nothing);
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [quiet.source],
    intervalMs: 20,
    update: "install",
    updateHooks: { ...fake.hooks, restart: null },
  });
  t.after(() => daemon.close());
  const status = await state(daemon, "available");
  assert.equal(status.mode, "check");
  assert.match(status.note!, /no process\.execve/);
  await quiet.polls();
  await assert.rejects(
    request(fake.stateDir, "update", { install: true }),
    /no process\.execve/,
  );
  assert.deepEqual(fake.commands("install"), []);
});

test("a daemon stopped while installing is not restarted", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  let started!: () => void;
  const installing = new Promise<void>((resolve) => (started = resolve));
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));
  let installed!: () => void;
  const done = new Promise<void>((resolve) => (installed = resolve));
  fake.install = async (version) => {
    started();
    await finished;
    await copy(fake.installRoot, version, registry(version));
    setTimeout(installed, 100);
  };
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  await installing;
  await daemon.close();
  finish();
  await done;
  assert.equal(fake.restarts, 0);
});

test("an install that fails after replacing the copy is tried again, not taken for current", async (t) => {
  const fake = await fixture(t, "0.3.0", registry("0.3.0"));
  fake.listed = '"0.3.1"';
  // npm exits with an error after it has put the release in place.
  fake.install = async (version) => {
    await copy(fake.installRoot, version, registry(version));
    throw new Error("npm install exited with code 1");
  };
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [],
    intervalMs: 20,
    update: "install",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  const failed = await state(daemon, "failed");
  assert.equal(failed.installed, "0.3.1");
  assert.equal(failed.local, false);
  assert.match(failed.note!, /still runs 0\.3\.0/);
  assert.equal(fake.restarts, 0);
  // This process still runs 0.3.0, so the next check installs again and restarts.
  fake.install = (version) => copy(fake.installRoot, version, registry(version));
  assert.equal((await daemon.updater.check()).state, "installing");
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
  assert.deepEqual(
    fake.commands("install").map((call) => call.at(-1)),
    [`${name}@0.3.1`, `${name}@0.3.1`],
  );
});

test("a release put on disk while the daemon runs is not current until a restart", async (t) => {
  const fake = await fixture(t, "0.3.0", tarball);
  fake.listed = '"0.3.0"';
  const quiet = counted(nothing);
  const daemon = await startDaemon({
    stateDir: fake.stateDir,
    sources: [quiet.source],
    intervalMs: 20,
    update: "check",
    updateHooks: fake.hooks,
  });
  t.after(() => daemon.close());
  await state(daemon, "available");
  await copy(fake.installRoot, "0.3.0", registry("0.3.0"));
  const status = await daemon.updater.check();
  assert.equal(status.state, "available");
  assert.equal(status.installed, "0.3.0");
  assert.equal(status.local, false);
  assert.match(status.note!, /still runs 0\.3\.0 \(a local build\)/);
  assert.match(fake.lines.at(-1)!, /0\.3\.0 is installed but not loaded/);
  await quiet.polls();
  assert.deepEqual(fake.commands("install"), []);
  // Asked to, the daemon restarts onto it like any other update.
  await request(fake.stateDir, "update", { install: true });
  await until(
    () => fake.restarts,
    (restarts) => restarts === 1,
  );
});

test("a failed update --install is tried again at a later check, for that version only", async (t) => {
  for (const later of ['"0.3.1"', '["0.3.1","0.3.2"]']) {
    const fake = await fixture(t, "0.3.0", registry("0.3.0"));
    fake.listed = '"0.3.1"';
    fake.install = async () => {
      throw new Error("npm install exited with code 1");
    };
    const quiet = counted(nothing);
    const daemon = await startDaemon({
      stateDir: fake.stateDir,
      sources: [quiet.source],
      intervalMs: 20,
      update: "check",
      updateHooks: fake.hooks,
    });
    t.after(() => daemon.close());
    await state(daemon, "available");
    await request(fake.stateDir, "update", { install: true });
    const failed = await state(daemon, "failed");
    assert.match(failed.error!, /install exited with code 1/);
    // Nothing is retried before the next check.
    await quiet.polls();
    assert.equal(fake.commands("install").length, 1);
    fake.install = (version) =>
      copy(fake.installRoot, version, registry(version));
    fake.listed = later;
    const checked = (await request(fake.stateDir, "update")) as UpdateStatus;
    if (later === '"0.3.1"') {
      // The request stands without being repeated.
      assert.equal(checked.state, "installing");
      await until(
        () => fake.restarts,
        (restarts) => restarts === 1,
      );
      assert.deepEqual(
        fake.commands("install").map((call) => call.at(-1)),
        [`${name}@0.3.1`, `${name}@0.3.1`],
      );
    } else {
      // A release nobody asked for is only reported, as check mode promises.
      assert.equal(checked.state, "available");
      assert.equal(checked.available, "0.3.2");
      await quiet.polls();
      assert.equal(fake.commands("install").length, 1);
      assert.equal(fake.restarts, 0);
    }
  }
});
