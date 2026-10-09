# Machines Dispatch

A local daemon that runs Machines from registered ticket sources. Each source
owns its ticket format, dependencies, and result updates. Machines own the actual
workflow: implementation, research, reviews, repository safety, and cleanup.

Adapters read [tk](https://github.com/wedow/ticket)'s native Markdown files and
GitHub issues. Neither requires another ticket database; tk needs no running
`tk` process.
The daemon supports Linux and Node 24 or newer.

## Build from source

This checkout depends on the new Machines 0.3 host interface. Until that Machines
version is published, bootstrap against a local Machines checkout:

```sh
node scripts/install-local.mjs ../machines
npm run check
npm run build
node dist/src/cli.js help
```

The bootstrap script builds and installs a packed Machines package without saving
machine-specific paths in package metadata. After Machines 0.3 is available on
npm, ordinary `npm install` works. Neither package is published by these commands.

## Rename from Auto Machines

The canonical repository is `dna113p/machines-dispatch`, the package is
`@dna113p/machines-dispatch`, and the command is `machines-dispatch`.
Update package imports and dependency declarations to the new package name.
This source rename does not publish an npm release or rename an existing npm
registry entry. Use the local build/install workflow above until published.

The package retains `auto-machines` as a compatibility command pointing to the
same executable. Existing config filenames continue to work with `--config`;
new examples use `machines-dispatch.config.ts`. Configs with runtime imports of
`@dna113p/auto-machines` need their imports/dependency updated; the old package
specifier is not an alias for the new package.

Fresh installations default to the new state directory. When only the legacy
`auto-machines` state directory exists, clients reuse it in place, including its
journal and daemon socket. No automatic move, database copy, or service restart
occurs. If both old and new directories exist and are not aliases for the same
directory, pass `--state-dir` explicitly rather than silently choosing one.
Help and explicit state-directory commands work even in that situation. To move
state later, stop its owning daemon first and move the complete directory;
never merge independent execution journals or copy a live SQLite database.

Previously written `auto-machines-request` metadata and `<!-- auto-machines:... -->`
receipts remain recognized. New writes use `machines-dispatch-request` and
`<!-- machines-dispatch:... -->`. Routing replaces the legacy request field;
conflicting old/new request values require reconciliation. Existing tickets,
comments, summaries, and attempt IDs are not rewritten simply to change branding.
Do not concurrently run old/new installations against separate state directories
for the same work: local deduplication still covers only one state directory.

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
Legacy state is reused as described in the rename section above.

Closing a client does not stop runs. Stopping the daemon interrupts its runs and
terminates their ordinary owned subprocesses. Deliberately detached or otherwise
uncooperative processes retain Machines' existing lifecycle limitations.

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
later poll. A failed hosted attempt requires deliberate retry after fixing it.

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
leaves it open without launching it again locally. For tk, `route` appends findings,
updates its Machine and optional input/agents, and creates a new execution request.
GitHub supports only `complete` and `hold`; `route` produces a visible writeback
conflict instead of inventing tracker metadata or silently ignoring routing.
A missing or malformed outcome is retained as a writeback conflict; it never
closes the ticket. A Machine's final state alone is not a ticket outcome.

The tk adapter manages `machines-dispatch-request` for routed work and puts attempt
markers in result notes. Replaying a writeback does not append duplicate notes.
Ordinary edits and polling do not rerun an already-recorded request. Use `retry`
for deliberate re-execution of an eligible ticket, including a reopened ticket.

Ticket changes detected before writeback produce a visible conflict instead of
replacing newer content. Inspect the local result and reconcile the ticket; do
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
updating tickets. Restart marks unfinished attempts interrupted and invalidates
old Human responses. It never automatically replays uncertain work. Inspect
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

`apply` must tolerate retries with the same `attemptId`. Throw `ReportConflict`
for invalid output or changes requiring intervention; ordinary errors retry.
A source owns its graph and output convention. A custom adapter can therefore
use another tracker without teaching the daemon its ticket schema.

Configurations can return any conforming source alongside `tk(...)` and
`github(...)` registrations.
The exported `request` client lets a future MCP or Pi adapter use the same daemon;
the first version supplies CLI access rather than separate harness plugins.

## Demonstration and checks

Copy `examples/demo` into a temporary workspace, then start its configuration.
Its fake research Agent routes a ticket to a fake implementation Agent, which
asks for Human approval. Respond `approve` to close the ticket or `hold` to retain
it for attention. The demo uses no model credentials or network calls.

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
