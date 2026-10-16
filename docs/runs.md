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

- Local deduplication covers one daemon state directory.
- Git moves ticket files; it does not coordinate independent computers. Two
  computers can execute the same eligible ticket. Use explicit work assignment
  or tracker-specific coordination when needed.
- The daemon performs no repository locking, Git synchronization, cleanliness
  checks or automatic worktree creation.
