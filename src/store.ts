import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import type { Attempt, LaunchRequest, WorkItem } from "./contracts.ts";
import { active } from "./contracts.ts";

/** This database records executions; it is never the ticket source of truth. */
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, source TEXT NOT NULL, work_key TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS attempts_work ON attempts(source, work_key);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY, attempt TEXT NOT NULL, time TEXT NOT NULL, data TEXT NOT NULL);`);
  }
  list(): Attempt[] {
    return this.db
      .prepare("SELECT data FROM attempts ORDER BY rowid DESC")
      .all()
      .map((row) => JSON.parse(String(row.data)) as Attempt);
  }
  get(id: string): Attempt {
    const row = this.db
      .prepare("SELECT data FROM attempts WHERE id = ?")
      .get(id);
    if (!row) throw new Error(`Unknown attempt ${id}`);
    return JSON.parse(String(row.data)) as Attempt;
  }
  latest(source: string, key: string): Attempt | undefined {
    const row = this.db
      .prepare(
        "SELECT data FROM attempts WHERE source = ? AND work_key = ? ORDER BY rowid DESC LIMIT 1",
      )
      .get(source, key);
    return row ? (JSON.parse(String(row.data)) as Attempt) : undefined;
  }
  attempted(source: string, key: string): boolean {
    return !!this.latest(source, key) || this.list().some(
      (attempt) => attempt.source === source && attempt.item.supersedes?.includes(key),
    );
  }
  create(
    source: string,
    item: WorkItem,
    launch: LaunchRequest,
    retry = false,
  ): Attempt | undefined {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!retry && this.attempted(source, item.key)) return undefined;
      if (
        this.list().some(
          (attempt) =>
            attempt.source === source &&
            attempt.item.label === item.label &&
            (active(attempt.status) || attempt.delivery === "pending"),
        )
      )
        return undefined;
      const previous = this.latest(source, item.key);
      if (
        previous &&
        (!retry || active(previous.status) || previous.delivery === "pending")
      )
        return undefined;
      const now = new Date().toISOString();
      const attempt: Attempt = {
        id: randomUUID(),
        source,
        item,
        launch,
        status: "starting",
        startedAt: now,
        updatedAt: now,
        delivery: "none",
      };
      this.db
        .prepare("INSERT INTO attempts VALUES (?, ?, ?, ?)")
        .run(attempt.id, source, item.key, JSON.stringify(attempt));
      return attempt;
    } finally {
      this.db.exec("COMMIT");
    }
  }
  update(id: string, change: Partial<Attempt>): Attempt {
    const next = {
      ...this.get(id),
      ...change,
      updatedAt: new Date().toISOString(),
    };
    this.db
      .prepare("UPDATE attempts SET data = ? WHERE id = ?")
      .run(JSON.stringify(next), id);
    return next;
  }
  event(id: string, data: unknown): void {
    this.db
      .prepare("INSERT INTO events(attempt,time,data) VALUES (?,?,?)")
      .run(id, new Date().toISOString(), JSON.stringify(data));
  }
  events(id: string): unknown[] {
    this.get(id);
    return this.db
      .prepare(
        "SELECT seq,time,data FROM events WHERE attempt = ? ORDER BY seq",
      )
      .all(id)
      .map((row) => ({
        sequence: row.seq,
        time: row.time,
        event: JSON.parse(String(row.data)),
      }));
  }
  recover(): void {
    for (const attempt of this.list())
      if (active(attempt.status) && attempt.status !== "sleeping")
        this.update(attempt.id, {
          status: "interrupted",
          human: undefined,
          delivery: attempt.runId ? "none" : "pending",
          cutOff: attempt.runId ? true : undefined,
          error:
            "Daemon stopped before the attempt finished; inspect effects before retrying.",
        });
  }
  close(): void {
    this.db.close();
  }
}
