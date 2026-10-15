import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { listMachines } from "@dna113p/machines/launcher";
import { startMachineHost, type MachineHostRun } from "@dna113p/machines/host";
import {
  readRunStatuses,
  runStatusDirectory,
  type RunStatusRecord,
} from "@dna113p/machines/run-status";
import {
  active,
  ReportConflict,
  type Attempt,
  type WorkItem,
  type WorkSource,
} from "./contracts.ts";
import { Store } from "./store.ts";
import { errorMessage } from "./validation.ts";

export interface SourceStatus {
  id: string;
  checkedAt?: string;
  issues: string[];
}
export class Engine {
  readonly store: Store;
  private readonly sources: Map<string, WorkSource>;
  private readonly statuses = new Map<string, SourceStatus>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly hosts = new Map<string, MachineHostRun>();
  private readonly jobs = new Set<Promise<void>>();
  private readonly scanning = new Set<string>();
  private readonly delivering = new Set<string>();
  private readonly nextDelivery = new Map<string, number>();
  private readonly nextWake = new Map<string, number>();
  private timer?: NodeJS.Timeout;
  private closed = false;
  private admitting = 0;
  private held = false;
  /** Called at the end of every poll. */
  onPoll?: () => void;
  private readonly intervalMs: number;
  constructor(
    store: Store,
    sources: readonly WorkSource[],
    intervalMs = 5_000,
  ) {
    this.intervalMs = intervalMs;
    this.store = store;
    this.sources = new Map();
    for (const source of sources) {
      if (!source.id.trim() || this.sources.has(source.id))
        throw new Error(`Invalid or duplicate source ID ${source.id}`);
      this.sources.set(source.id, source);
      this.statuses.set(source.id, { id: source.id, issues: [] });
    }
    store.recover();
  }
  start(): void {
    if (this.closed || this.timer)
      throw new Error("Engine already started or closed");
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.continueCutOff();
    this.poll();
  }
  private continueCutOff(): void {
    const directory = runStatusDirectory();
    const records = new Map(
      (directory === undefined ? [] : readRunStatuses(directory)).map(
        (record) => [record.id, record],
      ),
    );
    for (const attempt of this.store.list()) {
      if (!attempt.cutOff) continue;
      const record = attempt.runId ? records.get(attempt.runId) : undefined;
      if (
        !attempt.continued &&
        record &&
        record.status !== "sleeping" &&
        record.status !== "completed"
      ) {
        // Persist the claim before starting: another stop must not continue it twice.
        const next = this.store.update(attempt.id, {
          status: "running",
          cutOff: undefined,
          continued: 1,
          error: undefined,
        });
        this.store.event(attempt.id, { type: "continued", runId: record.id });
        const controller = new AbortController();
        this.controllers.set(attempt.id, controller);
        this.track(
          this.execute(next, controller, { id: record.id, mode: "continue" }),
        );
      } else {
        this.store.update(attempt.id, {
          cutOff: undefined,
          delivery: "pending",
          error: attempt.continued
            ? "Cut off again after one automatic continuation; not continued again. Inspect effects before retrying."
            : attempt.error,
        });
      }
    }
  }
  private track(job: Promise<void>): void {
    this.jobs.add(job);
    void job
      .catch((cause) => process.emitWarning(errorMessage(cause)))
      .finally(() => this.jobs.delete(job));
  }
  poll(): void {
    if (this.closed) return;
    for (const source of this.sources.values()) {
      if (this.scanning.has(source.id)) continue;
      this.scanning.add(source.id);
      this.track(
        this.scan(source).finally(() => this.scanning.delete(source.id)),
      );
    }
    for (const attempt of this.store.list()) {
      if (
        attempt.delivery !== "pending" ||
        this.delivering.has(attempt.id) ||
        (this.nextDelivery.get(attempt.id) ?? 0) > Date.now()
      )
        continue;
      this.delivering.add(attempt.id);
      this.track(
        this.deliver(attempt).finally(() => this.delivering.delete(attempt.id)),
      );
    }
    this.wake();
    this.onPoll?.();
  }
  private wake(): void {
    if (this.held) return;
    const directory = runStatusDirectory();
    if (directory === undefined) return;
    const records = new Map(
      readRunStatuses(directory).map((record) => [record.id, record]),
    );
    const now = Date.now();
    for (const attempt of this.store.list()) {
      if (
        attempt.status !== "sleeping" ||
        !attempt.runId ||
        this.controllers.has(attempt.id)
      )
        continue;
      const record = records.get(attempt.runId);
      if (this.reconcile(attempt, record, directory)) continue;
      if ((this.nextWake.get(attempt.id) ?? 0) > now) continue;
      if (
        record?.status !== "sleeping" ||
        record.continuedBy !== "host" ||
        !(
          record.human?.answer !== undefined ||
          (record.due !== undefined && Date.parse(record.due) <= now)
        )
      )
        continue;
      const controller = new AbortController();
      this.controllers.set(attempt.id, controller);
      this.track(
        this.execute(attempt, controller, { id: attempt.runId, mode: "wake" }),
      );
    }
  }
  private reconcile(
    attempt: Attempt,
    record: RunStatusRecord | undefined,
    directory: string,
  ): boolean {
    if (record?.status === "completed" || record?.status === "failed") {
      this.store.update(attempt.id, {
        status: "continued-outside",
        state: record.state as Attempt["state"],
        note: record.note,
        error: record.error,
        sleeping: undefined,
        wakeError: undefined,
      });
      this.store.event(attempt.id, {
        type: "continued-outside",
        runId: attempt.runId,
        status: record.status,
      });
      return true;
    }
    if (record || !this.missingRunRecord(attempt, directory)) return false;
    this.store.update(attempt.id, {
      status: "continued-outside",
      note: "run record not found",
      sleeping: undefined,
      wakeError: undefined,
    });
    this.store.event(attempt.id, {
      type: "continued-outside",
      runId: attempt.runId,
      note: "run record not found",
    });
    return true;
  }
  private missingRunRecord(attempt: Attempt, directory: string): boolean {
    if (!attempt.runId || attempt.runStatusDir !== directory) return false;
    try {
      statSync(join(directory, `${attempt.runId}.json`));
      return false;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    try {
      // A failed listing must not make a record appear missing.
      accessSync(directory, constants.R_OK | constants.X_OK);
      return statSync(directory).isDirectory();
    } catch {
      return false;
    }
  }
  /** Nothing is running, waiting, being admitted, recovered, or written back. */
  idle(): boolean {
    return (
      !this.closed &&
      !this.admitting &&
      !this.delivering.size &&
      !this.controllers.size &&
      !this.store
        .list()
        .some(
          (a) =>
            (active(a.status) && a.status !== "sleeping") ||
            a.cutOff ||
            a.delivery === "pending",
        )
    );
  }
  /** When idle, refuses admissions and wakes until `release`. Returns whether it did. */
  hold(): boolean {
    if (!this.idle()) return false;
    this.held = true;
    return true;
  }
  release(): void {
    this.held = false;
  }
  sourcesStatus(): SourceStatus[] {
    return structuredClone([...this.statuses.values()]);
  }
  private async scan(source: WorkSource): Promise<void> {
    const issues: string[] = [];
    try {
      const scan = await source.scan();
      issues.push(...(scan.issues ?? []));
      await Promise.all(
        scan.items.map(async (item) => {
          try {
            await this.admit(source, item);
          } catch (cause) {
            issues.push(`${item.label}: ${errorMessage(cause)}`);
          }
        }),
      );
    } catch (cause) {
      issues.push(errorMessage(cause));
    }
    this.statuses.set(source.id, {
      id: source.id,
      checkedAt: new Date().toISOString(),
      issues,
    });
  }
  private async admit(
    source: WorkSource,
    item: WorkItem,
    retry = false,
  ): Promise<Attempt | undefined> {
    if (this.held) return;
    // A hold is granted only while no admission is on its way to an attempt.
    this.admitting++;
    try {
      return await this.launch(source, item, retry);
    } finally {
      this.admitting--;
    }
  }
  private async launch(
    source: WorkSource,
    item: WorkItem,
    retry: boolean,
  ): Promise<Attempt | undefined> {
    if (this.closed || (!retry && this.store.attempted(source.id, item.key)))
      return;
    // A routed request must not overlap an older attempt or its pending writeback.
    if (
      this.store
        .list()
        .some(
          (a) =>
            a.source === source.id &&
            a.item.label === item.label &&
            (active(a.status) || a.delivery === "pending"),
        )
    )
      return;
    const launch = await source.prepare(item);
    if (!launch || this.closed) return;
    const catalog = await listMachines({ cwd: launch.cwd, home: launch.home });
    const found = catalog.find((entry) => entry.name === launch.machine);
    if (!found)
      throw new Error(
        `Machine ${JSON.stringify(launch.machine)} is not in the discovered catalog`,
      );
    if (found.error) throw new Error(found.error);
    // Recheck after discovery: source content/blockers may have changed while importing definitions.
    const fresh = await source.prepare(item);
    if (!fresh || this.closed) return;
    if (JSON.stringify(fresh) !== JSON.stringify(launch))
      throw new Error("Launch request changed during validation");
    const attempt = this.store.create(
      source.id,
      item,
      { ...launch, machine: found.path },
      retry,
    );
    if (!attempt) return;
    const controller = new AbortController();
    this.controllers.set(attempt.id, controller);
    this.track(this.execute(attempt, controller));
    return attempt;
  }
  private sleepable(): string | undefined {
    const directory = runStatusDirectory();
    if (directory === undefined) return "run status publication is off";
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      accessSync(directory, constants.W_OK);
      return undefined;
    } catch (cause) {
      return `the run-status directory cannot be written: ${errorMessage(cause)}`;
    }
  }
  private async execute(
    attempt: Attempt,
    controller: AbortController,
    run?: { id: string; mode: "wake" | "continue" },
  ): Promise<void> {
    let started = false;
    try {
      const cannotSleep = run === undefined ? this.sleepable() : undefined;
      if (run === undefined) this.store.update(attempt.id, { cannotSleep });
      const host = await startMachineHost({
        ...(run === undefined
          ? { ...attempt.launch, sleep: cannotSleep === undefined }
          : { continue: run.id, sleep: true }),
        // Where run status is published, each attempt's run is too, and says what it is for.
        publishRunStatus: true,
        label: attempt.launch.label ?? attempt.item.label,
        signal: controller.signal,
        onState: (state) => {
          if (!active(this.store.get(attempt.id).status)) return;
          this.store.update(attempt.id, { state });
          this.store.event(attempt.id, { type: "state", state });
        },
        onAgentUpdate: (update) => this.store.event(attempt.id, update),
        onHumanRequest: (human) => {
          if (!active(this.store.get(attempt.id).status)) return;
          this.store.update(attempt.id, { status: "waiting", human });
          this.store.event(attempt.id, { type: "human", human });
        },
      });
      started = true;
      this.hosts.set(attempt.id, host);
      this.store.update(attempt.id, {
        runId: host.id,
        sleeping: undefined,
        wakeError: undefined,
      });
      const status = this.store.get(attempt.id).status;
      if (status === "starting" || (run?.mode === "wake" && status === "sleeping"))
        this.store.update(attempt.id, { status: "running" });
      if (run?.mode === "wake") {
        this.nextWake.delete(attempt.id);
        this.store.event(attempt.id, { type: "woken", runId: host.id });
      }
      const result = await host.result;
      if (active(this.store.get(attempt.id).status)) {
        if (result.sleeping) {
          this.store.update(attempt.id, {
            status: "sleeping",
            runStatusDir: runStatusDirectory(),
            state: result.state,
            sleeping: result.sleeping,
            human: undefined,
          });
          this.store.event(attempt.id, {
            type: "sleeping",
            sleeping: result.sleeping,
          });
        } else {
          this.store.update(attempt.id, {
            status: "completed",
            result,
            human: undefined,
            delivery: "pending",
          });
        }
      }
    } catch (cause) {
      const current = this.store.get(attempt.id);
      if (run?.mode === "wake" && !started) {
        this.nextWake.set(attempt.id, Date.now() + this.intervalMs);
        if (current.status === "sleeping" && !this.closed) {
          const wakeError = errorMessage(cause);
          this.store.update(attempt.id, { wakeError });
          if (current.wakeError !== wakeError)
            this.store.event(attempt.id, { type: "wake-failed", error: wakeError });
        }
      } else if (run?.mode === "continue" && !started && active(current.status)) {
        this.store.update(attempt.id, {
          status: "interrupted",
          error: `Could not continue after a restart: ${errorMessage(cause)}`,
          human: undefined,
          delivery: "pending",
        });
      } else if (active(current.status))
        this.store.update(attempt.id, {
          status: "failed",
          error: errorMessage(cause),
          human: undefined,
          delivery: "pending",
        });
    } finally {
      this.hosts.delete(attempt.id);
      this.controllers.delete(attempt.id);
      this.poll();
    }
  }
  private async deliver(attempt: Attempt): Promise<void> {
    try {
      const source = this.sources.get(attempt.source);
      if (!source)
        throw new Error(`Source ${attempt.source} is not registered`);
      if (active(attempt.status)) return;
      await source.apply({
        attemptId: attempt.id,
        item: attempt.item,
        status: attempt.status as
          | "completed"
          | "failed"
          | "cancelled"
          | "interrupted",
        ...(attempt.result === undefined ? {} : { result: attempt.result }),
        ...(attempt.error === undefined ? {} : { error: attempt.error }),
      });
      this.store.update(attempt.id, {
        delivery: "applied",
        deliveryError: undefined,
      });
      this.nextDelivery.delete(attempt.id);
    } catch (cause) {
      this.store.update(attempt.id, {
        delivery: cause instanceof ReportConflict ? "conflict" : "pending",
        deliveryError: errorMessage(cause),
      });
      this.nextDelivery.set(attempt.id, Date.now() + this.intervalMs);
    }
  }
  async respond(
    id: string,
    requestId: string,
    response: string,
  ): Promise<void> {
    const attempt = this.store.get(id);
    if (attempt.status === "sleeping") {
      if (attempt.sleeping && "human" in attempt.sleeping)
        throw new Error(
          `Attempt ${id} is sleeping; answer it with: machine respond ${attempt.runId} ${attempt.sleeping.human.requestId}`,
        );
      const due =
        attempt.sleeping && "due" in attempt.sleeping
          ? attempt.sleeping.due
          : "its timed wait is due";
      throw new Error(
        `Attempt ${id} is sleeping until ${due} and takes no response`,
      );
    }
    const host = this.hosts.get(id);
    if (
      attempt.status !== "waiting" ||
      !host ||
      attempt.human?.requestId !== requestId
    )
      throw new Error("Human request is stale or not waiting");
    if (attempt.human.choices && !attempt.human.choices.includes(response))
      throw new Error("Response is not an allowed choice");
    this.store.update(id, { status: "running", human: undefined });
    await host.respond(response, requestId);
    this.store.event(id, { type: "response", requestId, response });
  }
  cancel(id: string): void {
    if (!active(this.store.get(id).status))
      throw new Error("Attempt is not active");
    this.store.update(id, {
      status: "cancelled",
      human: undefined,
      sleeping: undefined,
      error: "Cancelled by operator",
      delivery: "pending",
    });
    this.controllers.get(id)?.abort();
  }
  async retry(id: string): Promise<Attempt> {
    const previous = this.store.get(id);
    if (
      active(previous.status) ||
      previous.cutOff ||
      this.controllers.has(id) ||
      previous.delivery === "pending"
    )
      throw new Error("Wait for the prior attempt and its writeback to finish");
    const source = this.sources.get(previous.source);
    if (!source) throw new Error("Source is not registered");
    const scan = await source.scan();
    const item = scan.items.find((item) => item.label === previous.item.label);
    if (!item)
      throw new Error(
        "Ticket is no longer eligible; inspect its status and blockers",
      );
    const attempt = await this.admit(source, item, true);
    if (!attempt)
      throw new Error(
        this.held
          ? "The daemon is installing an update; retry after it restarts"
          : "Ticket changed or already has active work",
      );
    return attempt;
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.timer);
    for (const [id, controller] of this.controllers) {
      const { status, runId } = this.store.get(id);
      // A wake that has not started still has its sleeping checkpoint.
      if (active(status) && status !== "sleeping")
        this.store.update(id, {
          status: "interrupted",
          human: undefined,
          error: "Daemon stopped",
          delivery: runId ? "none" : "pending",
          cutOff: runId ? true : undefined,
        });
      controller.abort();
    }
    while (this.jobs.size) await Promise.allSettled(this.jobs);
  }
}
