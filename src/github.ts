import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { promisify } from "node:util";
import * as v from "valibot";
import {
  ReportConflict,
  type JsonValue,
  type WorkItem,
  type WorkReport,
  type WorkSource,
} from "./contracts.ts";
import { jsonValue, nonempty, stringMap } from "./validation.ts";

export interface GitHubOptions {
  id: string;
  cwd: string;
  repository: string;
  requiredLabels: readonly string[];
  excludedLabels?: readonly string[];
  defaultMachine: string;
  input?: JsonValue;
  agents?: Readonly<Record<string, string>>;
  home?: string;
  /** Override transport for deterministic tests; requests still target api.github.com. */
  fetch?: typeof fetch;
  /** Prefer environment or gh authentication in normal configurations. */
  token?: string;
}
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const issueSchema = v.object({
  node_id: nonempty,
  number: positiveInteger,
  url: nonempty,
  repository_url: nonempty,
  html_url: nonempty,
  title: v.string(),
  body: v.nullable(v.string()),
  state: v.picklist(["open", "closed"]),
  state_reason: v.optional(v.nullable(v.string())),
  labels: v.array(v.union([v.string(), v.object({ name: v.string() })])),
  pull_request: v.optional(v.unknown()),
});
type Issue = v.InferOutput<typeof issueSchema>;
const reference = v.strictObject({
  repository: nonempty,
  number: positiveInteger,
  nodeId: nonempty,
  openStateReason: v.nullable(v.string()),
  fingerprint: nonempty,
});
const outcomeSchema = v.variant("action", [
  v.strictObject({ action: v.literal("complete"), summary: v.string() }),
  v.strictObject({ action: v.literal("hold"), summary: v.string() }),
]);
const api = "https://api.github.com";
const execute = promisify(execFile);

/** GitHub owns eligibility and ticket state; the configured Machine owns the work. */
export function github(options: GitHubOptions): WorkSource {
  v.parse(nonempty, options.id);
  v.parse(nonempty, options.defaultMachine);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options.repository))
    throw new Error("GitHub repository must be owner/repo");
  const repository = options.repository.toLowerCase();
  const required = v.parse(
    v.pipe(v.array(nonempty), v.minLength(1)),
    options.requiredLabels,
  );
  const excluded = v.parse(v.array(nonempty), options.excludedLabels ?? []);
  if (required.some((label) => excluded.includes(label)))
    throw new Error("A GitHub label cannot be both required and excluded");
  const input = v.parse(jsonValue, options.input ?? null);
  const agents =
    options.agents === undefined
      ? undefined
      : v.parse(stringMap, options.agents);
  const cwd = resolve(options.cwd);
  const home =
    options.home === undefined ? undefined : resolve(cwd, options.home);
  const transport = options.fetch ?? globalThis.fetch;
  const base = `/repos/${repository}/issues`;
  let token: Promise<string> | undefined;
  let blockedUntil = 0;
  let rateFailures = 0;
  let writes: Promise<void> = Promise.resolve();

  async function authenticate(): Promise<string> {
    const configured =
      options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (configured) return configured;
    try {
      const { stdout } = await execute(
        "gh",
        ["auth", "token", "--hostname", "github.com"],
        {
          cwd,
          timeout: 10_000,
          maxBuffer: 64 * 1024,
        },
      );
      if (stdout.trim()) return stdout.trim();
    } catch {
      /* Do not expose command output or credentials in daemon diagnostics. */
    }
    throw new Error(
      "GitHub authentication unavailable; set GH_TOKEN/GITHUB_TOKEN or sign in with gh auth login",
    );
  }
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<Response> {
    if (Date.now() < blockedUntil)
      throw new Error(
        `GitHub requests paused until ${new Date(blockedUntil).toISOString()} after rate limiting`,
      );
    token ??= authenticate().catch((cause: unknown) => {
      token = undefined;
      throw cause;
    });
    const credential = await token;
    let response: Response;
    try {
      response = await transport(`${api}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(20_000),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${credential}`,
          "x-github-api-version": "2026-03-10",
          "user-agent": "machines-dispatch",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        "GitHub request failed or timed out; delivery will be retried",
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new ReportConflict(
        "GitHub redirects are unsupported; check for repository renames or issue transfers",
      );
    if (response.status === 403 || response.status === 429) {
      const retry = response.headers.get("retry-after");
      const reset = response.headers.get("x-ratelimit-reset");
      const now = Date.now();
      const retryAt =
        retry === null
          ? 0
          : /^\d+(?:\.\d+)?$/.test(retry)
            ? now + Number(retry) * 1000
            : Date.parse(retry);
      const resetAt =
        response.headers.get("x-ratelimit-remaining") === "0" && reset !== null
          ? Number(reset) * 1000
          : 0;
      blockedUntil = Math.max(
        now + Math.min(60_000 * 2 ** rateFailures++, 3_600_000),
        Number.isFinite(retryAt) ? retryAt : 0,
        Number.isFinite(resetAt) ? resetAt : 0,
      );
      throw new Error(
        `GitHub HTTP ${response.status}; requests paused until ${new Date(blockedUntil).toISOString()} (check permissions if this persists)`,
      );
    }
    if (response.status === 401) {
      token = undefined;
      throw new Error("GitHub HTTP 401; check authentication");
    }
    if (response.status !== (method === "POST" ? 201 : 200))
      throw new Error(`GitHub HTTP ${response.status} for ${method} ${path}`);
    rateFailures = 0;
    if (response.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
      blockedUntil = Math.max(
        Date.now() + 60_000,
        Number.isFinite(reset) ? reset : 0,
      );
    }
    return response;
  }
  async function json(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      throw new Error("GitHub returned invalid JSON");
    }
  }
  async function list(path: string): Promise<unknown[]> {
    const rows: unknown[] = [];
    const endpoint = new URL(`${api}${path}`);
    endpoint.searchParams.set("per_page", "100");
    const filters = new URLSearchParams(endpoint.search);
    filters.sort();
    endpoint.searchParams.set("page", "1");
    for (let page = 1; page <= 1000; page++) {
      const response = await request(`${endpoint.pathname}${endpoint.search}`);
      const batch = await json(response);
      if (!Array.isArray(batch))
        throw new Error("GitHub returned a non-array page");
      rows.push(...batch);
      const link = response.headers.get("link");
      if (!link || !/;\s*rel="next"/.test(link)) return rows;
      const next = /<([^>]+)>;\s*rel="next"/.exec(link)?.[1];
      let actual: URL;
      try {
        actual = new URL(next ?? "");
      } catch {
        throw new Error("GitHub returned an unexpected pagination link");
      }
      // GitHub emits /repositories/<id> aliases and opaque `after` cursors.
      // Validate the resource and filters, then keep requests on our configured
      // owner/repo endpoint: an alias never selects another repository for us.
      const canonicalPath = actual.pathname.replace(
        /^\/repositories\/[1-9]\d*(?=\/)/,
        `/repos/${repository}`,
      );
      const actualFilters = new URLSearchParams(actual.search);
      actualFilters.delete("page");
      actualFilters.delete("after");
      actualFilters.sort();
      if (
        actual.origin !== api ||
        actual.username ||
        actual.password ||
        actual.hash ||
        canonicalPath !== endpoint.pathname ||
        actual.searchParams.getAll("page").length !== 1 ||
        actual.searchParams.get("page") !== String(page + 1) ||
        actual.searchParams.getAll("after").length > 1 ||
        actual.searchParams.get("after") === "" ||
        actualFilters.toString() !== filters.toString()
      )
        throw new Error("GitHub returned an unexpected pagination link");
      endpoint.search = actual.search;
    }
    throw new Error("GitHub pagination exceeded 1000 pages");
  }
  function labels(issue: Issue): string[] {
    return issue.labels
      .map((label) => (typeof label === "string" ? label : label.name))
      .sort();
  }
  function identity(issue: Issue, number = issue.number): void {
    if (
      issue.number !== number ||
      issue.repository_url.toLowerCase() !== `${api}/repos/${repository}` ||
      issue.url.toLowerCase() !== `${api}${base}/${number}` ||
      issue.html_url.toLowerCase() !==
        `https://github.com/${repository}/issues/${number}`
    )
      throw new ReportConflict(
        "GitHub issue identity changed; transfers and repository renames require intervention",
      );
  }
  function admitted(issue: Issue): boolean {
    const present = labels(issue);
    return (
      issue.state === "open" &&
      issue.pull_request === undefined &&
      required.every((label) => present.includes(label)) &&
      !excluded.some((label) => present.includes(label))
    );
  }
  async function dependencies(number: number): Promise<Issue[]> {
    return v.parse(
      v.array(issueSchema),
      await list(`${base}/${number}/dependencies/blocked_by`),
    );
  }
  function satisfied(issue: Issue): boolean {
    return issue.state === "closed" && issue.state_reason === "completed";
  }
  function fingerprint(issue: Issue, deps: Issue[]): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          title: issue.title,
          body: issue.body,
          labels: labels(issue),
          dependencies: deps
            .map(
              (dep) =>
                `${dep.node_id}:${dep.state}:${dep.state_reason ?? "unknown"}`,
            )
            .sort(),
        }),
      )
      .digest("hex");
  }
  function item(issue: Issue, deps: Issue[]): WorkItem {
    return {
      key: `github:${issue.node_id}:initial`,
      label: `${repository}#${issue.number}`,
      ref: {
        repository,
        number: issue.number,
        nodeId: issue.node_id,
        openStateReason: issue.state_reason ?? null,
        fingerprint: fingerprint(issue, deps),
      },
    };
  }
  function ref(work: WorkItem) {
    const parsed = v.safeParse(reference, work.ref);
    if (
      !parsed.success ||
      parsed.output.repository !== repository ||
      work.key !== `github:${parsed.output.nodeId}:initial` ||
      work.label !== `${repository}#${parsed.output.number}`
    )
      throw new ReportConflict("Invalid GitHub work reference");
    return parsed.output;
  }
  async function read(number: number): Promise<Issue> {
    const issue = v.parse(
      issueSchema,
      await json(await request(`${base}/${number}`)),
    );
    identity(issue, number);
    return issue;
  }
  function unchanged(
    issue: Issue,
    deps: Issue[],
    snapshot: v.InferOutput<typeof reference>,
  ): boolean {
    return (
      issue.node_id === snapshot.nodeId &&
      (issue.state !== "open" ||
        (issue.state_reason ?? null) === snapshot.openStateReason) &&
      fingerprint(issue, deps) === snapshot.fingerprint
    );
  }
  async function apply(report: WorkReport): Promise<void> {
    const snapshot = ref(report.item);
    if (!/^[\w.-]+$/.test(report.attemptId))
      throw new ReportConflict("Invalid attempt ID");
    let action: "complete" | "hold" = "hold";
    let summary = `Attempt ${report.status}. Inspect the local execution record for details.`;
    if (report.status === "completed") {
      const parsed = v.safeParse(outcomeSchema, report.result?.output);
      if (!parsed.success)
        throw new ReportConflict(
          "GitHub expects a complete or hold result with a summary; route is unsupported",
        );
      ({ action, summary } = parsed.output);
    }
    const marker = `<!-- machines-dispatch:${report.attemptId} -->`;
    const legacyMarker = `<!-- auto-machines:${report.attemptId} -->`;
    const body = `${marker}\n\n${summary}`;
    const legacyBody = `${legacyMarker}\n\n${summary}`;
    let issue = await read(snapshot.number);
    if (issue.node_id !== snapshot.nodeId || issue.pull_request !== undefined)
      throw new ReportConflict("GitHub issue identity changed");
    const comments = v.parse(
      v.array(v.object({ body: v.string() })),
      await list(`${base}/${snapshot.number}/comments`),
    );
    const recorded = comments.filter((comment) =>
      comment.body.includes(marker) || comment.body.includes(legacyMarker),
    );
    // Match the full prior result, not just its marker: edited summaries still conflict.
    if (recorded.some((comment) => comment.body !== body && comment.body !== legacyBody))
      throw new ReportConflict(
        "GitHub result comment changed; reconcile it before retrying delivery",
      );
    if (recorded.length && action === "hold") return;
    if (recorded.length && issue.state === "closed") {
      if (satisfied(issue)) return;
      throw new ReportConflict(
        "GitHub issue was closed without completion; reconcile its result",
      );
    }
    let deps = await dependencies(snapshot.number);
    if (
      !unchanged(issue, deps, snapshot) ||
      !admitted(issue) ||
      deps.some((dep) => !satisfied(dep))
    )
      throw new ReportConflict(
        `${report.item.label}: issue changed during execution; result is retained locally`,
      );
    if (!recorded.length) {
      const created = v.parse(
        v.object({ body: v.string() }),
        await json(
          await request(`${base}/${snapshot.number}/comments`, "POST", {
            body,
          }),
        ),
      );
      if (created.body !== body)
        throw new Error("GitHub did not confirm the result comment");
    }
    if (action === "complete") {
      // A comment may have succeeded before a network failure. Replays still finish closure.
      issue = await read(snapshot.number);
      deps = await dependencies(snapshot.number);
      if (
        !unchanged(issue, deps, snapshot) ||
        issue.pull_request !== undefined ||
        (issue.state === "closed" ? !satisfied(issue) : !admitted(issue)) ||
        deps.some((dep) => !satisfied(dep))
      )
        throw new ReportConflict(
          `${report.item.label}: issue changed before closure; result comment is retained`,
        );
      if (issue.state !== "closed") {
        const closed = v.parse(
          issueSchema,
          await json(
            await request(`${base}/${snapshot.number}`, "PATCH", {
              state: "closed",
              state_reason: "completed",
            }),
          ),
        );
        identity(closed, snapshot.number);
        if (closed.node_id !== snapshot.nodeId || !satisfied(closed))
          throw new Error("GitHub did not confirm issue closure");
      }
    }
  }
  return {
    id: options.id,
    async scan() {
      const issues = v.parse(
        v.array(issueSchema),
        await list(
          `${base}?state=open&sort=created&direction=asc&labels=${encodeURIComponent(required.join(","))}`,
        ),
      );
      const items: WorkItem[] = [];
      const diagnostics: string[] = [];
      const seen = new Set<string>();
      for (const issue of issues) {
        if (issue.pull_request !== undefined) continue;
        identity(issue);
        if (!admitted(issue) || seen.has(issue.node_id)) continue;
        seen.add(issue.node_id);
        const deps = await dependencies(issue.number);
        if (deps.some((dep) => !satisfied(dep))) {
          diagnostics.push(
            `${repository}#${issue.number}: blocked by ${deps
              .filter((dep) => !satisfied(dep))
              .map((dep) => dep.html_url)
              .join(", ")}`,
          );
        } else items.push(item(issue, deps));
      }
      return { items, issues: diagnostics };
    },
    async prepare(work) {
      const snapshot = ref(work);
      const issue = await read(snapshot.number);
      if (!admitted(issue)) return undefined;
      const deps = await dependencies(issue.number);
      if (
        !unchanged(issue, deps, snapshot) ||
        deps.some((dep) => !satisfied(dep))
      )
        return undefined;
      return {
        cwd,
        machine: options.defaultMachine,
        input: {
          ticket: {
            id: work.label,
            source: options.id,
            title: issue.title,
            body: issue.body ?? "",
            metadata: {
              repository,
              number: issue.number,
              nodeId: issue.node_id,
              url: issue.html_url,
              labels: labels(issue),
            },
          },
          input,
        },
        ...(agents === undefined ? {} : { agents }),
        ...(home === undefined ? {} : { home }),
      };
    },
    apply(report) {
      const next = writes.then(() => apply(report));
      writes = next.catch(() => {});
      return next;
    },
  };
}
