import { randomUUID } from "node:crypto";
import { accessSync, constants, mkdirSync, statSync } from "node:fs";
import { hostname } from "node:os";
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
  ClaimLost,
  ReportConflict,
  type Attempt,
  type AttemptClaim,
  type ClaimStore,
  type Holder,
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
export interface EngineOptions {
  /** This computer's name in claims. Defaults to the host name. */
  host?: string;
  /** Shortest wait before asking again for a ticket another daemon holds. */
  claimBackoffMs?: number;
  /** Wait before asking again for a request another daemon finished. */
  finishedBackoffMs?: number;
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
  /** Attempts with a claim renewal, recovery or finish in flight. */
  private readonly tending = new Set<string>();
  /** Why an attempt from before claims were enabled could not take its claim yet. */
  private readonly adoptErrors = new Map<string, string>();
  /** Scopes held or finished elsewhere, not asked for again until `until`. */
  private readonly claimWaits = new Map<
    string,
    { until: number; issue: string; key?: string }
  >();
  private readonly claimBackoffMs: number;
  private readonly finishedBackoffMs: number;
  /** Names this daemon in claims. */
  readonly identity: { readonly daemon: string; readonly host: string };
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
    options: EngineOptions = {},
  ) {
    this.intervalMs = intervalMs;
    this.claimBackoffMs = options.claimBackoffMs ?? 30_000;
    this.finishedBackoffMs = options.finishedBackoffMs ?? 300_000;
    this.store = store;
    this.sources = new Map();
    for (const source of sources) {
      if (!source.id.trim() || this.sources.has(source.id))
        throw new Error(`Invalid or duplicate source ID ${source.id}`);
      this.sources.set(source.id, source);
      this.statuses.set(source.id, { id: source.id, issues: [] });
    }
    store.recover();
    this.identity = {
      daemon: store.daemonId(),
      host: options.host ?? hostname(),
    };
  }
  start(): void {
    if (this.closed || this.timer)
      throw new Error("Engine already started or closed");
    this.timer = setInterval(() => this.poll(), this.intervalMs);
    this.continueCutOff();
    this.poll();
  }
  private runRecords(): Map<string, RunStatusRecord> {
    const directory = runStatusDirectory();
    return new Map(
      (directory === undefined ? [] : readRunStatuses(directory)).map(
        (record) => [record.id, record],
      ),
    );
  }
  private continueCutOff(): void {
    const records = this.runRecords();
    // A claimed attempt continues only after renewing its claim, from `poll`;
    // one whose claim store is gone stays cut off.
    for (const attempt of this.store.list())
      if (
        attempt.cutOff &&
        !this.holdsClaim(attempt) &&
        !this.needsAdoption(attempt)
      )
        this.recoverCutOff(attempt, records);
  }
  private recoverCutOff(
    attempt: Attempt,
    records: Map<string, RunStatusRecord>,
  ): void {
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
    this.tendClaims();
    this.wake();
    this.onPoll?.();
  }
  /** Whether this attempt still holds a claim, whether or not its store is configured. */
  private holdsClaim(attempt: Attempt): boolean {
    const state = attempt.claim?.state;
    return state === "held" || state === "finishing";
  }
  /** The claim store still holding this attempt's claim, if it has one. */
  private claims(attempt: Attempt): ClaimStore | undefined {
    return this.holdsClaim(attempt)
      ? this.sources.get(attempt.source)?.claims
      : undefined;
  }
  /**
   * Why a claimed attempt cannot reach its claim store: its source was removed
   * or no longer has `claims`. Such an attempt stays stopped, since it cannot
   * confirm that another computer has not taken its ticket.
   */
  private claimUnavailable(attempt: Attempt): string | undefined {
    if (!this.holdsClaim(attempt) || this.claims(attempt)) return undefined;
    const source = JSON.stringify(attempt.source);
    return `claim store unavailable: source ${source} ${
      this.sources.has(attempt.source)
        ? "is no longer configured with claims"
        : "is no longer configured"
    }; attempt ${attempt.id} holds a claim, so it is not continued, woken or finished until claims are configured again`;
  }
  /**
   * An attempt from before its source had claims, still able to resume (cut
   * off or sleeping). It must take a claim first, or another computer could
   * run the same ticket.
   */
  private needsAdoption(attempt: Attempt): boolean {
    return (
      !attempt.claim &&
      (attempt.cutOff === true || attempt.status === "sleeping") &&
      !!this.sources.get(attempt.source)?.claims
    );
  }
  /** Claims a resumable attempt from before claims, or stops it if another computer has the ticket. */
  private async adopt(id: string, claims: ClaimStore): Promise<void> {
    const attempt = this.store.get(id);
    if (this.closed || !this.needsAdoption(attempt)) return;
    let acquisition;
    try {
      acquisition = await claims.acquire({
        scope: `${attempt.source}/${attempt.item.label}`,
        key: attempt.item.key,
        holder: { ...this.identity, attempt: id },
        retry: false,
      });
    } catch (cause) {
      // Fail closed: it stays stopped and is asked again on the next poll.
      this.adoptErrors.set(
        id,
        `claim check failed for attempt ${id} from before claims were enabled, not resumed: ${errorMessage(cause)}`,
      );
      return;
    }
    this.adoptErrors.delete(id);
    if (acquisition.acquired) {
      this.store.update(id, {
        claim: { lease: acquisition.lease, state: "held" },
      });
      this.store.event(id, { type: "claim-adopted" });
      const current = this.store.get(id);
      if (current.cutOff && !this.closed)
        this.recoverCutOff(current, this.runRecords());
      return;
    }
    const reason = acquisition.finished
      ? "Claims were enabled after this attempt started, and another computer already finished this request; not resumed"
      : `Claims were enabled after this attempt started, and ${
          acquisition.holder?.host ?? "another daemon"
        } holds this ticket; not resumed`;
    // A cut-off run is never continued and a sleeping one never woken.
    this.store.update(id, {
      status: "interrupted",
      error: reason,
      claimRefused: reason,
      human: undefined,
      sleeping: undefined,
      cutOff: undefined,
      delivery: "pending",
    });
    this.store.event(id, {
      type: "claim-refused",
      ...(acquisition.holder ? { holder: acquisition.holder } : {}),
      ...(acquisition.finished ? { finished: true } : {}),
    });
    this.controllers.get(id)?.abort();
  }
  /** Ran and written back (or never will be): its key is consumed. */
  private settled(attempt: Attempt): boolean {
    return (
      !active(attempt.status) && !attempt.cutOff && attempt.delivery !== "pending"
    );
  }
  private tendClaims(): void {
    const now = Date.now();
    for (const attempt of this.store.list()) {
      const unavailable = this.claimUnavailable(attempt);
      if (unavailable) this.changeClaim(attempt.id, { error: unavailable });
      if (this.needsAdoption(attempt) && !this.tending.has(attempt.id)) {
        const store = this.sources.get(attempt.source)!.claims!;
        this.tending.add(attempt.id);
        this.track(
          this.adopt(attempt.id, store).finally(() =>
            this.tending.delete(attempt.id),
          ),
        );
        continue;
      }
      const claims = this.claims(attempt);
      if (!claims || this.tending.has(attempt.id)) continue;
      const { lease } = attempt.claim!;
      const due = Date.parse(lease.expiresAt) - now < lease.ttlMs / 2;
      const recover = attempt.cutOff === true;
      const settle = this.settled(attempt);
      if (!due && !recover && !settle) continue;
      this.tending.add(attempt.id);
      this.track(
        this.tend(attempt.id, claims, { due, recover, settle }).finally(() =>
          this.tending.delete(attempt.id),
        ),
      );
    }
  }
  private async tend(
    id: string,
    claims: ClaimStore,
    work: { due: boolean; recover: boolean; settle: boolean },
  ): Promise<void> {
    if (this.closed) return;
    if (work.recover) {
      // A cut-off run continues only while this daemon still holds its ticket.
      if (!(await this.confirm(id, claims)) || this.closed) return;
      const attempt = this.store.get(id);
      if (attempt.cutOff) this.recoverCutOff(attempt, this.runRecords());
      return;
    }
    if (work.due && !(await this.confirm(id, claims))) return;
    if (!work.settle || this.store.get(id).claim?.state === "lost") return;
    this.changeClaim(id, { state: "finishing" });
    try {
      await claims.finish(this.store.get(id).claim!.lease);
      this.changeClaim(id, { state: "done", error: undefined });
      this.store.event(id, { type: "claim-finished" });
    } catch (cause) {
      if (cause instanceof ClaimLost) this.lose(id, cause.holder);
      else this.changeClaim(id, { error: errorMessage(cause) });
    }
  }
  /** Renews now. Whether this daemon still holds the claim; errors leave it held. */
  private async confirm(id: string, claims: ClaimStore): Promise<boolean> {
    const lease = this.store.get(id).claim?.lease;
    if (!lease) return false;
    let renewal;
    try {
      renewal = await claims.renew(lease);
    } catch (cause) {
      this.changeClaim(id, { error: errorMessage(cause) });
      return false;
    }
    if (!renewal.ok) {
      this.lose(id, renewal.holder);
      return false;
    }
    this.changeClaim(id, { lease: renewal.lease, error: undefined });
    return true;
  }
  /** Updates a claim this daemon still holds. */
  private changeClaim(id: string, change: Partial<AttemptClaim>): void {
    const claim = this.store.get(id).claim;
    if (!claim || claim.state === "lost" || claim.state === "done") return;
    const next = { ...claim, ...change };
    if (JSON.stringify(next) !== JSON.stringify(claim))
      this.store.update(id, { claim: next });
  }
  /** Another daemon has the ticket: stop this attempt and never finish its claim. */
  private lose(id: string, holder?: Holder): void {
    const attempt = this.store.get(id);
    const claim = attempt.claim;
    if (!claim || claim.state === "lost" || claim.state === "done") return;
    const reason = new ClaimLost(holder).message;
    // A cut-off run is never continued and a sleeping one never woken.
    const stops = active(attempt.status) || attempt.cutOff === true;
    const { error: _error, ...kept } = claim;
    this.store.update(id, {
      claim: {
        ...kept,
        state: "lost",
        ...(holder ? { lostTo: holder } : {}),
        ...(stops ? { reason } : {}),
      },
      ...(stops
        ? {
            status: "interrupted" as const,
            error: reason,
            human: undefined,
            sleeping: undefined,
            cutOff: undefined,
            delivery: "pending" as const,
          }
        : {}),
    });
    this.store.event(id, { type: "claim-lost", ...(holder ? { holder } : {}) });
    if (stops) this.controllers.get(id)?.abort();
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
      // An attempt from before claims wakes only after taking its claim.
      if (this.tending.has(attempt.id) || this.needsAdoption(attempt)) continue;
      const claims = this.claims(attempt);
      // Without its claim store, a claimed run cannot confirm it still holds the ticket.
      if (!claims && this.holdsClaim(attempt)) continue;
      const controller = new AbortController();
      this.controllers.set(attempt.id, controller);
      const run = { id: attempt.runId, mode: "wake" } as const;
      if (!claims) {
        this.track(this.execute(attempt, controller, run));
        continue;
      }
      // A sleeping run wakes only while this daemon still holds its ticket.
      this.tending.add(attempt.id);
      this.track(
        (async () => {
          let confirmed = false;
          try {
            confirmed = await this.confirm(attempt.id, claims);
          } finally {
            this.tending.delete(attempt.id);
          }
          if (
            confirmed &&
            !controller.signal.aborted &&
            !this.closed &&
            this.store.get(attempt.id).status === "sleeping"
          )
            return this.execute(attempt, controller, run);
          this.controllers.delete(attempt.id);
          if (!confirmed)
            this.nextWake.set(attempt.id, Date.now() + this.intervalMs);
        })(),
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
    for (const attempt of this.store.list()) {
      const unavailable =
        attempt.source === source.id ? this.claimUnavailable(attempt) : undefined;
      if (unavailable) issues.push(`${attempt.item.label}: ${unavailable}`);
      const adoption =
        attempt.source === source.id ? this.adoptErrors.get(attempt.id) : undefined;
      if (adoption) issues.push(`${attempt.item.label}: ${adoption}`);
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
    // A routed request must not overlap an older attempt or its pending
    // writeback, nor an older claim not yet finished.
    if (
      this.store
        .list()
        .some(
          (a) =>
            a.source === source.id &&
            a.item.label === item.label &&
            (active(a.status) ||
              a.delivery === "pending" ||
              this.holdsClaim(a)),
        )
    )
      return;
    const scope = `${source.id}/${item.label}`;
    const wait = source.claims && !retry ? this.claimWaits.get(scope) : undefined;
    if (
      wait &&
      wait.until > Date.now() &&
      (wait.key === undefined || wait.key === item.key)
    )
      throw new Error(wait.issue);
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
    const claimed = source.claims
      ? await this.acquire(source.claims, scope, item, retry)
      : undefined;
    const attempt = this.closed
      ? undefined
      : this.store.create(
          source.id,
          item,
          { ...launch, machine: found.path },
          retry,
          claimed,
        );
    if (!attempt) {
      if (claimed)
        await source.claims!.abandon(claimed.claim.lease).catch((cause) =>
          process.emitWarning(`Could not release claim ${scope}: ${errorMessage(cause)}`),
        );
      return;
    }
    const controller = new AbortController();
    this.controllers.set(attempt.id, controller);
    this.track(this.execute(attempt, controller));
    return attempt;
  }
  /** Claims the ticket for a new attempt, or throws the reason it is not launched. */
  private async acquire(
    claims: ClaimStore,
    scope: string,
    item: WorkItem,
    retry: boolean,
  ): Promise<{ id: string; claim: AttemptClaim }> {
    const id = randomUUID();
    let acquisition;
    try {
      acquisition = await claims.acquire({
        scope,
        key: item.key,
        holder: { ...this.identity, attempt: id },
        retry,
      });
    } catch (cause) {
      // Fail closed: without an answer, another computer may hold the ticket.
      throw new Error(`claim check failed, not launched: ${errorMessage(cause)}`);
    }
    if (acquisition.acquired) {
      this.claimWaits.delete(scope);
      return { id, claim: { lease: acquisition.lease, state: "held" } };
    }
    const now = Date.now();
    const issue = acquisition.finished
      ? "already finished on another computer"
      : `claimed by ${acquisition.holder?.host ?? "another daemon"}${
          acquisition.expiresAt ? ` until ${acquisition.expiresAt}` : ""
        }`;
    this.claimWaits.set(
      scope,
      acquisition.finished
        ? { until: now + this.finishedBackoffMs, issue, key: item.key }
        : {
            until: Math.max(
              Date.parse(acquisition.expiresAt ?? "") || 0,
              now + this.claimBackoffMs,
            ),
            issue,
          },
    );
    throw new Error(issue);
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
        ...(attempt.claim?.reason || attempt.claimRefused
          ? { reason: attempt.claim?.reason ?? attempt.claimRefused }
          : {}),
      });
      this.store.update(attempt.id, {
        delivery: "applied",
        deliveryError: undefined,
      });
      this.nextDelivery.delete(attempt.id);
      // Record the consumed key promptly rather than on the next poll.
      this.tendClaims();
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
