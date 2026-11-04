# Runs: status, sleep, recovery

The detail behind the README's [Watching and answering runs](../README.md#watching-and-answering-runs)
and [Recovery and multiple computers](../README.md#recovery-and-multiple-computers).

## Run status

Each attempt's run publishes Machines run status, by default in Machines'
standard run-status directory.

- Setting `MACHINES_RUN_STATUS_DIR` in the daemon's environment moves it to
  that directory. Setting it to `off` or an empty value turns publishing off.
- A run is labelled with what the source says it is for (a tk ticket's id and
  title, a GitHub issue's reference and title), or with the work item's label.
- A coding agent's status line can show the run. A session that did not start
  it pulls it in with `machine watch <start of the label>`.
- `machine ui`, Machines' own command, run in the workspace or with
  `--project <dir>`, opens a local page that shows each attempt's run with its
  Machine's graph, its current state and the states it entered. When the
  daemon's `MACHINES_RUN_STATUS_DIR` moves the directory, run `machine ui` with
  the same value.

## Sleeping runs

With publication on and a writable run-status directory, Dispatch starts runs
with sleep enabled. At a Human request or a future timed wait, the run
checkpoints and its process exits.

- The attempt becomes `sleeping`, with `delivery: "none"`. The ticket stays
  open and receives no result note.
- `status` shows its `runId` and either `sleeping.human.requestId` or
  `sleeping.due`.
- The published run record has `continuedBy: "host"`.

**Answering.**

- Answer a sleeping Human request with `machine respond <run-id> <request-id>`,
  using the daemon's `MACHINES_RUN_STATUS_DIR` when it selects a different
  directory.
- `machines-dispatch respond` refuses sleeping attempts and prints that
  command.
- When publication is off or the directory cannot be written, runs stay
  in-process and `status` reports the reason in `cannotSleep`. A Human request
  then has status `waiting` and is answered with `machines-dispatch respond`.

**How a sleeping attempt counts.**

- It counts as active: it prevents overlapping work on that ticket, and blocks
  `retry`.
- It counts as idle for updates.
- A restart preserves it instead of interrupting it.
- `cancel` writes a cancelled result to the ticket, but the Machines run stays
  sleeping and Dispatch never wakes that cancelled attempt. A person can run
  `machine continue <run-id>` outside Dispatch.

## Waking

On each poll, Dispatch continues its own sleeping runs once they are answered
or due, keeping the same attempt and run id.

- A repeating wait sleeps again as that attempt. A finished run is written back
  to the ticket as usual.
- A failed wake leaves the attempt sleeping, shows the error in `wakeError` in
  `status`, and is retried no sooner than the next poll interval. The error is
  logged only when it changes. Use `cancel` to stop retrying a failed wake.

## Runs continued outside Dispatch

When a sleeping run finishes outside Dispatch, whether completed or failed,
its attempt becomes `continued-outside`.

- `status` shows the record's final state and its summary in `note`, or its
  `error`.
- There is no writeback: the ticket stays open, and the attempt no longer
  counts as active, so `retry` and updates can proceed.

Dispatch also marks a sleeping attempt `continued-outside` with the note "run
record not found" when its record file is gone from the directory stored when
it slept, provided that directory still exists, is readable, and is still the
daemon's current run-status directory.

- Unreadable records and missing or changed directories leave the attempt
  sleeping.
- Older attempts without a stored directory cannot be marked missing.

## Stopping and restarting

- Closing a client does not stop runs.
- Stopping the daemon interrupts runs with a live process and terminates their
  ordinary owned subprocesses. Sleeping attempts stay sleeping.
- Deliberately detached or otherwise uncooperative processes keep Machines'
  existing lifecycle limitations.

## Recovery

The journal records an attempt before launch, and records its result before
updating tickets.

- A restart preserves sleeping attempts without writeback.
- A stop marks an unfinished, non-sleeping run `interrupted` with
  `cutOff: true`, invalidates its old Human responses, and defers writeback
  until the next startup.

**Continuing a cut-off run.** On startup, Dispatch automatically continues a
cut-off run it started, once, from its checkpoint, keeping the same attempt and
run id.

- It records `continued: 1` before continuing and clears `cutOff`.
- The interrupted state is entered again: inspect effects that state may
  repeat.
- A second cut-off is written back as interrupted, with the reason shown in
  `status`, and is not continued automatically.
- Without run-status publication, a run record or a usable checkpoint, the
  attempt is written back as interrupted. Dispatch never continues an
  unrecorded run.

Inspect prior effects before retrying: a retry is a new attempt, not workflow
resumption.

## Multiple computers

Local deduplication covers one daemon state directory. Git moves ticket files;
it does not coordinate independent computers. **Without claims, two computers
can execute the same eligible ticket**, and a request one computer finished
runs again on another whose copy of the ticket is stale.

### Claims

A source registered with `claims` asks a shared claim store before launching:

```ts
export default ({ tk, gitClaims }) => [
  tk({ id: "op", cwd: "./op", claims: gitClaims({ cwd: "./op" }) }),
];
```

- **Scope and key.** A claim's scope is `<source id>/<ticket id>` (for GitHub,
  `<source id>/<owner>/<repo>#<number>`). Its key is the request being run:
  the same key that local deduplication uses.
- **Admission.** After the source's checks, and before the attempt is
  recorded, the daemon acquires the claim. If another daemon holds a live
  lease, the ticket is not launched and `sources` shows
  `T-42: claimed by <host> until <time>`; the daemon asks again after that time
  (at least 30 seconds later). A request already finished elsewhere shows
  `T-42: already finished on another computer`, checked again every 5 minutes.
  If the store cannot be reached, nothing launches (`claim check failed, not
  launched: ...`) and the next poll asks again.
- **Holding.** The attempt keeps the claim from admission until its result is
  written back, including while it sleeps or waits for a Human. The daemon
  renews it when less than half its TTL remains. `status` shows each attempt's
  `claim`: its `state` (`held`, `finishing`, `done` or `lost`), and its lease's
  `holder` and `expiresAt`.
- **Finishing.** Once the result is written back to the local ticket, the key
  is recorded as finished in the claim and the lease ends. Every attempt that
  ran consumes its key this way, whether it completed, failed, was cancelled
  or interrupted. A ticket with a new request key, such as after `route`, can
  then be claimed by any daemon.
- **Retry.** `retry` ignores finished keys, so the same request runs again,
  but still waits for a live lease held elsewhere.
- **Losing a claim.** A daemon that stops renewing (stopped, crashed, or cut
  off from the remote) loses the ticket once its lease expires, and another
  daemon may take it over. When the first daemon next renews, it learns the
  claim is lost: a running attempt is stopped, a cut-off run is not continued,
  a sleeping run is not woken. The attempt becomes `interrupted` with
  `Claim lost to <host>; another computer took this ticket`, and that note is
  written to the local ticket. The loser never records the key as finished.
- **Restart.** Claims and their leases are stored with the attempts. On
  restart, a cut-off run continues, and a sleeping run wakes, only after its
  claim is renewed. If the attempt's source was removed from the
  configuration, or no longer has `claims`, the attempt cannot renew: it stays
  stopped (not continued, woken or finished), `sources` and the attempt's
  `claim.error` report `claim store unavailable: ...`, and it resumes once
  claims are configured again.
- **Enabling claims.** When `claims` is added to a source, its cut-off and
  sleeping attempts from before have no claim. Each first acquires one, and
  continues or wakes only once it holds it. If another daemon holds the ticket
  or already finished the request, the attempt is not resumed: it becomes
  `interrupted` with `Claims were enabled after this attempt started, ...`,
  and that note is written to the local ticket. If the store cannot be
  reached, it stays stopped and `sources` says so until the next try succeeds.
  Attempts that had already finished keep no claim, so another computer does
  not see their requests as finished.
- **Identity.** Each state directory has a random daemon id, kept in its
  journal; claims name it with the attempt id and the host name.

### The Git claim store

`gitClaims` keeps claims as refs on a Git remote that every computer can push
to. Its options:

| Option | Default | Meaning |
| --- | --- | --- |
| `cwd` | required | A Git checkout, relative to the configuration file |
| `remote` | `"origin"` | Remote name or URL holding the claims |
| `refPrefix` | `refs/machines-dispatch/claims` | Where claim refs live; never under `refs/heads`, `refs/tags`, `refs/remotes`, `refs/notes` or other Git namespaces |
| `ttlMs` | 10 minutes | How long one acquisition or renewal lasts |
| `timeoutMs` | 30 seconds | Longest one `git` command may take |

- One ref per scope, `<refPrefix>/<scope>`. Scopes that `git check-ref-format`
  rejects are refused.
- Each record is a commit with an empty tree whose message is JSON:
  `{"version":1,"scope":...,"key":...,"holder":{"daemon","attempt","host"} or null,"expiresAt":...,"finished":[keys]}`.
  Each update is a child of the previous one, so `git log` on the ref is the
  claim's history.
- Writes are pushes with `--force-with-lease` on the commit just read (or on
  the ref not existing), so the remote compares and swaps. A rejected push
  means another daemon changed the record: the store reads it again and
  decides again; it never overwrites.
- A lease names the commit it was written as. Renewing or finishing it
  succeeds only while the ref still points at that commit; any later write,
  even by the same daemon, makes it obsolete. A renewal whose push reached the
  remote but whose answer was lost therefore counts as a lost claim on the
  next poll: the attempt stops rather than risk running twice.
- Records are fetched into `refs/machines-dispatch-fetched/...` in the local
  checkout. Claims never touch branches, `HEAD`, the index, the working tree or
  `FETCH_HEAD`, never run hooks, and push nothing but claim refs. `git` runs
  without a shell and with `GIT_TERMINAL_PROMPT=0`, so the remote's
  credentials must work without prompting.
- **Clock skew.** Expiry compares the writer's clock with the reader's. Clocks
  that differ by more than a fraction of the TTL let a lease look expired
  early, and so let two daemons run the same ticket. Keep clocks synchronised
  (NTP) and the TTL well above any skew.
- **Partitions.** A daemon cut off from the remote keeps running its attempt
  and retries renewal on each poll. If the outage outlasts the TTL, another
  daemon may take the ticket over; the first finds out when it reconnects.

The daemon still performs no other repository locking, Git synchronization of
ticket files, cleanliness checks or automatic worktree creation.
