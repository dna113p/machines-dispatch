#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { startDaemon } from "./daemon.ts";
import { request, defaultStateDir } from "./client.ts";
import { errorMessage } from "./validation.ts";

const usage = `machines-dispatch <command> [--state-dir directory] [--json]
  daemon --config file       Run in the foreground
  start --config file        Start a detached local daemon
  stop                       Stop daemon and interrupt active attempts
  sources                    Show registration health
  status [attempt]           Show executions and pending Human requests
  logs <attempt>             Show persisted observations
  respond <attempt> <request> <response>
  cancel <attempt>           Cancel active execution
  retry <attempt>            Deliberately retry eligible work`;
async function main(): Promise<void> {
  const positional: string[] = [];
  let stateDir: string | undefined;
  let config: string | undefined;
  let json = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--json") json = true;
    else if (arg === "--config" || arg === "--state-dir") {
      const value = args[++index];
      if (!value) throw new Error(`Missing ${arg} value`);
      if (arg === "--config") config = resolve(value);
      else stateDir = resolve(value);
    } else positional.push(arg);
  }
  const [command, ...rest] = positional;
  const print = (value: unknown) =>
    console.log(JSON.stringify(value, null, json ? undefined : 2));
  if (!command || command === "help" || command === "--help") {
    console.log(usage);
    return;
  }
  stateDir ??= defaultStateDir();
  if (command === "daemon") {
    if (!config || rest.length) throw new Error(usage);
    const daemon = await startDaemon({ stateDir, config });
    const stop = () => {
      void daemon.close().catch((cause) => {
        console.error(errorMessage(cause));
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    print({ running: true, stateDir });
    return;
  }
  if (command === "start") {
    if (!config || rest.length) throw new Error(usage);
    try {
      print(await request(stateDir, "ping"));
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ECONNREFUSED") throw cause;
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const log = await open(join(stateDir, "daemon.log"), "a", 0o600);
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(import.meta.url),
        "daemon",
        "--config",
        config,
        "--state-dir",
        stateDir,
      ],
      {
        detached: true,
        stdio: ["ignore", log.fd, log.fd],
      },
    );
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.unref();
    await log.close();
    for (let tries = 0; tries < 100; tries++) {
      if (spawnError) throw spawnError;
      try {
        print(await request(stateDir, "ping"));
        return;
      } catch {
        await delay(100);
      }
    }
    throw new Error(
      `Daemon did not become ready; inspect ${join(stateDir, "daemon.log")}`,
    );
  }
  const arity: Record<string, number> = {
    stop: 0,
    sources: 0,
    logs: 1,
    cancel: 1,
    retry: 1,
    respond: 3,
  };
  if (
    command === "status"
      ? rest.length > 1
      : arity[command] === undefined || rest.length !== arity[command]
  )
    throw new Error(usage);
  const payload =
    command === "respond"
      ? { id: rest[0], requestId: rest[1], response: rest[2] }
      : rest[0]
        ? { id: rest[0] }
        : {};
  print(await request(stateDir, command, payload));
}
void main().catch((cause) => {
  console.error(errorMessage(cause));
  process.exitCode = 1;
});
