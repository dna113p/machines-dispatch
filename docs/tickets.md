# Tickets, outcomes and writeback

The detail behind the README's [tk tickets](../README.md#tk-tickets) and
[Results, writeback and retry](../README.md#results-writeback-and-retry).

## Which tickets run

- Every unfinished, unblocked ticket is considered: both `open` and
  `in_progress`, matching `tk` readiness.
- The tk adapter has no automation label, and the daemon has no concurrency
  limit. Register only ticket sources you intend to automate.
- Tickets without a Machine use the registration default. Without either
  selection they show an error. An invalid explicit Machine never falls back to
  the default.
- Missing dependencies, cycles, malformed tickets and invalid selections are
  reported by `sources`. Other eligible work continues.
- Machine preparation checks Agent bindings. Each definition validates its own
  input shape before Operations.
- Validation or import failures that happen before admission are reconsidered
  on a later poll.
- A failed hosted attempt needs a deliberate `retry` after fixing it, unless a
  tk edit creates new work under the [resume rule](#resuming-an-edited-ticket).

## What the Machine receives

Both adapters supply the same input envelope:

```ts
{
  ticket: { id, source, title, body, metadata },
  input: /* tk input field, or GitHub registration input; otherwise null */
}
```

- Paths in `input` are references, resolved by the Machine relative to its
  configured workspace.
- The adapter neither copies attachments nor makes a text-only Agent
  multimodal.
- A ticket's input is snapshotted for each attempt.

## Outcomes

Define the Machine's top-level XState `output` as one of these JSON objects:

```ts
{ action: "complete", summary: "Verified and approved." }
{ action: "hold", summary: "Research complete; a decision is needed." }
{ action: "route", machine: "implement", input: { task: "..." }, summary: "Ready to implement." }
```

| Outcome | What happens |
| --- | --- |
| `complete` | Records the summary and closes the ticket. |
| `hold` | Records the findings and leaves the ticket open. It does not launch again locally until `retry` or a qualifying tk resume edit. |
| `route` (tk only) | Appends the findings, updates the ticket's Machine and optional input/agents, and creates a new execution request. |

- A `route` from a GitHub issue, or a `route` to a Machine outside a tk
  registration's `allowedMachines`, is a writeback conflict, and the ticket is
  left unmodified.
- A missing or malformed outcome is kept as a writeback conflict. It never
  closes the ticket.
- A Machine's final state alone is not a ticket outcome.

## Writeback

- The tk adapter manages `machines-dispatch-request` for routed work and puts
  attempt markers in result notes.
- Replaying a writeback does not append duplicate notes.
- Ordinary edits and polling do not rerun an already-recorded request.
- Writeback flattens a multiline summary onto one line after its marker.

### Conflicts

- Ticket changes detected before writeback produce a visible conflict instead
  of replacing newer content.
- A qualifying content edit with `input.resume: true` can launch another
  attempt once that conflict is recorded; the earlier result stays local.
- Inspect the local result and reconcile the ticket. Do not rerun a completed
  Machine merely to publish its old result.
- Transient I/O failures retry automatically, independently of execution.
- Brief metadata writes serialize within the adapter, while Machine runs remain
  parallel. Independent editors and `tk` processes do not share that write
  queue, so simultaneous external edits are still optimistic rather than a
  cross-process transaction.

## Resuming an edited ticket

Setting frontmatter `input.resume: true` opts a tk ticket into automatic
resume.

- Editing the ticket's content then creates a new execution key, so a parked
  ticket launches again without `retry`.
- The Machine receives `resume: true` in `input.input`.
- Unchanged content does not launch again, and the daemon never sets `resume`
  itself.
- Removing `input.resume`, or setting it to `false`, keeps an attempted request
  parked, even if it first ran with resume enabled. Explicit `retry` still
  works.

**What counts as an edit.**

- Body edits count even below a daemon note, so owners can append answers at
  the end of the ticket.
- Excluded from the comparison: the daemon's marked `## Machines Dispatch` (or
  legacy `## Auto Machines`) heading, each attempt marker, and its following
  summary line. Unmarked headings and later lines remain content.
- Also excluded: the frontmatter fields the daemon manages (`status`,
  `machine`, `input`, `agents`, `machines-dispatch-request` and
  `auto-machines-request`). Changing only those does not count as a content
  edit, although enabling `input.resume: true` changes the key from its
  ordinary form. Other frontmatter fields do count.
- Writeback alone therefore never triggers another resume.

**Edge cases.**

- The rule also applies after failed, cancelled or interrupted attempts.
- Restoring content whose key was already attempted does not launch it again.
- An eligible ticket already carrying `input.resume: true` gets a new key once
  when upgrading from a version without this rule.
- Use `retry` for deliberate re-execution of an eligible ticket, including an
  unchanged or reopened one.
