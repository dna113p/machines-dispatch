import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitClaims, type GitClaimsOptions } from "../src/git-claims.ts";
import { ClaimLost, type Holder, type Lease } from "../src/contracts.ts";

const exec = promisify(execFile);
const git = async (cwd: string, ...args: string[]) =>
  (
    await exec("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd })
  ).stdout.trim();
const prefix = "refs/machines-dispatch/claims";
const holder = (name: string, attempt = `${name}-1`): Holder => ({
  daemon: `daemon-${name}`,
  attempt,
  host: name,
});

/** A bare remote and one clone per name. */
async function remote(t: TestContext, ...names: string[]) {
  const root = await mkdtemp(join(tmpdir(), "machines-dispatch-claims-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bare = join(root, "remote.git");
  await git(root, "init", "-q", "--bare", bare);
  const clones: Record<string, string> = {};
  for (const name of names) {
    clones[name] = join(root, name);
    await git(root, "clone", "-q", bare, clones[name]);
  }
  const store = (name: string, options: Partial<GitClaimsOptions> = {}) =>
    gitClaims({ cwd: clones[name]!, ttlMs: 60_000, ...options });
  return { root, bare, clones, store };
}
const claimRefs = (bare: string) =>
  git(bare, "for-each-ref", "--format=%(refname)", "refs/");
async function record(bare: string, scope: string) {
  return JSON.parse(await git(bare, "log", "-1", "--format=%B", `${prefix}/${scope}`));
}

test("two concurrent acquires of a new scope: exactly one wins, the other sees the winner", async (t) => {
  const { store, bare } = await remote(t, "a", "b");
  const a = store("a");
  const b = store("b");
  for (const scope of ["op/T-1", "op/T-2", "op/T-3"]) {
    const [first, second] = await Promise.all([
      a.acquire({ scope, key: `${scope}:initial`, holder: holder("a"), retry: false }),
      b.acquire({ scope, key: `${scope}:initial`, holder: holder("b"), retry: false }),
    ]);
    const results = [first, second];
    const won = results.filter((result) => result.acquired);
    assert.equal(won.length, 1, JSON.stringify(results));
    const winner = won[0]!.acquired ? won[0]!.lease.holder : undefined;
    const lost = results.find((result) => !result.acquired)!;
    assert.ok(!lost.acquired);
    assert.deepEqual(lost.holder, winner);
    assert.equal(lost.expiresAt, won[0]!.acquired ? won[0]!.lease.expiresAt : "");
    assert.deepEqual((await record(bare, scope)).holder, winner);
  }
});

test("an expired lease is taken over by exactly one of two takers, and its old holder loses it", async (t) => {
  const { store, bare } = await remote(t, "a", "b", "c");
  const ttlMs = 1_000;
  const start = Date.parse("2026-01-01T00:00:00Z");
  const later = () => start + ttlMs + 1;
  const a = store("a", { ttlMs, now: () => start });
  const scope = "op/T-1";
  const first = await a.acquire({ scope, key: "k", holder: holder("a"), retry: false });
  assert.ok(first.acquired);
  // Not expired yet by the takers' clock: still held.
  const early = await store("b", { ttlMs, now: () => start + ttlMs - 1 }).acquire({
    scope, key: "k", holder: holder("b"), retry: false,
  });
  assert.deepEqual(early, { acquired: false, holder: holder("a"), expiresAt: first.lease.expiresAt });

  const results = await Promise.all(
    ["b", "c"].map((name) =>
      store(name, { ttlMs, now: later }).acquire({ scope, key: "k", holder: holder(name), retry: false }),
    ),
  );
  const won = results.filter((result) => result.acquired);
  assert.equal(won.length, 1, JSON.stringify(results));
  const winner = won[0]!.acquired ? won[0]!.lease.holder : undefined;
  assert.deepEqual(results.find((result) => !result.acquired), {
    acquired: false,
    holder: winner,
    expiresAt: won[0]!.acquired ? won[0]!.lease.expiresAt : "",
  });
  // Each update is a child of the last: create, takeover.
  assert.equal(await git(bare, "rev-list", "--count", `${prefix}/${scope}`), "2");

  assert.deepEqual(await a.renew(first.lease), { ok: false, reason: "lost", holder: winner });
  await assert.rejects(a.finish(first.lease), (cause) => cause instanceof ClaimLost && /Claim lost to [bc]/.test(cause.message));
  // Abandoning a lost lease changes nothing.
  await a.abandon(first.lease);
  assert.deepEqual((await record(bare, scope)).holder, winner);
});

test("renew extends a lease and keeps history; finish records the key; retry and new keys still acquire", async (t) => {
  const { store, bare } = await remote(t, "a", "b");
  let time = Date.parse("2026-01-01T00:00:00Z");
  const a = store("a", { ttlMs: 1_000, now: () => time });
  const b = store("b", { ttlMs: 1_000, now: () => time });
  const scope = "op/T-1";
  const acquired = await a.acquire({ scope, key: "k1", holder: holder("a"), retry: false });
  assert.ok(acquired.acquired);
  time += 5_000;
  // Expired, but no one took it: the record still names this lease.
  const renewed = await a.renew(acquired.lease);
  assert.ok(renewed.ok);
  assert.equal(renewed.lease.expiresAt, new Date(time + 1_000).toISOString());
  assert.notDeepEqual(renewed.lease.data, acquired.lease.data);
  // The renewal made the first lease obsolete: renewing or finishing it fails
  // and writes nothing, though the record still names the same holder and key.
  const head = await git(bare, "rev-parse", `${prefix}/${scope}`);
  assert.deepEqual(await a.renew(acquired.lease), { ok: false, reason: "lost", holder: holder("a") });
  await assert.rejects(a.finish(acquired.lease), ClaimLost);
  await a.abandon(acquired.lease);
  assert.equal(await git(bare, "rev-parse", `${prefix}/${scope}`), head);

  await a.finish(renewed.lease);
  // Repeating a finish that already landed is harmless.
  await a.finish(renewed.lease);
  assert.deepEqual(await record(bare, scope), {
    version: 1, scope, key: "k1", holder: null, finished: ["k1"],
  });
  assert.deepEqual(await b.acquire({ scope, key: "k1", holder: holder("b"), retry: false }), {
    acquired: false,
    finished: true,
  });
  assert.equal((await a.renew(renewed.lease)).ok, false);

  // An explicit retry ignores the finished list but respects a live lease.
  const retried = await b.acquire({ scope, key: "k1", holder: holder("b"), retry: true });
  assert.ok(retried.acquired);
  const blocked = await a.acquire({ scope, key: "k1", holder: holder("a", "a-2"), retry: true });
  assert.equal(blocked.acquired, false);
  await b.abandon(retried.lease);
  assert.deepEqual((await record(bare, scope)).finished, ["k1"]);

  const next = await a.acquire({ scope, key: "k2", holder: holder("a", "a-3"), retry: false });
  assert.ok(next.acquired);
  await a.abandon(next.lease);
  // Abandoned keys are not finished.
  assert.ok((await b.acquire({ scope, key: "k2", holder: holder("b", "b-2"), retry: false })).acquired);
  const tree = await git(bare, "log", "-1", "--format=%T", `${prefix}/${scope}`);
  assert.equal(tree, await git(bare, "hash-object", "-t", "tree", "/dev/null"));
});

test("a lease abandoned and reacquired by the same holder cannot be renewed or finished", async (t) => {
  const { store, bare } = await remote(t, "a");
  const a = store("a");
  const scope = "op/T-1";
  const first = await a.acquire({ scope, key: "k", holder: holder("a"), retry: false });
  assert.ok(first.acquired);
  await a.abandon(first.lease);
  const again = await a.acquire({ scope, key: "k", holder: holder("a"), retry: false });
  assert.ok(again.acquired);
  assert.deepEqual(again.lease.holder, first.lease.holder);
  const head = await git(bare, "rev-parse", `${prefix}/${scope}`);
  assert.deepEqual(await a.renew(first.lease), { ok: false, reason: "lost", holder: holder("a") });
  await assert.rejects(a.finish(first.lease), ClaimLost);
  await a.abandon(first.lease);
  assert.equal(await git(bare, "rev-parse", `${prefix}/${scope}`), head);
  // The current lease still works.
  const renewed = await a.renew(again.lease);
  assert.ok(renewed.ok);
  await a.finish(renewed.lease);
  assert.deepEqual((await record(bare, scope)).finished, ["k"]);
});

test("a refPrefix inside branches, tags or other Git namespaces is refused before anything is written", async (t) => {
  const { clones, bare } = await remote(t, "a");
  const a = clones.a!;
  await writeFile(join(a, "tracked.txt"), "tracked\n");
  await git(a, "add", "tracked.txt");
  await git(a, "commit", "-q", "-m", "initial");
  await git(a, "push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/tags/v1");
  const before = await claimRefs(bare);
  for (const refPrefix of [
    "refs/heads",
    "refs/heads/claims",
    "refs/tags",
    "refs/tags/claims",
    "refs/Heads/claims",
    "refs/remotes/origin",
    "refs/notes/claims",
    "refs/replace",
    "refs/stash",
    "refs/machines-dispatch-fetched/x",
  ])
    assert.throws(() => gitClaims({ cwd: a, refPrefix }), /reserved Git namespace/, refPrefix);
  assert.equal(await claimRefs(bare), before);
  assert.equal(before, "refs/heads/main\nrefs/tags/v1");
  // A custom prefix outside those namespaces works.
  const custom = gitClaims({ cwd: a, refPrefix: "refs/team/claims" });
  assert.ok((await custom.acquire({ scope: "op/T-1", key: "k", holder: holder("a"), retry: false })).acquired);
  assert.equal(await claimRefs(bare), `${before}\nrefs/team/claims/op/T-1`);
});

test("unsafe scopes are rejected before anything is written", async (t) => {
  const { store, bare } = await remote(t, "a");
  const a = store("a");
  for (const scope of ["", "op", "op/a b", "op/x..y", "op/.hidden", "op//x", "op/a.lock", "op/a~1", "op/a:b", "op/a\\b", "op/a?", "/op/a", "op/a/", "op/@{1}"])
    await assert.rejects(
      a.acquire({ scope, key: "k", holder: holder("a"), retry: false }),
      /Unsafe claim scope/,
      scope,
    );
  assert.equal(await claimRefs(bare), "");
  assert.throws(() => gitClaims({ cwd: ".", refPrefix: "claims" }), /refPrefix/);
  assert.throws(() => gitClaims({ cwd: ".", remote: "--upload-pack=x" }), /remote/);
  assert.throws(() => gitClaims({ cwd: ".", ttlMs: 0 }), /ttlMs/);
});

test("claims never touch HEAD, the index, the working tree, branches or FETCH_HEAD", async (t) => {
  const { store, bare, clones } = await remote(t, "a", "b");
  const a = clones.a!;
  await writeFile(join(a, "tracked.txt"), "tracked\n");
  await git(a, "add", "tracked.txt");
  await git(a, "commit", "-q", "-m", "initial");
  await git(a, "push", "-q", "origin", "HEAD:refs/heads/main");
  // A staged change, an unstaged change and an untracked file.
  await writeFile(join(a, "staged.txt"), "staged\n");
  await git(a, "add", "staged.txt");
  await writeFile(join(a, "tracked.txt"), "edited\n");
  await writeFile(join(a, "untracked.txt"), "untracked\n");
  const snapshot = async () => ({
    head: await readFile(join(a, ".git", "HEAD"), "utf8"),
    headCommit: await git(a, "rev-parse", "HEAD"),
    index: createHash("sha256").update(await readFile(join(a, ".git", "index"))).digest("hex"),
    status: await git(a, "status", "--porcelain=v1", "--untracked-files=all"),
    branches: await git(a, "for-each-ref", "refs/heads", "refs/remotes", "refs/tags"),
    remoteBranches: await git(bare, "for-each-ref", "refs/heads", "refs/tags"),
  });
  const before = await snapshot();
  const claims = store("a");
  const other = store("b");
  const acquired = await claims.acquire({ scope: "op/T-1", key: "k", holder: holder("a"), retry: false });
  assert.ok(acquired.acquired);
  assert.equal((await other.acquire({ scope: "op/T-1", key: "k", holder: holder("b"), retry: false })).acquired, false);
  const renewed = await claims.renew(acquired.lease);
  assert.ok(renewed.ok);
  await claims.finish(renewed.lease);
  const next = await claims.acquire({ scope: "op/T-1", key: "k2", holder: holder("a", "a-2"), retry: false });
  assert.ok(next.acquired);
  await claims.abandon(next.lease);
  assert.deepEqual(await snapshot(), before);
  for (const clone of [a, clones.b!])
    await assert.rejects(access(join(clone, ".git", "FETCH_HEAD")), { code: "ENOENT" });
  // The remote gained only the claim ref.
  assert.equal(
    await git(bare, "for-each-ref", "--format=%(refname)"),
    `refs/heads/main\n${prefix}/op/T-1`,
  );
});

test("an unreachable remote throws rather than answering", async (t) => {
  const { store, bare } = await remote(t, "a");
  const claims = store("a", { timeoutMs: 10_000 });
  const acquired = await claims.acquire({ scope: "op/T-1", key: "k", holder: holder("a"), retry: false });
  assert.ok(acquired.acquired);
  await rename(bare, `${bare}.away`);
  await assert.rejects(claims.acquire({ scope: "op/T-2", key: "k", holder: holder("a"), retry: false }), /git/);
  await assert.rejects(claims.renew(acquired.lease), /git/);
  await assert.rejects(claims.finish(acquired.lease), /git/);
  await rename(`${bare}.away`, bare);
  assert.ok((await claims.renew(acquired.lease)).ok);
  // A lease from another store's prefix is refused.
  const foreign: Lease = { ...acquired.lease, data: { ref: "refs/heads/main", commit: "x" } };
  await assert.rejects(claims.renew(foreign), /does not belong/);
});
