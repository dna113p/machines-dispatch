# Machines Dispatch

A local daemon that runs [Machines](https://github.com/dna113p/machines) for
your tickets. Register a ticket source, and Dispatch launches a Machine for each
ticket that is ready, then writes the result back to the ticket.

- **Sources** own their ticket format, dependencies and result updates. Built
  in: [tk](https://github.com/wedow/ticket)'s Markdown files and GitHub issues.
  Neither needs another ticket database, and tk needs no running `tk` process.
- **Machines** own the actual work: implementation, research, reviews,
  repository safety and cleanup.

Runs on Linux with Node 24 or newer.

## Quick start

Build from source. This checkout uses the Machines 0.4 host interface,
published on npm:

```sh
npm install
npm run check
npm run build
node dist/src/cli.js help
```

To run against an unreleased Machines checkout, replace the installed copy with
a local build. This saves no machine-specific paths in package metadata, and
publishes nothing:

```sh
node scripts/install-local.mjs ../machines
```

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

- `cwd` is relative to the configuration file, and `ticketsDir` to `cwd`.
- `allowedMachines` limits which Machines a tk source may launch.
- The configuration and every Machine it finds are trusted code. A ticket can
  pick a Machine by its catalogue name, but never a file to execute.
- Restart the daemon to reload registrations.

Every field, the trust rules and the state directory:
[Configuration](docs/configuration.md). For issues: [GitHub issues](docs/github.md).

## Run it

```sh
machines-dispatch start --config ./machines-dispatch.config.ts
machines-dispatch status
```

From this checkout, use `node dist/src/cli.js` in place of `machines-dispatch`.

| Command | Does |
| --- | --- |
| `daemon --config file` | Run in the foreground, for a service manager or debugging |
| `start --config file` | Start a detached daemon; returns once its socket is ready |
| `stop` | Stop the daemon and interrupt active attempts |
| `sources` | Show each registration's health and problems |
| `status [attempt]` | Show attempts, sleeping runs and Human requests |
| `logs <attempt>` | Show an attempt's recorded observations |
| `respond <attempt> <request> <response>` | Answer a Human request waiting in-process |
| `cancel <attempt>` | Cancel an active attempt |
| `retry <attempt>` | Deliberately run eligible work again |
| `update [--install]` | Check for a newer Machines; install it when idle |

Every command takes `--state-dir` (clients must use the daemon's) and `--json`
for compact output. State defaults to `$XDG_STATE_HOME/machines-dispatch`, or
`~/.local/state/machines-dispatch`.

Closing a client does not stop runs. Stopping the daemon interrupts runs that
have a live process; sleeping runs stay asleep.

## tk tickets

Create tickets and dependencies with `tk` as usual. Optional fields go in the
frontmatter:

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

- Every `open` or `in_progress` ticket whose dependencies are done is
  considered. There is no automation label and no concurrency limit, so register only
  sources you mean to automate. Tickets of one repository implement concurrently;
  Machine Shop's ticket workflow takes a per-repository turn for commit, rebase and
  delivery, so one candidate at a time lands on a base.
- A ticket without `machine` uses the registration's `defaultMachine`. An
  invalid explicit Machine never falls back to the default.
- Problems such as missing dependencies, cycles and malformed tickets show in
  `sources`; other work carries on.
- The Machine receives `{ ticket: { id, source, title, body, metadata }, input }`.

More: [Tickets, outcomes and writeback](docs/tickets.md).

## Results, writeback and retry

A Machine ends by returning one of these as its top-level XState `output`:

```ts
{ action: "complete", summary: "Verified and approved." }
{ action: "hold", summary: "Research complete; a decision is needed." }
{ action: "route", machine: "implement", input: { task: "..." }, summary: "Ready to implement." }
```

| Outcome | Writeback |
| --- | --- |
| `complete` | Records the summary and closes the ticket |
| `hold` | Records the findings and leaves the ticket open |
| `route` | tk only: records the findings and queues the ticket for another Machine |

A missing or malformed outcome is kept as a conflict and never closes a ticket.
On a tk ticket, writeback adds one marked note per attempt under
`## Machines Dispatch`; on an issue, a comment. Replaying it never duplicates
one.

A held ticket does not run again by itself. Use `retry` to run it again on
purpose. Or set `input.resume: true` in its frontmatter: then editing the
ticket's content, for example appending your answer at the end, launches it
again without `retry`, and the Machine receives `resume: true`. The daemon's own
notes and the fields it manages do not count as an edit.

The exact edit rules and conflict handling: [Tickets, outcomes and writeback](docs/tickets.md).

## Watching and answering runs

Each attempt publishes Machines run status, labelled with its ticket's id and
title. Set `MACHINES_RUN_STATUS_DIR` in the daemon's environment to move it, or
to `off` to turn it off.

- `machine ui` (a Machines command) shows each run's graph, its current state
  and the states it entered.
- `machine watch <start of the label>` follows a run from another session.

When run status is published, a run that reaches a Human question or a future
timed wait **sleeps**: it saves a checkpoint and its process exits.

- `status` shows it as `sleeping`. The ticket stays open with no note yet.
- Answer it with `machine respond <run-id> <request-id>`. Dispatch continues
  it on its next poll, as the same attempt.
- A sleeping attempt blocks `retry` and survives restarts.
- With publishing off, or a run-status directory that cannot be written,
  questions wait in-process: answer them with `machines-dispatch respond`.

Waking, cancelling and runs finished outside Dispatch: [Runs](docs/runs.md).

## Updates

The daemon runs Machines from its own installed copy of `@dna113p/machines`.
It checks npm for a newer release within its version range at start and every
30 minutes. Choose what happens with one export in the configuration file:

```ts
export const update = "install"; // or "check" (the default), or "off"
```

- `"check"` reports a newer release in `status` and `update`.
- `"install"` also installs it once the daemon is idle and restarts in place.
  This replaces a local Machines build, and runs newly published code
  unattended.
- `machines-dispatch update --install` installs a found update once, even in
  `"check"` mode.

Machines Dispatch itself is not on npm. The full rules: [Configuration](docs/configuration.md#updates).

## Recovery and multiple computers

- The journal records each attempt before launch and its result before
  touching the ticket.
- A run cut off by a stop is continued once from its checkpoint on the next
  start. A second cut-off is written back as interrupted.
- Deduplication covers one state directory only. Two computers can run the
  same ticket, and the daemon does no repository locking, Git syncing or
  worktree creation.

More: [Runs](docs/runs.md#recovery).

## Demo and checks

Copy `examples/demo` into a temporary workspace and start its configuration. A
fake research Agent routes a ticket to a fake implementation Agent, which asks
for Human approval: `approve` closes the ticket, `hold` keeps it. With
`MACHINES_RUN_STATUS_DIR=off` in the daemon's environment, answer it with
`machines-dispatch respond`; otherwise it sleeps as described above. No model
credentials or network calls.

```sh
npm run check
npm run build
npm run smoke:package
npm run test:tk
```

- `smoke:package` installs real tarballs into a temporary consumer and
  completes the demo through the installed CLI.
- `test:tk` downloads pinned upstream tk commit
  `194b71a8bbc3771da1ce9f579395937c976bbddc` and checks file
  interoperability.
- Other tests use fake runners, temporary tickets and fake GitHub transports,
  and never touch live GitHub issues. Real Agent workflows need their harnesses
  and credentials configured explicitly.

## More

- [Configuration](docs/configuration.md): registration fields, trust, state
  directory, updates
- [GitHub issues](docs/github.md): eligibility, authentication, results
- [Tickets, outcomes and writeback](docs/tickets.md)
- [Runs](docs/runs.md): status, sleeping, waking, recovery
- [Custom sources](docs/custom-sources.md): the `WorkSource` interface and Auto
  Machines compatibility

## The Machines family

| Project | What it does |
| --- | --- |
| [Machines](https://github.com/dna113p/machines) | The runtime: write a workflow as states, and run it with Agents, checks and people |
| [Machine Shop](https://github.com/dna113p/machine-shop) | Ready-made software workflows to copy into a project |
| **Machines Dispatch** (this repository) | A local daemon that runs a Machine for each ticket that is ready |
| [Machine Wars](https://github.com/dna113p/machine-wars) | A concept: ranking Agents so a Machine can pick one |
