import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as v from "valibot";
import {
  ClaimLost,
  type Acquisition,
  type ClaimRequest,
  type ClaimStore,
  type Holder,
  type Lease,
  type Renewal,
} from "./contracts.ts";
import { nonempty } from "./validation.ts";

export interface GitClaimsOptions {
  /** A Git checkout whose remote holds the claim refs. */
  cwd: string;
  /** Remote name or URL. Defaults to "origin". */
  remote?: string;
  /** Defaults to "refs/machines-dispatch/claims". */
  refPrefix?: string;
  /** How long an acquisition or renewal lasts. Defaults to 10 minutes. */
  ttlMs?: number;
  /** Longest one git command may take. Defaults to 30 seconds. */
  timeoutMs?: number;
  /** Replaces the clock for tests. */
  now?: () => number;
}
const holderSchema = v.strictObject({
  daemon: nonempty,
  attempt: nonempty,
  host: v.string(),
});
/** The JSON message of a claim commit. */
const recordSchema = v.strictObject({
  version: v.literal(1),
  scope: v.string(),
  key: v.optional(v.string()),
  holder: v.nullable(holderSchema),
  expiresAt: v.optional(v.string()),
  finished: v.array(v.string()),
});
type ClaimRecord = v.InferOutput<typeof recordSchema>;
const leaseData = v.strictObject({ ref: nonempty, commit: nonempty });
const leaseSchema = v.object({
  scope: nonempty,
  key: v.string(),
  holder: holderSchema,
  expiresAt: v.string(),
  ttlMs: v.number(),
  data: leaseData,
});
/** Rejected pushes and changed reads re-decide this many times before giving up. */
const rounds = 5;
/**
 * Namespaces Git and its tools give meaning to (branches, tags, notes, ...),
 * plus this store's own fetched copies. Claims never live under them.
 */
const reserved = new Set([
  "heads",
  "tags",
  "remotes",
  "notes",
  "replace",
  "stash",
  "bisect",
  "worktree",
  "rewritten",
  "prefetch",
  "original",
  "pull",
  "merge-requests",
  "machines-dispatch-fetched",
]);
const same = (a: Holder | null | undefined, b: Holder) =>
  !!a && a.daemon === b.daemon && a.attempt === b.attempt;

/**
 * Claims as refs on a Git remote, one per scope. Each record is an empty-tree
 * commit whose message is the JSON record and whose parent is the previous
 * record. Writes are pushes with a lease on the sha that was read, so the
 * remote compares and swaps; a rejected push re-reads and decides again.
 * Nothing touches branches, HEAD, the index, the working tree or FETCH_HEAD.
 */
export function gitClaims(options: GitClaimsOptions): ClaimStore {
  const cwd = resolve(v.parse(nonempty, options.cwd));
  const remote = v.parse(nonempty, options.remote ?? "origin");
  if (remote.startsWith("-")) throw new Error("gitClaims remote must not start with -");
  const prefix = options.refPrefix ?? "refs/machines-dispatch/claims";
  if (!/^refs\/[^\s]+[^/]$/.test(prefix))
    throw new Error("gitClaims refPrefix must start with refs/ and not end with /");
  // Compared case-insensitively: refs may live on a case-insensitive filesystem.
  if (reserved.has(prefix.split("/")[1]!.toLowerCase()))
    throw new Error(
      `gitClaims refPrefix ${JSON.stringify(prefix)} is inside a reserved Git namespace; use one like refs/machines-dispatch/claims`,
    );
  const ttlMs = options.ttlMs ?? 600_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  for (const [name, value] of [["ttlMs", ttlMs], ["timeoutMs", timeoutMs]] as const)
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error(`gitClaims ${name} must be a positive integer`);
  const now = options.now ?? Date.now;
  // Fetched records land here, never in FETCH_HEAD or remote-tracking branches.
  const tracking = `refs/machines-dispatch-fetched/${createHash("sha256")
    .update(remote)
    .digest("hex")
    .slice(0, 16)}`;
  const env = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    LC_ALL: "C",
    GIT_AUTHOR_NAME: "machines-dispatch",
    GIT_AUTHOR_EMAIL: "machines-dispatch@localhost",
    GIT_COMMITTER_NAME: "machines-dispatch",
    GIT_COMMITTER_EMAIL: "machines-dispatch@localhost",
  };
  async function git(
    args: readonly string[],
    accept: readonly number[] = [0],
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const result = await new Promise<{ code: number; stdout: string; stderr: string }>(
      (done, fail) =>
        execFile(
          "git",
          // No hooks or automatic maintenance may run on the user's repository.
          ["-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", "-c", "maintenance.auto=false", ...args],
          { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
          (error, stdout, stderr) => {
            if (!error) return done({ code: 0, stdout, stderr });
            if (typeof error.code !== "number")
              return fail(
                new Error(
                  `git ${args[0]} ${error.killed ? `timed out after ${timeoutMs} ms` : `failed: ${error.message}`}`,
                ),
              );
            done({ code: error.code, stdout, stderr });
          },
        ),
    );
    if (!accept.includes(result.code))
      throw new Error(
        `git ${args[0]} failed: ${result.stderr.trim() || `exit ${result.code}`}`,
      );
    return result;
  }
  const valid = new Set<string>();
  async function refFor(scope: string): Promise<string> {
    const ref = `${prefix}/${scope}`;
    if (valid.has(ref)) return ref;
    if (
      typeof scope !== "string" ||
      // `${source}/${label}`: a lone segment would clash with its own subrefs.
      !scope.includes("/") ||
      scope.split("/").some((part) => !part || part.startsWith(".")) ||
      (await git(["check-ref-format", ref], [0, 1])).code !== 0 ||
      (await git(["check-ref-format", `${tracking}/${scope}`], [0, 1])).code !== 0
    )
      throw new Error(`Unsafe claim scope ${JSON.stringify(scope)}`);
    valid.add(ref);
    return ref;
  }
  // One operation per ref at a time in this process; the remote arbitrates between processes.
  const queues = new Map<string, Promise<unknown>>();
  function serial<T>(ref: string, operation: () => Promise<T>): Promise<T> {
    const next = (queues.get(ref) ?? Promise.resolve()).then(operation);
    const settled = next.catch(() => {});
    queues.set(ref, settled);
    void settled.then(() => {
      if (queues.get(ref) === settled) queues.delete(ref);
    });
    return next;
  }
  async function read(
    ref: string,
    scope: string,
  ): Promise<{ sha: string; record: ClaimRecord } | undefined> {
    const local = `${tracking}/${scope}`;
    for (let round = 0; round < 2; round++) {
      const fetched = await git(
        ["fetch", "--no-write-fetch-head", "--no-tags", "--no-recurse-submodules", "--no-prune", "--quiet", remote, `+${ref}:${local}`],
        [0, 1, 128],
      );
      if (fetched.code !== 0) {
        // Exit 2: the remote answered and has no such ref.
        const listed = await git(["ls-remote", "--exit-code", remote, ref], [0, 2]);
        if (listed.code === 2) return undefined;
        if (round) throw new Error(`Could not fetch claim ${ref}: ${fetched.stderr.trim()}`);
        continue;
      }
      const sha = (await git(["rev-parse", "--verify", `${local}^{commit}`])).stdout.trim();
      const commit = (await git(["cat-file", "commit", sha])).stdout;
      const split = commit.indexOf("\n\n");
      let parsed: unknown;
      try {
        parsed = JSON.parse(split < 0 ? "" : commit.slice(split + 2));
      } catch {
        throw new Error(`Claim ${ref} at ${sha} is not a claim record`);
      }
      const record = v.safeParse(recordSchema, parsed);
      if (!record.success) throw new Error(`Claim ${ref} at ${sha} is not a claim record`);
      return { sha, record: record.output };
    }
    return undefined;
  }
  let emptyTree: Promise<string> | undefined;
  /** Pushes `record` as a child of `parent`. Returns its sha, or undefined when the ref changed. */
  async function write(
    ref: string,
    parent: string | undefined,
    record: ClaimRecord,
  ): Promise<string | undefined> {
    emptyTree ??= git(["hash-object", "-w", "-t", "tree", "/dev/null"]).then((r) => r.stdout.trim());
    const tree = await emptyTree.catch((cause) => {
      emptyTree = undefined;
      throw cause;
    });
    const sha = (
      await git([
        "commit-tree",
        "--no-gpg-sign",
        tree,
        ...(parent ? ["-p", parent] : []),
        "-m",
        JSON.stringify(record),
      ])
    ).stdout.trim();
    const pushed = await git(
      [
        "push",
        "--porcelain",
        "--no-verify",
        "--no-follow-tags",
        "--no-signed",
        "--no-recurse-submodules",
        // An empty expectation means the ref must not exist yet.
        `--force-with-lease=${ref}:${parent ?? ""}`,
        remote,
        `${sha}:${ref}`,
      ],
      [0, 1],
    );
    const line = pushed.stdout
      .split("\n")
      .map((entry) => entry.split("\t"))
      .find((fields) => fields.length >= 3 && fields[1]!.endsWith(`:${ref}`));
    if (pushed.code === 0 && line && line[0] !== "!") return sha;
    if (line?.[0] === "!" && line[2]!.startsWith("[rejected]")) return undefined;
    // A racing update can also fail on the remote's own ref lock. It is a lost
    // race only if the ref moved; a declined hook or hidden ref is an error.
    if (line?.[0] === "!" && line[2]!.startsWith("[remote rejected]")) {
      const listed = await git(["ls-remote", remote, ref]);
      const moved = listed.stdout
        .split("\n")
        .find((entry) => entry.endsWith(`\t${ref}`))
        ?.split("\t")[0];
      if ((moved ?? "") !== (parent ?? "")) return undefined;
    }
    throw new Error(
      `git push of claim ${ref} failed: ${line?.[2] ?? (pushed.stderr.trim() || `exit ${pushed.code}`)}`,
    );
  }
  function lease(scope: string, key: string, holder: Holder, expiresAt: string, ref: string, commit: string): Lease {
    return { scope, key, holder, expiresAt, ttlMs, data: { ref, commit } };
  }
  function parseLease(value: Lease) {
    const parsed = v.parse(leaseSchema, value);
    if (parsed.data.ref !== `${prefix}/${parsed.scope}`)
      throw new Error(`Lease for ${parsed.data.ref} does not belong to ${prefix}`);
    return parsed;
  }
  /** Ends a lease this holder still has; `finished` also records its key. */
  async function release(value: Lease, finished: boolean): Promise<void> {
    const held = parseLease(value);
    const ref = held.data.ref;
    return serial(ref, async () => {
      for (let round = 0; round < rounds; round++) {
        const current = await read(ref, held.scope);
        const record = current?.record;
        // Only the record version this lease names may be released.
        if (!current || !record || current.sha !== held.data.commit) {
          // A finish whose push landed but whose answer was lost is already done.
          if (!finished || record?.finished.includes(held.key)) return;
          throw new ClaimLost(record?.holder ?? undefined);
        }
        const next: ClaimRecord = {
          version: 1,
          scope: held.scope,
          ...(record.key === undefined ? {} : { key: record.key }),
          holder: null,
          finished:
            finished && !record.finished.includes(held.key)
              ? [...record.finished, held.key]
              : record.finished,
        };
        if (await write(ref, current.sha, next)) return;
      }
      throw new Error(`Claim ${held.scope} kept changing; try again`);
    });
  }
  return {
    async acquire(claim: ClaimRequest): Promise<Acquisition> {
      const holder = v.parse(holderSchema, claim.holder);
      const ref = await refFor(claim.scope);
      return serial(ref, async () => {
        for (let round = 0; round < rounds; round++) {
          const current = await read(ref, claim.scope);
          const record = current?.record;
          const time = now();
          if (
            record?.holder &&
            !same(record.holder, holder) &&
            record.expiresAt !== undefined &&
            Date.parse(record.expiresAt) > time
          )
            return { acquired: false, holder: record.holder, expiresAt: record.expiresAt };
          if (!claim.retry && record?.finished.includes(claim.key))
            return { acquired: false, finished: true };
          const expiresAt = new Date(time + ttlMs).toISOString();
          const commit = await write(ref, current?.sha, {
            version: 1,
            scope: claim.scope,
            key: claim.key,
            holder,
            expiresAt,
            finished: record?.finished ?? [],
          });
          if (commit)
            return { acquired: true, lease: lease(claim.scope, claim.key, holder, expiresAt, ref, commit) };
        }
        throw new Error(`Claim ${claim.scope} kept changing; try again`);
      });
    },
    async renew(value: Lease): Promise<Renewal> {
      const held = parseLease(value);
      const ref = held.data.ref;
      return serial(ref, async () => {
        for (let round = 0; round < rounds; round++) {
          const current = await read(ref, held.scope);
          const record = current?.record;
          // The record must still be the version this lease names. Any later
          // write (a takeover, a release, even this holder's own renewal or
          // reacquisition) makes the lease obsolete.
          if (!current || !record || current.sha !== held.data.commit)
            return { ok: false, reason: "lost", ...(record?.holder ? { holder: record.holder } : {}) };
          const expiresAt = new Date(now() + ttlMs).toISOString();
          const commit = await write(ref, current.sha, { ...record, expiresAt });
          if (commit)
            return { ok: true, lease: lease(held.scope, held.key, held.holder, expiresAt, ref, commit) };
        }
        throw new Error(`Claim ${held.scope} kept changing; try again`);
      });
    },
    finish: (value) => release(value, true),
    abandon: (value) => release(value, false),
  };
}
