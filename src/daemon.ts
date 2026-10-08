import { createServer, type Server } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { Engine } from "./engine.ts";
import { Store } from "./store.ts";
import { loadConfiguration } from "./config.ts";
import type { WorkSource } from "./contracts.ts";
import { errorMessage, nonempty } from "./validation.ts";

export interface DaemonOptions {
  stateDir: string;
  config?: string;
  sources?: readonly WorkSource[];
  intervalMs?: number;
}
export interface Daemon {
  close(): Promise<void>;
  readonly engine: Engine;
}
export async function startDaemon(options: DaemonOptions): Promise<Daemon> {
  if (process.platform !== "linux")
    throw new Error("The first daemon release supports Linux");
  await mkdir(options.stateDir, { recursive: true, mode: 0o700 });
  const directory = await realpath(options.stateDir);
  await chmod(directory, 0o700);
  // A separate SQLite lock is held for the daemon lifetime. OS locks release on
  // process death; neither stale PIDs nor racing socket cleanup select the owner.
  const lock = new DatabaseSync(join(directory, "daemon-lock.sqlite"));
  try {
    lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
  } catch {
    lock.close();
    throw new Error(
      "An machines-dispatch daemon already owns this state directory",
    );
  }
  const socket = join(directory, "daemon.sock");
  let store: Store | undefined;
  let engine: Engine | undefined;
  let server: Server | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      try {
        await engine?.close();
        if (server?.listening)
          await new Promise<void>((resolve, reject) =>
            server!.close((error) => (error ? reject(error) : resolve())),
          );
        await unlink(socket).catch(() => {});
      } finally {
        store?.close();
        lock.close();
      }
    })());
  try {
    const sources =
      options.sources ??
      (options.config ? await loadConfiguration(options.config) : undefined);
    if (!sources) throw new Error("A configuration or sources are required");
    store = new Store(join(directory, "executions.sqlite"));
    engine = new Engine(store, sources, options.intervalMs);
    const runtime = engine;
    server = createServer(async (req, res) => {
      const reply = (code: number, value: unknown) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      try {
        if (req.method !== "POST") throw new Error("Use POST");
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > 1_048_576) throw new Error("Request exceeds 1 MiB");
          chunks.push(Buffer.from(chunk));
        }
        const body: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8") || "{}",
        );
        const idBody = () => v.parse(v.strictObject({ id: nonempty }), body);
        switch (req.url) {
          case "/ping":
            reply(200, {
              pid: process.pid,
              config: options.config,
              stateDir: directory,
            });
            break;
          case "/sources":
            reply(200, runtime.sourcesStatus());
            break;
          case "/status": {
            const { id } = v.parse(
              v.strictObject({ id: v.optional(nonempty) }),
              body,
            );
            reply(
              200,
              id
                ? runtime.store.get(id)
                : {
                    sources: runtime.sourcesStatus(),
                    attempts: runtime.store.list(),
                  },
            );
            break;
          }
          case "/logs":
            reply(200, runtime.store.events(idBody().id));
            break;
          case "/cancel":
            runtime.cancel(idBody().id);
            reply(200, { cancelled: true });
            break;
          case "/retry":
            reply(200, await runtime.retry(idBody().id));
            break;
          case "/respond": {
            const { id, requestId, response } = v.parse(
              v.strictObject({
                id: nonempty,
                requestId: nonempty,
                response: v.string(),
              }),
              body,
            );
            await runtime.respond(id, requestId, response);
            reply(200, { accepted: true });
            break;
          }
          case "/stop":
            reply(200, { stopping: true });
            setImmediate(() => {
              void close().catch((cause) =>
                process.emitWarning(errorMessage(cause)),
              );
            });
            break;
          default:
            throw new Error("Unknown daemon operation");
        }
      } catch (cause) {
        if (!res.headersSent) reply(400, { error: errorMessage(cause) });
      }
    });
    server.requestTimeout = 30_000;
    await unlink(socket).catch((cause) => {
      if (cause.code !== "ENOENT") throw cause;
    });
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(socket, resolve);
    });
    await chmod(socket, 0o600);
    engine.start();
    return { engine, close };
  } catch (cause) {
    await close();
    throw cause;
  }
}
