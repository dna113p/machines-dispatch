import assert from "node:assert/strict";
import { test } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { github, type GitHubOptions } from "../src/github.ts";
import { loadConfiguration } from "../src/config.ts";
import {
  ReportConflict,
  type JsonValue,
  type WorkItem,
  type WorkReport,
} from "../src/contracts.ts";
import { workspace } from "./helpers.ts";

const repository = "owner/repo";
const prefix = `/repos/${repository}/issues`;
function issue(number = 1, overrides: Record<string, unknown> = {}) {
  return {
    node_id: `I_${number}`,
    number,
    url: `https://api.github.com${prefix}/${number}`,
    repository_url: `https://api.github.com/repos/${repository}`,
    html_url: `https://github.com/${repository}/issues/${number}`,
    title: `Task ${number}`,
    body: "Acceptance: verified.",
    state: "open",
    state_reason: null as string | null,
    labels: [{ name: "ready" }, { name: "automate" }],
    ...overrides,
  };
}
function fixture(overrides: Partial<GitHubOptions> = {}) {
  const state = {
    issues: [issue()],
    dependencies: [] as ReturnType<typeof issue>[],
    comments: [] as { body: string }[],
    calls: [] as {
      url: URL;
      method: string;
      body: unknown;
      init: RequestInit | undefined;
    }[],
    before: undefined as
      | ((url: URL, method: string) => Response | undefined)
      | undefined,
    afterPost: undefined as (() => void) | undefined,
    afterPatch: undefined as (() => void) | undefined,
  };
  const transport: typeof fetch = async (url, init) => {
    const parsed = new URL(String(url));
    assert.equal(parsed.origin, "https://api.github.com");
    const method = init?.method ?? "GET";
    const body: unknown =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    state.calls.push({ url: parsed, method, body, init });
    const intercepted = state.before?.(parsed, method);
    if (intercepted) return intercepted;
    if (parsed.pathname.endsWith("/dependencies/blocked_by"))
      return Response.json(state.dependencies);
    if (parsed.pathname.endsWith("/comments")) {
      if (method === "POST") {
        assert.ok(
          body &&
            typeof body === "object" &&
            "body" in body &&
            typeof body.body === "string",
        );
        state.comments.push({ body: body.body });
        state.afterPost?.();
        return Response.json({ body: body.body }, { status: 201 });
      }
      return Response.json(state.comments);
    }
    if (parsed.pathname === prefix)
      return Response.json(
        state.issues.filter((entry) => entry.state === "open"),
      );
    const entry = state.issues.find(
      (entry) => parsed.pathname === `${prefix}/${entry.number}`,
    );
    assert.ok(entry, `Unexpected request ${url}`);
    if (method === "PATCH") {
      assert.deepEqual(body, { state: "closed", state_reason: "completed" });
      entry.state = "closed";
      entry.state_reason = "completed";
      state.afterPatch?.();
    }
    return Response.json(entry);
  };
  const options: GitHubOptions = {
    id: "github",
    cwd: "/tmp",
    repository,
    requiredLabels: ["ready", "automate"],
    excludedLabels: ["manual"],
    defaultMachine: "work",
    token: "fixture-secret",
    fetch: transport,
    ...overrides,
  };
  const source = github(options);
  return { state, options, source };
}
const report = (
  item: WorkItem,
  action: "complete" | "hold" = "complete",
): WorkReport => ({
  attemptId: "attempt-1",
  item,
  status: "completed",
  result: { state: "done", output: { action, summary: "Verified." } },
});

test("GitHub scans paginated issues, excludes PRs/labels, and verifies native blockers", async () => {
  const { source, state } = fixture();
  state.issues = [
    issue(),
    issue(2),
    issue(3, { pull_request: {} }),
    issue(4, { labels: ["ready"] }),
    issue(5, { labels: ["ready", "automate", "manual"] }),
  ];
  state.before = (url) => {
    if (url.pathname === prefix) {
      if (url.searchParams.get("page") === "1") {
        const next = new URL(url);
        next.searchParams.set("page", "2");
        next.searchParams.sort(); // GitHub may reorder query parameters.
        return Response.json(state.issues.slice(0, 1), {
          headers: { link: `<${next}>; rel="next"` },
        });
      }
      return Response.json(state.issues.slice(1));
    }
    if (url.pathname === `${prefix}/2/dependencies/blocked_by`)
      return Response.json([issue(10)]);
  };
  const scan = await source.scan();
  assert.deepEqual(
    scan.items.map((entry) => entry.label),
    ["owner/repo#1"],
  );
  assert.match(scan.issues!.join(" "), /blocked by.*issues\/10/);
  assert.equal(
    state.calls.filter((call) => call.url.pathname.endsWith("blocked_by"))
      .length,
    2,
  );
  const launch = await source.prepare(scan.items[0]!);
  assert.equal(launch!.machine, "work");
  assert.deepEqual(launch!.input, {
    ticket: {
      id: "owner/repo#1",
      source: "github",
      title: "Task 1",
      body: "Acceptance: verified.",
      metadata: {
        repository,
        number: 1,
        nodeId: "I_1",
        url: "https://github.com/owner/repo/issues/1",
        labels: ["automate", "ready"],
      },
    },
    input: null,
  });
  for (const call of state.calls) {
    assert.equal(call.init!.redirect, "manual");
    assert.ok(call.init!.signal instanceof AbortSignal);
    assert.equal(
      new Headers(call.init!.headers).get("authorization"),
      "Bearer fixture-secret",
    );
  }
});

test("GitHub canonical repository links preserve cursor pagination on the configured endpoint", async () => {
  const { source, state } = fixture();
  state.issues = [issue(), issue(2), issue(3)];
  const cursors = ["Y3Vyc29yOnYyOpLPAAABUR0R0nDOBwQg4Q==", "opaque+/second=="];
  state.before = (url) => {
    if (url.pathname !== prefix) return;
    const page = Number(url.searchParams.get("page"));
    assert.equal(
      url.searchParams.get("after"),
      page === 1 ? null : cursors[page - 2],
    );
    const headers: Record<string, string> = {};
    if (page < 3) {
      const next = new URL(url);
      next.pathname = "/repositories/41881900/issues";
      next.searchParams.set("page", String(page + 1));
      next.searchParams.set("after", cursors[page - 1]!);
      next.searchParams.sort();
      headers.link = `<${next}>; rel="next"`;
    }
    return Response.json([state.issues[page - 1]], { headers });
  };
  assert.deepEqual(
    (await source.scan()).items.map((item) => item.label),
    ["owner/repo#1", "owner/repo#2", "owner/repo#3"],
  );
  assert.ok(state.calls.every((call) => call.url.pathname.startsWith(prefix)));
});

test("only completed prerequisites satisfy readiness; every dependency page is checked", async () => {
  const { source, state } = fixture();
  for (const reason of [null, "not_planned", "duplicate", "unknown"]) {
    state.dependencies = [issue(10, { state: "closed", state_reason: reason })];
    assert.equal((await source.scan()).items.length, 0);
  }
  state.dependencies = [
    issue(10, { state: "closed", state_reason: "completed" }),
  ];
  assert.equal((await source.scan()).items.length, 1);
  state.before = (url) => {
    if (!url.pathname.endsWith("blocked_by")) return;
    if (url.searchParams.get("page") === "1") {
      const next = new URL(url);
      next.pathname = "/repositories/41881900/issues/1/dependencies/blocked_by";
      next.searchParams.set("page", "2");
      return Response.json(state.dependencies, {
        headers: { link: `<${next}>; rel="next"` },
      });
    }
    return Response.json([issue(11)]);
  };
  assert.equal((await source.scan()).items.length, 0);
});

test("prepare rereads snapshots and admission without changing execution identity", async () => {
  const { source, state } = fixture({
    input: false,
    agents: { coder: "codex" },
    home: "home",
  });
  const first = (await source.scan()).items[0]!;
  Object.assign(state.issues[0]!, { updated_at: "tomorrow", comments: 20 });
  state.comments.push({ body: "Additional discussion" });
  assert.equal((await source.scan()).items[0]!.key, first.key);
  const launch = await source.prepare(first);
  assert.equal((launch!.input as { input: unknown }).input, false);
  assert.deepEqual(launch!.agents, { coder: "codex" });
  assert.equal(launch!.home, "/tmp/home");
  state.issues[0]!.title = "Changed task";
  assert.equal(await source.prepare(first), undefined);
  const edited = (await source.scan()).items[0]!;
  assert.equal(edited.key, first.key);
  assert.equal(edited.label, first.label);
  assert.notDeepEqual(edited.ref, first.ref);
  state.dependencies = [issue(10)];
  assert.equal(await source.prepare(edited), undefined);
  state.dependencies = [];
  state.issues[0]!.labels = [{ name: "ready" }];
  assert.equal(await source.prepare(edited), undefined);
  state.issues[0]!.state = "closed";
  assert.equal(await source.prepare(edited), undefined);
});

test("an allowed author association is scanned and launched without extra requests", async () => {
  const requests = (calls: { url: URL; method: string }[]) =>
    calls.map((call) => `${call.method} ${call.url.pathname}${call.url.search}`);
  const plain = fixture();
  const gated = fixture({ allowedAuthorAssociations: ["OWNER", "MEMBER"] });
  for (const { state } of [plain, gated])
    state.issues = [issue(1, { author_association: "MEMBER" })];
  const expected = (await plain.source.scan()).items;
  const expectedLaunch = await plain.source.prepare(expected[0]!);
  const scan = await gated.source.scan();
  assert.deepEqual(scan.items, expected);
  assert.deepEqual(scan.issues, []);
  const launch = await gated.source.prepare(scan.items[0]!);
  assert.deepEqual(launch, expectedLaunch);
  assert.equal(
    (launch!.input as { ticket: { body: string } }).ticket.body,
    "Acceptance: verified.",
  );
  assert.deepEqual(requests(gated.state.calls), requests(plain.state.calls));
  assert.equal(gated.state.calls.length, 4);
});

test("an unlisted or missing author association is diagnosed once and never launched", async () => {
  const { source, state } = fixture({
    allowedAuthorAssociations: ["OWNER", "MEMBER"],
  });
  state.issues = [
    issue(1, { author_association: "OWNER" }),
    issue(2, { author_association: "NONE" }),
    issue(3),
    issue(4, { author_association: "member" }),
    issue(5, { author_association: "CONTRIBUTOR", labels: ["ready"] }),
  ];
  const scan = await source.scan();
  assert.deepEqual(
    scan.items.map((entry) => entry.label),
    ["owner/repo#1"],
  );
  assert.deepEqual(scan.issues, [
    "owner/repo#2: author association NONE is not in allowedAuthorAssociations",
    "owner/repo#3: author association unknown is not in allowedAuthorAssociations",
    "owner/repo#4: author association member is not in allowedAuthorAssociations",
  ]);
  assert.deepEqual(
    state.calls
      .filter((call) => call.url.pathname.endsWith("blocked_by"))
      .map((call) => call.url.pathname),
    [`${prefix}/1/dependencies/blocked_by`],
  );
  // A maintainer's label does not carry over to a later, untrusted author.
  const item = scan.items[0]!;
  assert.ok(await source.prepare(item));
  for (const author_association of ["NONE", undefined]) {
    Object.assign(state.issues[0]!, { author_association });
    const calls = state.calls.length;
    assert.equal(await source.prepare(item), undefined);
    assert.equal(state.calls.length, calls + 1);
  }
  // Work found by an ungated registration is still refused at launch.
  const open = fixture();
  open.state.issues = [issue(2, { author_association: "NONE" })];
  const untrusted = (await open.source.scan()).items[0]!;
  assert.equal(await source.prepare(untrusted), undefined);
  assert.equal(state.calls.filter((call) => call.method !== "GET").length, 0);
});

test("omitting allowedAuthorAssociations admits any author and keeps work refs", async () => {
  const { source, state } = fixture();
  const baseline = (await source.scan()).items[0]!;
  const baselineLaunch = await source.prepare(baseline);
  for (const author_association of ["NONE", "FIRST_TIME_CONTRIBUTOR", "OWNER"]) {
    Object.assign(state.issues[0]!, { author_association });
    const scan = await source.scan();
    assert.deepEqual(scan.items, [baseline]);
    assert.deepEqual(scan.issues, []);
    assert.deepEqual(await source.prepare(baseline), baselineLaunch);
  }
});

test("allowedAuthorAssociations must be a non-empty list of non-empty strings", () => {
  const { options } = fixture();
  const invalid: unknown[] = [
    [],
    [""],
    ["OWNER", ""],
    [" OWNER"],
    ["OWNER", 3],
    [null],
    "OWNER",
    null,
  ];
  for (const allowedAuthorAssociations of invalid)
    assert.throws(
      () =>
        github({
          ...options,
          allowedAuthorAssociations,
        } as GitHubOptions),
      `accepted ${JSON.stringify(allowedAuthorAssociations)}`,
    );
  assert.doesNotThrow(() =>
    github({ ...options, allowedAuthorAssociations: ["OWNER"] }),
  );
  assert.doesNotThrow(() =>
    github({ ...options, allowedAuthorAssociations: undefined }),
  );
});

test("transfers, changed issue IDs, and mismatched work refs cannot launch or write", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  for (const changed of [
    { key: "other" },
    { label: "other" },
    { ref: { ...(item.ref as object), repository: "other/repo" } },
  ]) {
    await assert.rejects(
      source.prepare({ ...item, ...changed }),
      ReportConflict,
    );
    await assert.rejects(
      source.apply(report({ ...item, ...changed })),
      ReportConflict,
    );
  }
  state.issues[0]!.node_id = "different";
  assert.equal(await source.prepare(item), undefined);
  await assert.rejects(source.apply(report(item)), /identity changed/);
  state.issues[0]!.repository_url = "https://api.github.com/repos/other/repo";
  await assert.rejects(source.scan(), /identity changed/);
  assert.equal(state.calls.filter((call) => call.method !== "GET").length, 0);
});

test("hold comments once and retains the existing execution key", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  await source.apply(report(item, "hold"));
  await source.apply(report(item, "hold"));
  assert.equal(state.comments.length, 1);
  assert.equal(state.issues[0]!.state, "open");
  assert.equal((await source.scan()).items[0]!.key, item.key);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 0);
});

test("complete comments and closes repeatably without changing body or labels", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  const original = structuredClone(state.issues[0]!);
  await source.apply(report(item));
  await source.apply(report(item));
  assert.equal(state.comments.length, 1);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 1);
  assert.equal(state.issues[0]!.state_reason, "completed");
  assert.equal(state.issues[0]!.body, original.body);
  assert.deepEqual(state.issues[0]!.labels, original.labels);
  assert.equal((await source.scan()).items.length, 0);
});

test("ambiguous comment success is found on replay and remaining closure finishes", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  state.afterPost = () => {
    state.afterPost = undefined;
    throw new Error("connection lost with secret");
  };
  await assert.rejects(
    source.apply(report(item)),
    /^Error: GitHub request failed or timed out; delivery will be retried$/,
  );
  assert.equal(state.comments.length, 1);
  assert.equal(state.issues[0]!.state, "open");
  await source.apply(report(item));
  assert.equal(state.comments.length, 1);
  assert.equal(state.issues[0]!.state, "closed");
});

test("ambiguous closure success is recognized on replay", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  state.afterPatch = () => {
    state.afterPatch = undefined;
    throw new Error("lost response");
  };
  await assert.rejects(source.apply(report(item)), /failed or timed out/);
  await source.apply(report(item));
  assert.equal(state.comments.length, 1);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("reopening after ambiguous closure conflicts without undoing the Human decision", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  state.afterPatch = () => {
    state.afterPatch = undefined;
    throw new Error("lost response after successful closure");
  };
  await assert.rejects(source.apply(report(item)), /failed or timed out/);
  state.issues[0]!.state = "open";
  state.issues[0]!.state_reason = "reopened";
  await assert.rejects(source.apply(report(item)), /changed during execution/);
  assert.equal(state.issues[0]!.state, "open");
  assert.equal(state.issues[0]!.state_reason, "reopened");
  assert.equal(state.comments.length, 1);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 1);
});

test("a deliberate new attempt may handle an already-reopened issue", async () => {
  const { source, state } = fixture();
  const previous = (await source.scan()).items[0]!;
  await source.apply(report(previous));
  state.issues[0]!.state = "open";
  state.issues[0]!.state_reason = "reopened";
  assert.equal(await source.prepare(previous), undefined);
  const retry = (await source.scan()).items[0]!;
  assert.equal(retry.key, previous.key); // The daemon still requires explicit retry.
  assert.notDeepEqual(retry.ref, previous.ref);
  assert.ok(await source.prepare(retry));
  await source.apply({ ...report(retry), attemptId: "deliberate-retry" });
  assert.equal(state.issues[0]!.state, "closed");
  assert.equal(state.issues[0]!.state_reason, "completed");
  assert.equal(state.comments.length, 2);
  assert.equal(state.calls.filter((call) => call.method === "PATCH").length, 2);
});

test("changed tasks and unsupported output create conflicts without writes", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  const invalid: (JsonValue | undefined)[] = [
    undefined,
    { action: "route", machine: "next", summary: "Next" },
    { action: "complete", summary: 3 },
  ];
  for (const output of invalid)
    await assert.rejects(
      source.apply({ ...report(item), result: { state: "done", output } }),
      ReportConflict,
    );
  state.issues[0]!.body = "New requirement";
  await assert.rejects(source.apply(report(item)), /changed during execution/);
  assert.equal(state.comments.length, 0);
  assert.equal(state.calls.filter((call) => call.method !== "GET").length, 0);
});

test("edits after the result comment prevent closure on this delivery and replay", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  state.afterPost = () => {
    state.issues[0]!.title = "Changed task";
  };
  await assert.rejects(source.apply(report(item)), /changed before closure/);
  await assert.rejects(source.apply(report(item)), /changed during execution/);
  assert.equal(state.comments.length, 1);
  assert.equal(state.issues[0]!.state, "open");
});

test("closing a task as cancelled cannot masquerade as completed delivery", async () => {
  for (const state_reason of [null, "not_planned", "duplicate"]) {
    const { source, state } = fixture();
    const item = (await source.scan()).items[0]!;
    state.afterPost = () => {
      state.issues[0]!.state = "closed";
      state.issues[0]!.state_reason = state_reason;
    };
    await assert.rejects(source.apply(report(item)), ReportConflict);
    await assert.rejects(
      source.apply(report(item)),
      /closed without completion/,
    );
    assert.equal(
      state.calls.filter((call) => call.method === "PATCH").length,
      0,
    );
  }
});

test("comment lookup is paginated and edited delivery markers conflict", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  await source.apply(report(item, "hold"));
  state.before = (url) => {
    if (!url.pathname.endsWith("/comments")) return;
    if (url.searchParams.get("page") === "1") {
      const next = new URL(url);
      next.pathname = "/repositories/41881900/issues/1/comments";
      next.searchParams.set("page", "2");
      return Response.json([{ body: "Unrelated" }], {
        headers: { link: `<${next}>; rel="next"` },
      });
    }
    return Response.json(state.comments);
  };
  await source.apply(report(item, "hold"));
  assert.equal(state.comments.length, 1);
  state.comments[0]!.body += "Human edited";
  await assert.rejects(
    source.apply(report(item, "hold")),
    /result comment changed/,
  );
});

test("failed reports publish a repeatable note without closing", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  await source.apply({
    attemptId: "failed",
    item,
    status: "failed",
    error: "Private detail",
  });
  await source.apply({
    attemptId: "failed",
    item,
    status: "failed",
    error: "Private detail",
  });
  assert.equal(state.comments.length, 1);
  assert.match(state.comments[0]!.body, /Attempt failed/);
  assert.doesNotMatch(state.comments[0]!.body, /Private detail/);
  assert.equal(state.issues[0]!.state, "open");
});

test("rate-limit headers defer later polls without sleeping or more requests", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const { source, state } = fixture();
  state.before = () =>
    new Response("private diagnostic", {
      status: 429,
      headers: {
        "retry-after": "120",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "1300",
      },
    });
  await assert.rejects(source.scan(), /HTTP 429.*paused/);
  const calls = state.calls.length;
  now += 299_000;
  await assert.rejects(source.scan(), /requests paused/);
  assert.equal(state.calls.length, calls);
  now += 1001;
  state.before = undefined;
  assert.equal((await source.scan()).items.length, 1);
});

test("rate limits back off when no headers are supplied and permissions stay visible", async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const { source, state } = fixture();
  state.before = () => new Response("forbidden", { status: 403 });
  await assert.rejects(source.scan(), /HTTP 403.*permissions/);
  now += 60_001;
  await assert.rejects(source.scan(), /HTTP 403/);
  const calls = state.calls.length;
  now += 60_001;
  await assert.rejects(source.scan(), /requests paused/);
  assert.equal(state.calls.length, calls);
});

test("authentication and unexpected protocol responses fail visibly and without secret output", async () => {
  for (const response of [
    new Response("secret", { status: 401 }),
    new Response("secret", { status: 404 }),
    new Response("secret", {
      status: 301,
      headers: { location: "https://elsewhere.invalid" },
    }),
    Response.json({}),
    Response.json([{}]),
    new Response("not JSON"),
  ]) {
    const { source, state } = fixture();
    state.before = () => response;
    await assert.rejects(
      source.scan(),
      (cause: unknown) =>
        cause instanceof Error && !cause.message.includes("secret"),
    );
  }
  const { source, state } = fixture();
  state.before = (url) =>
    url.pathname.endsWith("blocked_by")
      ? new Response("private", { status: 404 })
      : undefined;
  await assert.rejects(source.scan(), /HTTP 404/);
});

test("unsafe or inconsistent pagination never sends credentials to another origin", async () => {
  for (const next of [
    "https://evil.invalid/next",
    `https://api.github.com${prefix}?page=99`,
    "invalid",
  ]) {
    const { source, state } = fixture();
    state.before = () =>
      Response.json([], { headers: { link: `<${next}>; rel="next"` } });
    await assert.rejects(source.scan(), /unexpected pagination/);
    assert.equal(state.calls.length, 1);
  }
});

test("pagination aliases cannot alter the resource, filters, or page sequence", async () => {
  const invalid: ((url: URL) => void)[] = [
    (url) => {
      url.pathname = "/repos/other/repo/issues";
    },
    (url) => {
      url.pathname = "/repositories/41881900/pulls";
    },
    (url) => {
      url.pathname = "/repositories/not-an-id/issues";
    },
    (url) => {
      url.searchParams.delete("labels");
    },
    (url) => {
      url.searchParams.set("labels", "other");
    },
    (url) => {
      url.searchParams.set("state", "closed");
    },
    (url) => {
      url.searchParams.set("per_page", "1");
    },
    (url) => {
      url.searchParams.set("page", "99");
    },
    (url) => {
      url.searchParams.append("page", "2");
    },
    (url) => {
      url.searchParams.append("after", "one");
      url.searchParams.append("after", "two");
    },
    (url) => {
      url.searchParams.set("after", "");
    },
    (url) => {
      url.searchParams.set("access_token", "not-supported");
    },
    (url) => {
      url.username = "user";
    },
    (url) => {
      url.hash = "fragment";
    },
  ];
  for (const alter of invalid) {
    const { source, state } = fixture();
    state.before = (url) => {
      const next = new URL(url);
      next.pathname = "/repositories/41881900/issues";
      next.searchParams.set("page", "2");
      alter(next);
      return Response.json([], { headers: { link: `<${next}>; rel="next"` } });
    };
    await assert.rejects(source.scan(), /unexpected pagination/);
    assert.equal(state.calls.length, 1);
  }
});

test("configuration resolves GitHub cwd and home relative to its config", async (t) => {
  const root = await workspace(t);
  const { options } = fixture();
  const config = join(root, "machines-dispatch.config.ts");
  await writeFile(
    config,
    `export default ({ github }) => [github({
    id: "configured", cwd: "project", home: "../home", repository: "owner/repo",
    requiredLabels: ["ready"], defaultMachine: "work", token: "test", input: { task: "configured" },
    fetch: async (url) => Response.json(url.includes("dependencies") ? [] : url.includes("?") ? [${JSON.stringify(issue())}] : ${JSON.stringify(issue())})
  })];`,
  );
  const [source] = await loadConfiguration(config);
  const item = (await source!.scan()).items[0]!;
  const launch = await source!.prepare(item);
  assert.equal(launch!.cwd, join(root, "project"));
  assert.equal(launch!.home, join(root, "home"));
  assert.deepEqual((launch!.input as { input: unknown }).input, {
    task: "configured",
  });
  assert.throws(() => github({ ...options, requiredLabels: [] }));
  assert.throws(
    () => github({ ...options, repository: "https://github.com/owner/repo" }),
    /owner\/repo/,
  );
  assert.throws(
    () => github({ ...options, excludedLabels: ["ready"] }),
    /both required and excluded/,
  );
});

test("environment authentication is lazy, prefers GH_TOKEN, and refreshes after 401", async (t) => {
  const previous = {
    GH_TOKEN: process.env.GH_TOKEN,
    GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  };
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  process.env.GH_TOKEN = "first";
  process.env.GITHUB_TOKEN = "fallback";
  const { source, state } = fixture({ token: undefined });
  assert.equal(state.calls.length, 0);
  process.env.GH_TOKEN = "selected-after-construction";
  state.before = () => new Response(null, { status: 401 });
  await assert.rejects(source.scan(), /authentication/);
  assert.equal(
    new Headers(state.calls[0]!.init!.headers).get("authorization"),
    "Bearer selected-after-construction",
  );
  delete process.env.GH_TOKEN;
  state.before = undefined;
  await source.scan();
  assert.equal(
    new Headers(state.calls[1]!.init!.headers).get("authorization"),
    "Bearer fallback",
  );
});


for (const action of ["hold", "complete"] as const) {
  test(`legacy GitHub ${action} result is recognized without duplicate comments`, async () => {
    const { source, state } = fixture();
    const item = (await source.scan()).items[0]!;
    const body = "<!-- auto-machines:attempt-1 -->\n\nVerified.";
    state.comments.push({ body });
    await source.apply(report(item, action));
    await source.apply(report(item, action));
    assert.deepEqual(state.comments, [{ body }]);
    assert.equal(state.calls.filter((call) => call.method === "POST").length, 0);
    assert.equal(state.calls.filter((call) => call.method === "PATCH").length, action === "complete" ? 1 : 0);
    assert.equal(state.issues[0]!.state, action === "complete" ? "closed" : "open");
  });
}

test("edited legacy GitHub result comments still conflict", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  state.comments.push({ body: "<!-- auto-machines:attempt-1 -->\n\nHuman changed the summary." });
  await assert.rejects(source.apply(report(item)), /result comment changed/);
  assert.equal(state.calls.filter((call) => call.method !== "GET").length, 0);
});

test("new GitHub results and User-Agent use machines-dispatch", async () => {
  const { source, state } = fixture();
  const item = (await source.scan()).items[0]!;
  await source.apply(report(item, "hold"));
  assert.equal(state.comments[0]!.body, "<!-- machines-dispatch:attempt-1 -->\n\nVerified.");
  assert.ok(state.calls.every((call) => new Headers(call.init!.headers).get("user-agent") === "machines-dispatch"));
});
