import { listMachines } from "@dna113p/machines/launcher";
import { startMachineHost, type MachineHostRun } from "@dna113p/machines/host";
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
    this.poll();
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
    this.onPoll?.();
  }
  /** Nothing is running, waiting for a Human, being admitted, or being written back. */
  idle(): boolean {
    return (
      !this.closed &&
      !this.admitting &&
      !this.delivering.size &&
      !this.controllers.size &&
      !this.store
        .list()
        .some((a) => active(a.status) || a.delivery === "pending")
    );
  }
  /** When idle, refuses new admissions until `release`. Returns whether it did. */
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
    if (this.closed || (!retry && this.store.latest(source.id, item.key)))
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
  private async execute(
    attempt: Attempt,
    controller: AbortController,
  ): Promise<void> {
    try {
      const host = await startMachineHost({
        ...attempt.launch,
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
      this.hosts.set(attempt.id, host);
      if (this.store.get(attempt.id).status === "starting")
        this.store.update(attempt.id, { status: "running" });
      const result = await host.result;
      if (active(this.store.get(attempt.id).status))
        this.store.update(attempt.id, {
          status: "completed",
          result,
          human: undefined,
          delivery: "pending",
        });
    } catch (cause) {
      if (active(this.store.get(attempt.id).status))
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
      error: "Cancelled by operator",
      delivery: "pending",
    });
    this.controllers.get(id)?.abort();
  }
  async retry(id: string): Promise<Attempt> {
    const previous = this.store.get(id);
    if (
      active(previous.status) ||
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
      if (active(this.store.get(id).status))
        this.store.update(id, {
          status: "interrupted",
          human: undefined,
          error: "Daemon stopped",
          delivery: "pending",
        });
      controller.abort();
    }
    while (this.jobs.size) await Promise.allSettled([...this.jobs]);
  }
}
