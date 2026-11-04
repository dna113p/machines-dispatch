# Custom sources

A configuration can return any conforming source alongside `tk(...)` and
`github(...)` registrations. A source owns its dependency graph and output
convention, so a custom adapter can use another tracker without teaching the
daemon its ticket schema.

## The `WorkSource` interface

The exported `WorkSource` interface has three operations:

| Operation | Does |
| --- | --- |
| `scan()` | Returns eligible items and optional diagnostic messages. |
| `prepare(item)` | Rechecks eligibility and returns Machines launch parameters, or `undefined` if the item changed or is no longer eligible. It must not execute workflow effects. Only exact discovered Machine names are accepted in its launch request. |
| `apply(report)` | Interprets a terminal execution report and updates the source. |

## Items

- Each item has a stable execution `key`, a stable ticket identifier in
  `label`, and an opaque JSON `ref`.
- A new execution request needs a new key. Changing unrelated metadata must not
  generate one.
- An item may also declare `supersedes`: additional execution keys consumed by
  its attempt within the same source. tk uses this to keep the ordinary request
  consumed when resume is later disabled. Explicit retries bypass this
  deduplication.

## Applying results

- `apply` must tolerate retries with the same `attemptId`.
- Throw `ReportConflict` for invalid output or changes that need intervention.
  Ordinary errors are retried.

## Claims

A source may also carry `claims`, a `ClaimStore`, to share admission with
daemons on other computers. Without it, two computers that see the same items
can both run them. `tk(...)` and `github(...)` accept `claims` and pass it
through; a custom source sets the property itself.

| Operation | Does |
| --- | --- |
| `acquire({ scope, key, holder, retry })` | Returns `{ acquired: true, lease }`, or `{ acquired: false }` with the live `holder` and `expiresAt`, or with `finished: true` when `key` was finished and `retry` is false |
| `renew(lease)` | Returns `{ ok: true, lease }` with a later `expiresAt`, or `{ ok: false, reason: "lost", holder }` when the record no longer names this lease |
| `finish(lease)` | Records `key` as finished and ends the lease; throws `ClaimLost` when another holder has it |
| `abandon(lease)` | Ends the lease without recording `key` |

- `scope` is `<source id>/<item label>`, so labels must be stable ticket
  identities; `key` is the item's `key`.
- `holder` is `{ daemon, attempt, host }`. A `Lease` carries `scope`, `key`,
  `holder`, `expiresAt`, `ttlMs` and store-specific JSON `data`; it is stored
  with the attempt, so it must be JSON.
- Per scope, a store must: create a missing record atomically; refuse a live
  lease held by another holder; let exactly one of several takers replace an
  expired lease (compare and swap on the record's version); refuse a finished
  key unless `retry`; and renew or finish only a lease whose version is still
  the record's current version (a lease made obsolete by any later write,
  including the same holder's own renewal or reacquisition, is lost).
- Network errors throw. The daemon then launches nothing, or keeps the claim
  and retries renewal on the next poll.
- `gitClaims(...)` is the provided implementation; see
  [Multiple computers](runs.md#multiple-computers).
- A report for an attempt stopped by a lost claim carries `reason`, which a
  source may add to its note. tk does.

## The `request` client

The exported `request` client lets a future MCP or Pi adapter use the same
daemon. The first version supplies CLI access rather than separate harness
plugins.

## Auto Machines compatibility

Machines Dispatch was called Auto Machines.

- The package also installs an `auto-machines` command for the same
  executable.
- When only an `auto-machines` state directory exists, clients use it in place.
  When both exist as separate directories, pass `--state-dir`.
- Tickets carrying `auto-machines-request` metadata or
  `<!-- auto-machines:... -->` receipts are still recognized. New writes use
  the `machines-dispatch` forms.
