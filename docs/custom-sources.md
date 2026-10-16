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
