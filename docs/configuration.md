# Configuration

The detail behind [Register a ticket source](../README.md#register-a-ticket-source)
and [Updates](../README.md#updates) in the README.

## Registration fields

`machines-dispatch.config.ts` default-exports a function that returns a list of
registrations. See the README for an example with one `tk` and one `github`
source.

| Field | Applies to | Meaning |
| --- | --- | --- |
| `id` | both | The source's name, as `sources` and `status` show it |
| `cwd` | both | Workspace the Machines run in, relative to the configuration file |
| `ticketsDir` | tk | Ticket directory, relative to `cwd` |
| `defaultMachine` | both | Machine for tickets that name none; required for GitHub |
| `allowedMachines` | tk | The only Machine names this source may launch (below) |
| `agents` | both | Maps Machine roles to existing Agent preset names |
| `home` | both | A Machines configuration home, relative to `cwd`; otherwise normal Machines global/project discovery applies |
| `input` | GitHub | Input supplied to every issue's run |
| `repository`, `requiredLabels`, `excludedLabels`, `allowedAuthorAssociations` | GitHub | See [GitHub issues](github.md) |

Restart the daemon to reload registrations.

### `allowedMachines`

- Lists the only Machine names a tk registration may launch.
- When `defaultMachine` is also set, it must be in the list.
- A ticket that selects any other Machine is not admitted and is reported by
  `sources`.
- The list also applies to `route` outcomes: a route to a Machine outside it is
  a writeback conflict, and the ticket is left unmodified.
- Without it, a tk source launches whatever its tickets name.
- The GitHub source is unaffected: its issues cannot select Machines.

### Several repositories in one registration

One registration can cover a workspace containing several repositories. Put
its shared tickets in one directory, and include repository names or relative
paths in ticket input. The Machine decides how to work in those repositories.

## Trust

- The configuration and every discovered Machine file are trusted executable
  code.
- tk tickets select exact catalogue names. A file path supplied by a ticket is
  never executed.
- GitHub issues cannot select Machines, Agent bindings or execution paths;
  their trusted registration supplies these.

## State directory

- Defaults to `$XDG_STATE_HOME/machines-dispatch`, or
  `~/.local/state/machines-dispatch`, for a fresh installation.
- Holds the local control socket, the execution journal, the singleton lock
  database and the background daemon log.
- Every command accepts `--state-dir`; clients must use the daemon's state
  directory.
- Pending Human questions and Agent observations are available through
  `status` and `logs`.
- No credentials or home-directory paths are added to ticket files
  automatically. Machine-authored summaries are written as supplied.

## Updates

The daemon runs every Machine with its own installed copy of
`@dna113p/machines`.

**How it checks.** When it starts, and every 30 minutes after, it asks npm
(`npm view`, with your npm configuration and registry) for the newest stable
release inside the version range in this package's `dependencies`.

- The copy is current when it has that version and npm installed it from a
  registry.
- A local build, such as the tarball `scripts/install-local.mjs` installs, is
  never current, even with the same version number.
- Machines Dispatch itself is not on npm; its own updates are not covered.

**Modes.** One named export in the configuration file selects the mode:

```ts
export const update = "install";
```

| Mode | Behaviour |
| --- | --- |
| `"check"` (default) | Report a newer release in `status`, in the `update` command, and once in the daemon's output. Nothing is installed. |
| `"install"` | Also install it and restart, as below. |
| `"off"` | Check nothing. |

A daemon started with `startDaemon({ sources })` checks nothing unless its
`update` option asks.

**The `update` command.**

- `machines-dispatch update` checks now and prints the update state, which
  `status` also shows under `update`.
- `machines-dispatch update --install` installs the update it finds even in
  `"check"` mode. In `"off"` mode it answers that updates are off.
- A failed check or install is recorded in that state, never stops work, and
  is tried again at a later check. That holds for `update --install` too: the
  request stands for the version it found, and never extends to a later
  release.

**How it installs.**

1. It waits until the daemon is idle: no attempt is starting, running, waiting
   for a Human in-process, or awaiting recovery, and no result is still being
   written back. Sleeping attempts can remain.
2. It holds new admissions and wakes.
3. It runs `npm install` for that exact version beside the copy in use.
4. It restarts in place with the same command line and process ID, so a
   service manager, a foreground `daemon` and a detached `start` all continue
   unchanged.

If the install fails, or leaves anything but that release, the daemon does not
restart and carries on with the copy it has loaded. A release that is on disk
but not yet loaded, after such a failure or an `npm install` by hand, still
counts as an available update until the daemon restarts.

In-place restart needs `process.execve`. Without it, `"install"` acts as
`"check"` and the update state says so.

**Cautions.**

- `"install"` replaces a local build with the published release. Use
  `"check"` or `"off"` while testing an unreleased Machines checkout.
- `"install"` means newly published Machines code runs unattended, with the
  daemon's access, as soon as the daemon is idle.
