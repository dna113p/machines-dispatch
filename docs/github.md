# GitHub issues

The `github(...)` source runs Machines for issues in a github.com repository.

## Which issues run

- Every `requiredLabels` entry must be present, and no `excludedLabels` entry
  may be present. At least one required label is mandatory.
- Labels are matched exactly. The adapter never creates or changes labels.
- Pull requests are excluded.
- A single trusted `defaultMachine` is required, with optional `input`,
  `agents` and `home` for the whole registration.

### Who may write the task

Labels alone do not make the issue text trusted. Anyone who can open or edit
an issue controls its title and body, including after a maintainer applies the
labels, and that text reaches the Machine's Agent as task input.

Optional `allowedAuthorAssociations` lists the GitHub
[`author_association`](https://docs.github.com/en/rest/issues/issues) values
admitted, for example `["OWNER", "MEMBER", "COLLABORATOR"]`.

- It must be a non-empty list of non-empty strings, matched exactly.
- When it is set, an issue whose author association is unlisted or absent is
  reported in source diagnostics instead of being admitted, and `prepare`
  rechecks it before launch.
- The value comes from the issue the adapter already reads; no additional
  request is made.
- When it is omitted, issues from any author are admitted.

### Dependencies

The adapter checks GitHub's
[native issue dependencies](https://docs.github.com/en/rest/issues/issue-dependencies)
during discovery, preparation and result delivery.

- A prerequisite counts only when closed with `state_reason: "completed"`.
  Open, cancelled, duplicate, and unknown or legacy closure reasons stay
  blocked. Remove or reconcile an obsolete relationship in GitHub explicitly.
- Markdown checklists and links are not dependencies, and the adapter does not
  coordinate prerequisites in other trackers.
- Dependency-read errors stop admission rather than treating unknown work as
  ready.

## Identity

- A GitHub ticket's `id` is `owner/repo#number`. `metadata` contains
  `repository`, `number`, `nodeId`, `url` and sorted label names.
- Stable native issue IDs determine execution keys. Editing titles, bodies,
  labels, comments or timestamps does not create another request.
- `prepare` rereads task content, labels, identity and prerequisites before
  allowing launch.
- Repository renames and issue transfers are rejected for explicit
  reconfiguration.
- Local deduplication does not claim issues against another daemon or
  computer.

## Authentication and requests

- Authentication uses `GH_TOKEN`, then `GITHUB_TOKEN`, then a lazily invoked
  `gh auth token --hostname github.com`.
- The account needs repository access and Issues read/write permission for
  result comments and closure.
- No token is read and no subprocess is started when the adapter is
  constructed.
- Optional `token` and `fetch` overrides support controlled integrations and
  offline tests. Prefer environment or gh authentication over putting
  credentials in config files.
- Requests use only `https://api.github.com`, reject redirects, and time out
  after 20 seconds.
- Paginated issue, dependency and comment reads validate next-page resources
  and filters, including GitHub's numeric repository aliases and opaque
  cursors; requests stay on the configured owner/repo endpoint.
- [Rate-limit responses](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
  pause later requests until retry/reset deadlines with increasing backoff;
  they do not keep the daemon asleep.
- Rate or authentication failures remain visible in source and delivery
  diagnostics.

## Results

GitHub supports only `complete` and `hold` outcomes. A `route` produces a
visible writeback conflict instead of inventing tracker metadata or silently
ignoring routing.

- Delivery posts a comment containing the attempt marker and summary.
- A `complete` then rereads the assignment before a state-only update to
  closed / completed.
- Replaying an uncertain comment or closure response finds the comment and
  finishes any remaining closure without duplicating it.
- Edited result comments, changed assignments, or issues closed without
  completion require intervention.
- The adapter preserves the issue body and user labels.

GitHub's separate comment and state requests are not a transaction. External
edits in the final read/write window remain optimistic, as with tk, so a
pending result comment can be visible while closure is still pending or
conflicted.

### Reopened issues

Snapshots retain the open issue's state reason.

- If an issue is newly reopened before unfinished delivery retries, the
  adapter reports a conflict instead of closing it again.
- A deliberate new attempt can work on an already-reopened issue.
- An identical close/reopen cycle for a task admitted already reopened cannot
  be told apart from pending closure using current issue state alone; this
  adapter does not read issue event history.
