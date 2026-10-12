import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { Engine } from "./engine.ts";
import { errorMessage } from "./validation.ts";

/** The Machines runtime this daemon imports. Dispatch's own package is not covered. */
export const runtimePackage = "@dna113p/machines";
export const updateModes = ["check", "install", "off"] as const;
export type UpdateMode = (typeof updateModes)[number];
export interface UpdateStatus {
  package: string;
  mode: UpdateMode;
  state:
    | "off"
    | "checking"
    | "current"
    | "available"
    | "waiting"
    | "installing"
    | "failed";
  installed?: string;
  /** The installed copy did not come from a registry, whatever its version says. */
  local?: boolean;
  available?: string;
  checkedAt?: string;
  error?: string;
  note?: string;
}
/** Runs a command and resolves with its standard output. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; signal?: AbortSignal },
) => Promise<string>;
/** Replaceable effects; the defaults use npm, the real clock, and `process.execve`. */
export interface UpdateHooks {
  run?: CommandRunner;
  /** Replaces this process after an install; `null` when that is impossible. */
  restart?: (() => void) | null;
  /** Directory holding the `node_modules` the Machines runtime is loaded from. */
  installRoot?: string;
  /** Version range to stay inside; Dispatch's own dependency range by default. */
  range?: string;
  checkIntervalMs?: number;
  log?: (line: string) => void;
}
export interface UpdaterOptions extends UpdateHooks {
  mode: UpdateMode;
  engine: Engine;
  /** Closes the daemon ahead of a restart. */
  close: () => Promise<void>;
  /** Someone asked the daemon to stop; it must not be restarted. */
  stopped: () => boolean;
}

const execFileAsync = promisify(execFile);
const runCommand: CommandRunner = async (command, args, options) =>
  (
    await execFileAsync(command, [...args], {
      cwd: options.cwd,
      timeout: options.timeoutMs,
      signal: options.signal,
      maxBuffer: 16 * 1_048_576,
    })
  ).stdout;
/** The same PID continues, so no supervisor has to cooperate. */
function processRestart(): (() => void) | null {
  if (typeof process.execve !== "function") return null;
  return () => {
    try {
      process.execve!(
        process.execPath,
        [process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        process.env,
      );
    } catch (cause) {
      // The daemon is already closed; do not let that look like a clean stop.
      process.exitCode = 1;
      throw cause;
    }
  };
}
const withoutRestart =
  "This Node has no process.execve, so the daemon cannot restart itself";

/** npm prints one matching version as a JSON string and several as an array. */
export function newestVersion(output: string): string | undefined {
  if (!output.trim()) return undefined;
  let listed: unknown;
  try {
    listed = JSON.parse(output);
  } catch {
    throw new Error("npm printed an unreadable version list");
  }
  let newest: number[] | undefined;
  for (const version of Array.isArray(listed) ? listed : [listed]) {
    // Stable releases only: a prerelease or build suffix is never chosen.
    if (
      typeof version !== "string" ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    )
      continue;
    const parts = version.split(".").map(Number);
    const differs = parts.findIndex((part, index) => part !== newest?.[index]);
    if (!newest || (differs >= 0 && parts[differs]! > newest[differs]!))
      newest = parts;
  }
  return newest?.join(".");
}
export interface InstalledCopy {
  version: string;
  local: boolean;
}
/** Reads the copy on disk and npm's record of where it came from. */
export async function readInstalled(
  installRoot: string,
): Promise<InstalledCopy> {
  const modules = join(installRoot, "node_modules");
  const manifest: { version?: unknown } | null = JSON.parse(
    await readFile(join(modules, runtimePackage, "package.json"), "utf8"),
  );
  const version = manifest?.version;
  if (typeof version !== "string")
    throw new Error(`${runtimePackage} in ${modules} has no version`);
  let record: { version?: unknown; resolved?: unknown } | undefined;
  try {
    record = JSON.parse(
      await readFile(join(modules, ".package-lock.json"), "utf8"),
    )?.packages?.[`node_modules/${runtimePackage}`];
  } catch {
    // No readable record: npm did not put this copy there from a registry.
  }
  return {
    version,
    local:
      record?.version !== version ||
      typeof record.resolved !== "string" ||
      !/^https?:\/\//.test(record.resolved),
  };
}
function locateInstallRoot(): string {
  const entry = fileURLToPath(import.meta.resolve(runtimePackage));
  const held = `${sep}${join("node_modules", runtimePackage)}${sep}`;
  const at = entry.lastIndexOf(held);
  // A linked checkout resolves to its real path; npm must not install over it.
  if (at < 0)
    throw new Error(
      `${runtimePackage} is not loaded from a node_modules directory (${entry})`,
    );
  return entry.slice(0, at) || sep;
}
async function wantedRange(): Promise<string> {
  // Sources sit one directory below Dispatch's package.json; built files sit two.
  for (const relative of ["../package.json", "../../package.json"]) {
    let manifest: {
      name?: unknown;
      dependencies?: Record<string, unknown>;
    } | null;
    try {
      manifest = JSON.parse(
        await readFile(new URL(relative, import.meta.url), "utf8"),
      );
    } catch {
      continue;
    }
    const range = manifest?.dependencies?.[runtimePackage];
    if (
      manifest?.name === "@dna113p/machines-dispatch" &&
      typeof range === "string" &&
      range.trim()
    )
      return range.trim();
  }
  throw new Error(
    `Machines Dispatch's package.json names no ${runtimePackage} range`,
  );
}
const described = (copy: InstalledCopy) =>
  `${copy.version}${copy.local ? " (a local build)" : ""}`;
function brief(cause: unknown): string {
  const text = errorMessage(cause).replace(/\s+/g, " ").trim();
  return text.length > 500 ? `${text.slice(0, 500)}...` : text;
}

/** Checks npm for a newer Machines runtime; when asked, installs it while idle. */
export class Updater {
  private readonly mode: UpdateMode;
  private readonly engine: Engine;
  private readonly run: CommandRunner;
  private readonly restart: (() => void) | null;
  private readonly installRoot: string | undefined;
  private readonly range: string | undefined;
  private readonly checkIntervalMs: number;
  private readonly log: (line: string) => void;
  private readonly closeDaemon: () => Promise<void>;
  private readonly stopped: () => boolean;
  private readonly note: string | undefined;
  private readonly aborter = new AbortController();
  private readonly said = new Map<string, string>();
  private state: UpdateStatus["state"];
  private root?: string;
  private installed?: InstalledCopy;
  /** The copy this process imported: the one on disk when it first looked. */
  private loaded?: InstalledCopy;
  private available?: string;
  private checkedAt?: string;
  private error?: string;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<void>;
  private installing = false;
  /** The version `update --install` asked for; it stands until that version loads. */
  private requested?: string;
  private closed = false;
  constructor(options: UpdaterOptions) {
    this.engine = options.engine;
    this.run = options.run ?? runCommand;
    this.installRoot = options.installRoot;
    this.range = options.range;
    this.checkIntervalMs = options.checkIntervalMs ?? 30 * 60_000;
    this.log = options.log ?? ((line) => console.error(line));
    this.closeDaemon = options.close;
    this.stopped = options.stopped;
    this.restart =
      options.mode === "off"
        ? null
        : options.restart === undefined
          ? processRestart()
          : options.restart;
    const unable = options.mode === "install" && !this.restart;
    this.mode = unable ? "check" : options.mode;
    this.note = unable
      ? `${withoutRestart}; "install" acts as "check"`
      : undefined;
    this.state = this.mode === "off" ? "off" : "checking";
  }
  start(): void {
    if (this.mode === "off" || this.closed || this.timer) return;
    this.engine.onPoll = () => {
      try {
        this.consider();
      } catch (cause) {
        this.fail("install", cause);
      }
    };
    const check = () =>
      void this.check().catch((cause) => this.fail("check", cause));
    this.timer = setInterval(check, this.checkIntervalMs);
    check();
  }
  status(): UpdateStatus {
    const { installed, loaded } = this;
    const note = [
      this.note,
      installed &&
      loaded &&
      (installed.version !== loaded.version || installed.local !== loaded.local)
        ? `${runtimePackage} ${described(installed)} is on disk, but this daemon still runs ${described(loaded)} until it restarts`
        : undefined,
    ]
      .filter(Boolean)
      .join("; ");
    return {
      package: runtimePackage,
      mode: this.mode,
      state: this.state,
      ...(this.installed
        ? { installed: this.installed.version, local: this.installed.local }
        : {}),
      ...(this.available === undefined ? {} : { available: this.available }),
      ...(this.checkedAt === undefined ? {} : { checkedAt: this.checkedAt }),
      ...(this.error === undefined ? {} : { error: this.error }),
      ...(note ? { note } : {}),
    };
  }
  /** Checks now. With `install`, the update found is installed once the engine is idle. */
  async check(install = false): Promise<UpdateStatus> {
    if (this.mode === "off") {
      if (install) throw new Error("Updates are off for this daemon");
      return this.status();
    }
    if (install && !this.restart) throw new Error(withoutRestart);
    if (!this.installing && !this.closed)
      await (this.checking ??= this.refresh().finally(() => {
        this.checking = undefined;
      }));
    if (install && (this.state === "available" || this.state === "waiting"))
      this.requested = this.available;
    this.consider();
    return this.status();
  }
  close(): void {
    this.closed = true;
    clearInterval(this.timer);
    this.aborter.abort();
  }
  private async refresh(): Promise<void> {
    try {
      const root = (this.root = this.installRoot ?? locateInstallRoot());
      const range = this.range ?? (await wantedRange());
      const installed = (this.installed = await readInstalled(root));
      const loaded = (this.loaded ??= installed);
      this.aborter.signal.throwIfAborted();
      const available = newestVersion(
        await this.run(
          "npm",
          ["view", `${runtimePackage}@${range}`, "version", "--json"],
          { cwd: root, timeoutMs: 20_000, signal: this.aborter.signal },
        ),
      );
      if (!available)
        throw new Error(
          `npm lists no stable ${runtimePackage} version matching ${range}`,
        );
      this.available = available;
      this.error = undefined;
      // A request covers the version it was made for, never a later release.
      if (this.requested !== available) this.requested = undefined;
      const published = (copy: InstalledCopy) =>
        copy.version === available && !copy.local;
      // The release on disk is not current until this process has loaded it.
      if (published(installed) && published(loaded)) {
        this.state = "current";
        this.requested = undefined;
        this.said.clear();
      } else {
        this.state = "available";
        this.said.delete("check failed");
        this.say(
          "available",
          published(installed)
            ? `${runtimePackage} ${available} is installed but not loaded (running: ${described(loaded)})`
            : `${runtimePackage} ${available} is available (installed: ${installed.version}${installed.local ? ", a local build" : ""})`,
        );
      }
    } catch (cause) {
      this.fail("check", cause);
    }
    this.checkedAt = new Date().toISOString();
  }
  /** Runs after every check and engine poll: an install soon follows the last attempt. */
  private consider(): void {
    if (this.closed || this.installing || this.checking) return;
    if (this.state !== "available" && this.state !== "waiting") return;
    if (this.mode !== "install" && this.requested !== this.available) return;
    // Admissions stay held from this idle observation until the restart.
    if (!this.engine.hold()) {
      this.state = "waiting";
      return;
    }
    this.installing = true;
    this.state = "installing";
    void this.install(this.root!, this.available!);
  }
  private async install(root: string, version: string): Promise<void> {
    this.say(
      "installing",
      `installing ${runtimePackage} ${version} in ${root}`,
    );
    try {
      await this.run(
        "npm",
        [
          "install",
          "--no-save",
          "--package-lock=false",
          "--no-audit",
          "--no-fund",
          `${runtimePackage}@${version}`,
        ],
        { cwd: root, timeoutMs: 10 * 60_000 },
      );
      const copy = (this.installed = await readInstalled(root));
      if (copy.version !== version || copy.local)
        throw new Error(
          `npm install left ${runtimePackage} ${described(copy)}, not ${version} from a registry`,
        );
    } catch (cause) {
      // Work continues on the copy that is loaded; a later check tries again.
      this.installed = await readInstalled(root).catch(() => this.installed);
      this.installing = false;
      this.engine.release();
      this.fail("install", cause);
      return;
    }
    if (this.stopped()) return;
    this.say("restarting", `restarting to load ${runtimePackage} ${version}`);
    try {
      await this.closeDaemon();
    } catch (cause) {
      this.log(
        `machines-dispatch: close before restart failed: ${brief(cause)}`,
      );
    }
    if (this.stopped()) return;
    try {
      this.restart!();
    } catch (cause) {
      this.log(`machines-dispatch: restart failed: ${brief(cause)}`);
    }
  }
  private fail(step: "check" | "install", cause: unknown): void {
    if (this.closed) return;
    this.state = "failed";
    this.error = brief(cause);
    this.say(
      `${step} failed`,
      `${runtimePackage} ${step} failed: ${this.error}`,
    );
  }
  /** One line per event: a repeat of the last line of its kind stays silent. */
  private say(kind: string, line: string): void {
    if (this.said.get(kind) === line) return;
    this.said.set(kind, line);
    this.log(`machines-dispatch: ${line}`);
  }
}
