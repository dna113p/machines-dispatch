# Machines Dispatch

A local daemon that runs Machines from registered ticket sources. Each source
owns its ticket format, dependencies, and result updates. Machines own the actual
workflow: implementation, research, reviews, repository safety, and cleanup.

Adapters read [tk](https://github.com/wedow/ticket)'s native Markdown files and
GitHub issues. Neither requires another ticket database; tk needs no running
`tk` process.
The daemon supports Linux and Node 24 or newer.

## Build from source

This checkout depends on the Machines 0.4 host interface, which is published on
npm:

```sh
npm install
npm run check
npm run build
node dist/src/cli.js help
```

To run against an unreleased Machines checkout instead, replace the installed
copy with a local build:

```sh
node scripts/install-local.mjs ../machines
```

The script builds and installs a packed Machines package without saving
machine-specific paths in package metadata. Neither package is published by
these commands.

## Register a ticket source

Create `machines-dispatch.config.ts`:

```ts
export default ({ tk, github }) => [
  tk({
    id: "op",
    cwd: "./op",
    ticketsDir: ".tickets",
    defaultMachine: "research",
  }),
  github({
    id: "backend",
    cwd: "./op",
    repository: "owner/backend",
    requiredLabels: ["status:ready", "automation:machines"],
    excludedLabels: ["status:needs-scoping"],
    allowedAuthorAssociations: ["OWNER", "MEMBER", "COLLABORATOR"],
    defaultMachine: "implement",
    input: { repository: "backend" },
  }),
];
```

`cwd` is relative to the configuration file; `ticketsDir` is relative to `cwd`.
Optional `agents` maps Machine roles to existing Agent preset names. Optional
`home` selects a Machines configuration home, relative to `cwd`. Otherwise normal
Machines global/project discovery applies. Restart to reload registrations.

Optional `allowedMachines` on a tk registration lists the only Machine names it
may launch; when `defaultMachine` is also set, it must be in the list. A ticket
selecting any other Machine is not admitted and is reported by `sources`. The
list also applies to `route` outcomes. Without it, a tk source launches whatever
its tickets name. The GitHub source is unaffected: its issues cannot select
Machines.

One registration can cover a workspace containing several repositories. Put its
shared tickets in one directory, and include repository names or relative paths
in ticket input. The Machine decides how to work in those repositories.

Configuration and discovered Machine files are trusted executable code. tk tickets
select exact catalog names; ticket-supplied file paths are not executed. GitHub
issues cannot select Machines, Agent bindings, or execution paths; their trusted
registration supplies these settings.

## Start and inspect

```sh
machines-dispatch start --config ./machines-dispatch.config.ts
machines-dispatch sources
machines-dispatch status
machines-dispatch status ATTEMPT_ID --json
machines-dispatch logs ATTEMPT_ID
machines-dispatch respond ATTEMPT_ID REQUEST_ID approve
machines-dispatch cancel ATTEMPT_ID
machines-dispatch retry ATTEMPT_ID
machines-dispatch update
machines-dispatch stop
```

Use `node dist/src/cli.js` in place of `machines-dispatch` when working directly from
this checkout. `daemon --config ...` runs in the foreground for a service manager
or debugging. `start` detaches and returns after the local socket becomes ready.
All commands accept `--state-dir`; clients must use the daemon's state directory.
Add `--json` for compact machine-readable output.

For a fresh installation, state defaults to `$XDG_STATE_HOME/machines-dispatch`, or
`~/.local/state/machines-dispatch`. The directory contains the local control socket,
execution journal, singleton lock database, and background daemon log. Pending
Human questions and Agent observations are available through status and logs.
No credentials or home-directory paths are added to ticket files automatically.
Machine-authored summaries are written as supplied.

Closing a client does not stop runs. Stopping the daemon interrupts runs with a
live process and terminates their ordinary owned subprocesses. Sleeping attempts
stay sleeping. Deliberately detached or otherwise uncooperative processes retain
Machines' existing lifecycle limitations.

Each attempt's run also publishes Machines run status, by default in Machines'
standard run-status directory. Setting `MACHINES_RUN_STATUS_DIR` to a directory
in the daemon's environment moves it to that directory; setting it to `off` or an
empty value turns publishing off. A coding agent's status line can show the run.
The run is labelled with what the source says it is for (a tk ticket's id and
title, a GitHub issue's reference and title), or with the work item's label. A
session that did not start the run pulls it in with
`machine watch <start of the label>`. Run `machine ui`, Machines' CLI command,
in the workspace or with `--project <dir>` to open a local page that shows each
attempt's run with its Machine's graph, its current state, and the states it
entered. When the daemon's `MACHINES_RUN_STATUS_DIR` moves the directory, run
`machine ui` with the same value.

With publication on and a writable run-status directory, Dispatch starts runs
with sleep enabled. At a Human request or future timed wait, the run checkpoints
and its process exits. The attempt becomes `sleeping`, with `delivery: "none"`;
the ticket stays open and receives no result note. `status` shows its `runId`
and either `sleeping.human.requestId` or `sleeping.due`. The published run record
has `continuedBy: "host"`.

Answer a sleeping Human request with `machine respond <run-id> <request-id>`
using the daemon's `MACHINES_RUN_STATUS_DIR` when it selects a different directory.
`machines-dispatch respond` refuses sleeping attempts and prints that command.
When publication is off or the directory cannot be written, runs stay in-process;
`status` reports the reason in `cannotSleep`. A Human request then has status
`waiting` and is answered with `machines-dispatch respond` as before.

A sleeping attempt counts as active: it prevents overlapping work on that ticket,
blocks `retry`, and keeps the daemon from being idle for updates. A restart leaves
it sleeping and writes nothing back. `cancel` writes a cancelled result to the
ticket, but its Machines run stays sleeping and Dispatch will never wake that
cancelled attempt. A person can run `machine continue <run-id>` outside Dispatch.
Automatic waking is deferred to org-38; answering a sleeping request or continuing
its run manually currently leaves the Dispatch attempt sleeping and the ticket open.

## Updates

The daemon runs every Machine with its own installed copy of `@dna113p/machines`.
When it starts, and every 30 minutes after, it asks npm (`npm view`, with your npm
configuration and registry) for the newest stable release inside the version range
in this package's `dependencies`. The copy is current when it has that version and
npm installed it from a registry. A local build, such as the tarball
`scripts/install-local.mjs` installs, is never current, even with the same version
number. Machines Dispatch itself is not on npm; its own updates are not covered.

One named export in the configuration file selects the mode:

```ts
export const update = "install";
```

- `"check"`, the default: report a newer release in `status`, in the `update`
  command, and once in the daemon's output. Nothing is installed.
- `"install"`: also install it and restart, as described below.
- `"off"`: check nothing.

`machines-dispatch update` checks now and prints the update state, which `status`
also shows under `update`. `machines-dispatch update --install` installs the
update it finds even in `"check"` mode; in `"off"` mode it answers that updates
are off. A failed check or install is recorded in that state, never stops work,
and is tried again at a later check. That holds for `update --install` too: the
request stands for the version it found, and never extends to a later release.

Installing waits until the daemon is idle: no attempt is starting, running,
waiting for a Human, or sleeping, and no result is still being written back. It
then holds new admissions, runs `npm install` for that exact version beside the copy in use, and
restarts in place with the same command line and process ID, so a service manager,
a foreground `daemon`, and a detached `start` all continue unchanged. If the
install fails, or leaves anything but that release, the daemon does not restart and
carries on with the copy it has loaded. A release that is on disk but not yet
loaded, after such a failure or an `npm install` by hand, still counts as an
available update until the daemon restarts. In-place restart needs
`process.execve`; without it `"install"` acts as `"check"` and the update state
says so.

`"install"` replaces a local build with the published release: use `"check"` or
`"off"` while testing an unreleased Machines checkout. It also means newly
published Machines code runs unattended, with the daemon's access, as soon as the
daemon is idle. A daemon started with `startDaemon({ sources })` checks nothing
unless its `update` option asks.

## Tickets and eligibility

Use `tk` normally to create tickets and manage dependencies. Add optional fields
through your editor:

```yaml
---
id: op-123
status: open
deps: [op-100]
machine: implement
input:
  task: Add the new endpoint
  acceptanceCriteria:
    - The integration check passes
  repositories: [api, web]
  attachments: [designs/request.png]
agents:
  implementer: codex
---
# Add the endpoint

Further context, design notes, and acceptance criteria belong here.
```

Every unfinished, unblocked ticket is considered: both `open` and `in_progress`,
matching `tk` readiness. The tk adapter has no automation label; the daemon has
no concurrency limit.
Register only ticket sources you intend to automate. Tickets without a Machine
use the registration default; without either selection they show an error.
An invalid explicit Machine never falls back to the default.

Missing dependencies, cycles, malformed tickets, and invalid selections are
reported by `sources`. Other eligible work continues. Machine preparation checks
Agent bindings; each definition validates its own input shape before Operations.
Validation/import failures that happen before admission are reconsidered on a
later poll. A failed hosted attempt requires deliberate retry after fixing it,
unless a tk edit creates new work under the resume rule below.

Both adapters supply the same input envelope:

```ts
{
  ticket: { id, source, title, body, metadata },
  input: /* tk input field, or GitHub registration input; otherwise null */
}
```

Paths in `input` are references, resolved by the Machine relative to its configured
workspace. The adapter neither copies attachments nor makes a text-only Agent
multimodal. A ticket's input is snapshotted for each attempt.

## GitHub eligibility and authentication

The GitHub adapter supports github.com repositories. Every `requiredLabels` entry
must be present, and no `excludedLabels` entry may be present. At least one required
label is mandatory. Pull requests are excluded. Labels are matched exactly; the
adapter never creates or changes labels. A single trusted `defaultMachine` is
required, with optional `input`, `agents`, and `home` for the whole registration.

Labels alone do not establish that the issue text is trusted. Anyone who can open
or edit an issue controls its title and body, including after a maintainer applies
the labels, and that text reaches the Machine's Agent as task input. Optional
`allowedAuthorAssociations` lists the GitHub
[`author_association`](https://docs.github.com/en/rest/issues/issues) values
admitted, for example `["OWNER", "MEMBER", "COLLABORATOR"]`. It must be a
non-empty list of non-empty strings, matched exactly. When it is set, an issue
whose author association is unlisted or absent is reported in source diagnostics
instead of being admitted, and `prepare` rechecks it before launch. The value
comes from the issue the adapter already reads; no additional request is made.
When the option is omitted, issues from any author are admitted.

The adapter checks GitHub's [native issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)
during discovery, preparation, and result delivery. A prerequisite satisfies this
adapter only when closed with `state_reason: "completed"`; open, cancelled,
duplicate, and unknown/legacy closure reasons stay blocked. Remove or reconcile an
obsolete relationship in GitHub explicitly. Markdown checklists and links are not
dependencies, and the adapter does not coordinate prerequisites in other trackers.
Dependency-read errors stop admission rather than treating unknown work as ready.

A GitHub ticket's `id` is `owner/repo#number`; `metadata` contains `repository`,
`number`, `nodeId`, `url`, and sorted label names. Stable native issue IDs determine
execution keys. Editing titles, bodies, labels, comments, or timestamps does not
create another request. `prepare` rereads task content, labels, identity, and
prerequisites before allowing launch. Repository renames and issue transfers are
rejected for explicit reconfiguration. Local deduplication does not claim issues
against another daemon or computer.

Authentication uses `GH_TOKEN`, then `GITHUB_TOKEN`, then a lazily invoked
`gh auth token --hostname github.com`. The authenticated account needs repository
access and Issues read/write permission for result comments and closure. No token
is read and no subprocess is started when the adapter is constructed. Optional
`token` and `fetch` overrides support controlled integrations and offline tests;
prefer environment or gh authentication over putting credentials in config files.
Requests use only `https://api.github.com`, reject redirects, and time out after
20 seconds. Paginated issue, dependency, and comment reads validate next-page
resources and filters, including GitHub's numeric repository aliases and opaque
cursors; requests remain on the configured owner/repo endpoint. [Rate-limit responses](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
pause later requests until retry/reset deadlines with increasing backoff; they do
not keep the daemon asleep. Rate or authentication failures remain visible in
source/delivery diagnostics.

## Return a ticket outcome

Define the Machine's top-level XState `output` as one of these JSON objects:

```ts
{ action: "complete", summary: "Verified and approved." }
{ action: "hold", summary: "Research complete; a decision is needed." }
{ action: "route", machine: "implement", input: { task: "..." }, summary: "Ready to implement." }
```

`complete` records the summary and closes the ticket. `hold` records findings and
leaves it open without launching it again locally until retry or a qualifying tk
resume edit. For tk, `route` appends findings,
updates its Machine and optional input/agents, and creates a new execution request.
GitHub supports only `complete` and `hold`; `route` produces a visible writeback
conflict instead of inventing tracker metadata or silently ignoring routing.
When a tk registration sets `allowedMachines`, a `route` naming a Machine outside
the list is also a writeback conflict, and the ticket is left unmodified.
A missing or malformed outcome is retained as a writeback conflict; it never
closes the ticket. A Machine's final state alone is not a ticket outcome.

The tk adapter manages `machines-dispatch-request` for routed work and puts attempt
markers in result notes. Replaying a writeback does not append duplicate notes.
Ordinary edits and polling do not rerun an already-recorded request. For tk,
setting frontmatter `input.resume: true` opts into automatic resume: editing the
ticket's content creates a new execution key, so a parked ticket launches again
without `retry`. The Machine receives `resume: true` in `input.input`. Unchanged
content does not launch again, and the daemon never sets `resume` itself.
Removing `input.resume` or setting it to `false` keeps an attempted request parked,
even if it first ran with resume enabled. Explicit `retry` still works.

Body edits count even below a daemon note: owners can append answers at the end
of the ticket. Only the daemon's marked `## Machines Dispatch` (or legacy
`## Auto Machines`) heading, each attempt marker, and its following summary line
are excluded from the content comparison. Writeback flattens multiline summaries
onto that single line. Unmarked headings and later lines remain content. Frontmatter
fields the daemon manages (`status`, `machine`, `input`, `agents`,
`machines-dispatch-request`, and `auto-machines-request`) are also excluded.
Changing only those fields does not count as a content edit, although enabling
`input.resume: true` changes the key from its ordinary form. Other frontmatter
fields do count. Writeback alone therefore does not trigger another resume.

The resume rule also applies after failed, cancelled, or interrupted attempts;
restoring content whose key was already attempted does not launch it again.
An eligible ticket already carrying `input.resume: true` gets a new key once
when upgrading from a version without this rule. Use `retry` for deliberate
re-execution of an eligible ticket, including an unchanged or reopened ticket.

Ticket changes detected before writeback produce a visible conflict instead of
replacing newer content. A qualifying content edit with `input.resume: true`
can launch another attempt once that conflict is recorded; the earlier result
stays local. Inspect the local result and reconcile the ticket; do
not rerun a completed Machine merely to publish its old result. Transient I/O
failures retry automatically, independently of execution. Brief metadata writes
serialize within the adapter; Machine runs remain parallel. Independent editors
and `tk` processes do not share that write queue, so simultaneous external edits
are still optimistic rather than a cross-process transaction.

GitHub delivery posts a comment containing the attempt marker and summary. A
`complete` then rereads the assignment before a state-only update to closed /
completed. Replaying an uncertain comment or closure response finds the comment
and finishes any remaining closure without duplicating it. Edited result comments,
changed assignments, or issues closed without completion require intervention.
The adapter preserves the issue body and user labels. GitHub's separate comment
and state requests are not a transaction: external edits in the final read/write
window remain optimistic, as with tk. A pending result comment can therefore be
visible while closure is still pending or conflicted.

Snapshots retain the open issue's state reason. If an issue is newly reopened
before unfinished delivery retries, the adapter reports a conflict instead of
closing it again. A deliberate new attempt can work on an already-reopened issue.
An identical close/reopen cycle for a task admitted already reopened cannot be
distinguished from pending closure using current issue state alone; this adapter
does not read issue event history.

## Recovery and multiple computers

The journal records an attempt before launch, and records its result before
updating tickets. Restart preserves sleeping attempts without writeback. It marks
attempts that had a live process interrupted and invalidates their old Human
responses. It never automatically replays uncertain work. Inspect
prior effects before retrying; a retry is a new attempt, not workflow resumption.

Local deduplication covers one daemon state directory. Git moves ticket files;
it does not coordinate independent computers. Two computers can execute the same
eligible ticket. Use explicit work assignment or tracker-specific coordination
when needed. The daemon performs no repository locking, Git synchronization,
cleanliness checks, or automatic worktree creation.

## Custom sources

The exported `WorkSource` interface has three operations:

- `scan()` returns eligible items and optional diagnostic messages.
- `prepare(item)` rechecks eligibility and returns Machines launch parameters,
  or `undefined` if the item changed or is no longer eligible.
- `apply(report)` interprets a terminal execution report and updates the source.

Each item has a stable execution `key`, a stable ticket identifier in `label`, and
an opaque JSON `ref`. A new execution request needs a new key; changing unrelated
metadata must not generate one. `prepare` must not execute workflow effects.
Only exact discovered Machine names are accepted in its launch request.

An item may also declare `supersedes`, additional execution keys consumed by its
attempt within the same source. Tk uses this to keep the ordinary request consumed
when resume is later disabled. Explicit retries bypass this deduplication.

`apply` must tolerate retries with the same `attemptId`. Throw `ReportConflict`
for invalid output or changes requiring intervention; ordinary errors retry.
A source owns its graph and output convention. A custom adapter can therefore
use another tracker without teaching the daemon its ticket schema.

Configurations can return any conforming source alongside `tk(...)` and
`github(...)` registrations.
The exported `request` client lets a future MCP or Pi adapter use the same daemon;
the first version supplies CLI access rather than separate harness plugins.

## Auto Machines compatibility

The package also installs an `auto-machines` command for the same executable.
When only an `auto-machines` state directory exists, clients use it in place;
when both exist as separate directories, pass `--state-dir`. Tickets carrying
`auto-machines-request` metadata or `<!-- auto-machines:... -->` receipts are
still recognized; new writes use the `machines-dispatch` forms.

## Demonstration and checks

Copy `examples/demo` into a temporary workspace, then start its configuration.
Its fake research Agent routes a ticket to a fake implementation Agent, which
asks for Human approval. Set `MACHINES_RUN_STATUS_DIR=off` in the daemon's
environment to answer it in-process with `machines-dispatch respond`: `approve`
closes the ticket and `hold` retains it for attention. With publication on, its
Human request sleeps as described above. The demo uses no model credentials or
network calls.

```sh
npm run check
npm run build
npm run smoke:package
npm run test:tk
```

The package smoke installs real tarballs into a temporary consumer and completes
the demo through the installed CLI. `test:tk` downloads pinned upstream commit
`194b71a8bbc3771da1ce9f579395937c976bbddc` and checks file interoperability. Other
tests use local fake runners, temporary tickets, and fake GitHub transports; they
do not mutate live GitHub issues. Real agent workflows need
their harnesses and credentials configured explicitly.
