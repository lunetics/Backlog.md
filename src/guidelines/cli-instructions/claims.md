# Ticket Claims

Claims coordinate which cooperating agent works on which ticket. A claim lives in a shared Git
coordination area, not in the task file: claim commands never change a task's status, assignee or
content, and never commit.

## Commands

- `backlog claim setup --endpoint <url> --storage-format <format> --clock-uncertainty-ms <ms>` writes the
  `claims:` block once; it never overwrites an existing block.
- `backlog claim init` creates the coordination area; running it again reports `exists`.
- `backlog claim context create --parent <private directory> [--recover-from <old context>]` creates a private
  context and prints only its context ID. The handle is `<private directory>/<context id>`. With
  `--recover-from`, the new context holds the proof of the old one and may take over its claims with
  `claim resume`; the old context is only read and never printed.
- `backlog claim context show --context <handle>` prints the context ID and its authority ID, the value an
  operator lists in `claims.recovery_authorities`, and nothing else of the context.
- `backlog claim acquire <ticket> --owner <name> --context <handle>` claims a ticket that exists locally.
  Under the default dependency policy it refuses a ticket with an unfinished or unresolvable prerequisite
  (see "Dependency policy").
- `backlog claim next --owner <name> --context <handle> [--order priority|age] [--max-candidates <n>]
  [--ttl-ms <ms>] [--hard-end <iso>] [task list filter flags]` claims the first ready ticket that matches the
  filters, trying candidates one after another (see "Ready selection and order"). It takes no ticket and no
  `--operation-id`.
- `backlog claim renew <ticket> --context <handle>`, `backlog claim release <ticket> --context <handle>` and
  `backlog claim reclaim <ticket> --context <handle>` need no local task file.
- `backlog claim transfer <ticket> --to-context <receiver handle> --owner <name> --context <handle>
  [--time-box preserve|restart] [--hard-end <iso>] [--ttl-ms <ms>]` hands a held claim to another context, in one
  step or, for a restart with a later hard end, over the time path (see "Time path").
- `backlog claim resume <ticket> --context <replacement handle>` takes over a claim of the context the
  replacement was created from with `--recover-from`.
- `backlog claim change-bounds <ticket> --context <handle> --mode lease|hard|none [--lease-end <iso>]
  [--hard-end <iso>] [--grace-ms <ms>]` sets the complete absolute timing of a held claim.
- `backlog claim emergency-release <ticket> --context <operator handle> --preview` shows the ticket's state and
  root without sending anything, and `backlog claim emergency-release <ticket> --context <operator handle>
  --expect-root <root> [--operation-id <id>]` frees the claim at exactly that root, whoever holds it (see
  "Emergency release and new epochs").
- `backlog claim install-epoch --context <operator handle> --expect-epoch <epoch> --isolation-confirmed
  [--storage-format <format>] [--ticket <ticket>] [--preview]` installs the next epoch of the coordination area
  after a restore or for a format change; every claim ends and every ticket becomes free (see "Emergency release
  and new epochs").
- `backlog claim resolve <operation-id> --context <handle>` clarifies the outcome of an earlier operation and
  never sends anything.
- `backlog claim retry <operation-id> --context <handle>` resends a recorded operation that is still open. It
  never plans anew, never uses a new operation ID and never pauses.
- `backlog claim list [--ticket <ticket>] [--context <handle>]` shows the observed claims.
- `backlog claim reclaim-preview --context <handle> <scope>` shows, without sending or reserving anything,
  which tickets of the scope a reclaim would take now.
- `backlog claim reclaim-batch --context <handle> <scope>` reclaims every ticket of the scope that is
  reclaimable now, one `claim reclaim` after another (see "Batch reclaim and preview"). The scope is
  `--ticket <ticket>` (repeatable or comma-separated), `--claim-owner <name>` (repeatable), the filter flags
  of `task list` with `--ready`, or `--all` alone. Neither takes `--operation-id` or `--expect-generation`.

The endpoint URL never carries credentials: `user:password@` and token-in-URL forms are refused as `config-invalid`
with the problem `unsupported-endpoint` on `claims.endpoint`. Authenticate with SSH keys or a Git credential helper;
both are ordinary Git configuration and pass through unchanged. A username that selects the helper credential belongs
in Git configuration (`git config credential.https://<host>.username <name>`), not in the URL.

None of these commands asks a question; a missing mandatory option ends in a `refused` document.

Every mutating command, `resolve` and `retry` need `--context` with an absolute path, and `claim transfer`
also needs `--to-context` with the absolute path of the receiving agent's context. Neither is ever taken from
an environment variable, a default, an owner name or "the only other context", and neither is ever printed.
The receiving context must be loadable by the calling process: same host, same user ID. Do not copy a context
directory: a copy cannot be told apart from its original. The `--owner` value is a display name only, never
an identity.

## Output

Use `--json`. Every command prints exactly one document on stdout, errors included:
`{"schemaVersion": 1, "kind": ..., "status": ..., "command": ...}` plus the fields of its kind:

- `claim-operation`: `action`, `ticket`, `operationId`, `outcome`, `rejection`, `storage`, `sends`, `stoppedBy`,
  `planned`, `rights`, and `transition` for a call over the time path.
- `claim-pause`: `action`, `ticket`, `operationId` (always `null`), `pause`, `rights`.
- `claim-resolution`: `operationId`, `ticket`, `action`, `outcome`, `query`, and `transition` for the operation ID
  of a call over the time path.
- `claim-list`: `complete`, `observedAt`, `claims`. An entry with `claimGeneration` also has `epoch`: compare
  generations only within an epoch.
- `claim-next`: `order`, `maxCandidates`, `ticket`, `operationId`, `candidates`, `excluded`, `diagnostics`,
  `attempts`, `untried`, `stop`. Each entry of `attempts` is the unchanged document of one acquire
  (`claim-operation`, `claim-pause` or `claim-error` with `command: "acquire"`).
- `claim-reclaim-batch`: `observedAt`, `complete`, `unreadable`, `stoppedAt`, `entries`. Each entry is
  `{ticket, result, document}`: `document` is the unchanged document of one reclaim (`claim-operation`,
  `claim-pause` or `claim-error` with `command: "reclaim"`) and `result` its `status`, or `"untried"` with
  `document: null`.
- `claim-reclaim-preview`: `complete`, `observedAt`, `entries`. Each entry is `{ticket, verdict}` plus
  `claimGeneration`, `owner`, `timing`, `transition`, `boundary` and `pause` where they apply.
- `claim-emergency-preview`: `ticket`, `state`, `owner` (active only) or `transition` (pending only),
  `claimGeneration`, `epoch`, `root`. It is the only document that prints a root.
- `claim-epoch`: `fromEpoch`, `epoch`, `format`, `previousFormat`, `rewritten`, `created`, `breached`,
  `unsettled`, `isolation`, and `cause` when it is `rejected`. `claim-epoch-preview`: `epoch`, `format`, `listed`,
  `toCreate`, `unreadable`. The ticket lists come in the order of `claim list`.
- `claim-setup`: `keys`. `claim-init`: `result`, `format`, `epoch`. `claim-context`: `contextId`, and
  `authorityId` for `context show`.
- `claim-error`: `code`, `message`, `ticket`, `operationId`, and for some codes `problems`, `configuredFormat`,
  `existingFormat` or `dependencies`.

Instants are integer milliseconds since the epoch; durations end in `Ms`. Never parse the human text; it may
change at any time. Decide on `status` and `code`, never on `message`.

`rights` describes the observed state only (`ownership`, `workRight`, `reclaim`); it is not a permission for an
external effect.

## Status and exit code

| status | exit |
| --- | --- |
| `ok` | 0 |
| `applied` | 0 |
| `rejected` | 2 |
| `unknown` | 3 |
| `unknown-history` | 4 |
| `refused` | 5 |
| `unavailable` | 6 |
| `paused` | 7 |
| `internal` | 1 |

- `applied`: the change is stored. `rejected`: it was not applied; read the state again instead of repeating
  blindly.
- `unknown` is not free: never treat the ticket as free or released. Run `backlog claim resolve <operation-id>
  --context <handle>`; while it reports the operation as open, `backlog claim retry <operation-id> --context
  <handle>` resends the same change.
- `unknown-history`: the outcome cannot be settled from the stored history, possibly never; check the current
  state with `backlog claim list`.
- `refused`: a precondition is missing and nothing was sent; fix the cause first.
- `unavailable`: nothing was sent or could be read now; try again later.
- `paused`: own earlier operations on the same ticket are still open; their IDs are in `pause.operationIds`.
  For `claim next` an open own acquire on any ticket is enough: the call stops before its first attempt, and
  the IDs are in `stop.operationIds`. `backlog claim retry` is the way out.
- `internal`: an unexpected error. Commander usage errors also exit 1, as text.

## Error codes

| code | status |
| --- | --- |
| `project-not-found` | refused |
| `project-config-unreadable` | refused |
| `invalid-ticket` | refused |
| `ticket-not-found` | refused |
| `ticket-ambiguous` | refused |
| `owner-required` | refused |
| `context-required` | refused |
| `invalid-option` | refused |
| `option-not-applicable` | refused |
| `hard-end-required` | refused |
| `invalid-operation-id` | refused |
| `operation-id-in-use` | refused |
| `not-configured` | refused |
| `config-invalid` | refused |
| `claims-disabled` | refused |
| `context-invalid` | refused |
| `context-corrupt` | refused |
| `context-unavailable` | unavailable |
| `descriptor-missing` | refused |
| `format-mismatch` | refused |
| `schema-unsupported` | refused |
| `coordination-corrupt` | refused |
| `unreachable` | unavailable |
| `preflight-invalid` | refused |
| `preflight-unknown` | unavailable |
| `request-invalid` | refused |
| `local-unavailable` | unavailable |
| `storage-unreadable` | unavailable |
| `state-corrupt` | refused |
| `state-unsupported` | refused |
| `state-unknown` | unavailable |
| `budget-exhausted` | unavailable |
| `operation-not-found` | refused |
| `record-corrupt` | refused |
| `scope-mismatch` | refused |
| `list-unavailable` | unavailable |
| `already-configured` | refused |
| `config-write-failed` | unavailable |
| `format-conflict` | refused |
| `not-empty` | refused |
| `remote-rejected` | refused |
| `init-unknown` | unknown |
| `target-context-invalid` | refused |
| `target-context-unavailable` | unavailable |
| `recovery-missing` | refused |
| `bounds-required` | refused |
| `dependency-blocked` | refused |
| `dependency-unknown` | refused |
| `tasks-unavailable` | unavailable |
| `scope-required` | refused |
| `authority-required` | refused |
| `expectation-required` | refused |
| `isolation-unconfirmed` | refused |
| `internal` | internal |

After the operation started, an unexpected error is reported as status `unknown` with code `internal` and the
operation ID, because the change may have been sent.

`target-context-invalid` means `--to-context` is missing, not absolute, cannot be loaded, is damaged or is the
own context (also under another path); `target-context-unavailable` means it could not be read now.
`recovery-missing` means the context of `claim resume` was not created with `--recover-from`.
`bounds-required` means `--mode` or a field that mode needs is missing. A failing `--recover-from` source keeps
the codes of `context create`: `context-invalid`, `context-corrupt` or `context-unavailable`.
`dependency-blocked` means the ticket has a prerequisite that is not finished; `dependency-unknown` means a
prerequisite does not name exactly one local task, or the ticket itself has no single local record. Both carry
`dependencies` with `blocking`, `unknown` (canonical task IDs) and `unreadable` (a count of entries that are no
task ID). `tasks-unavailable` means the local task files could not be read; nothing was sent. `scope-required`
means `claim reclaim-batch` or `claim reclaim-preview` got no scope, or a scope option with only blank values.
Invalid task filter values of `claim next`, `claim reclaim-batch` and `claim reclaim-preview` are
`invalid-option`. `authority-required` means the context of `claim emergency-release`, of a `claim retry` of
its record, or of `claim install-epoch` is not listed in `claims.recovery_authorities`, or the key is absent;
nothing was recorded or sent. `expectation-required` means `claim emergency-release` got neither `--preview` nor
`--expect-root`, or both. `isolation-unconfirmed` means `claim install-epoch` got no `--isolation-confirmed`;
nothing but local files was read (see "Emergency release and new epochs"). `remote-rejected` means the endpoint
refused to write the descriptor, for `claim init` or for the swap of `claim install-epoch`; nothing was changed.

## Transfer, resume and bound changes

This section describes what the three commands do and what they never do.

- `claim transfer` moves a claim the calling context holds to the context named by `--to-context`, with the
  new display name from `--owner`, in one write. The receiver does not confirm and is not notified; the
  ticket's assignee, status and task file stay unchanged, and there is no dependency check.
- After a transfer, `rights` in the document is the view of the sending context, so it shows `foreign`. The
  receiver sees its own rights with `backlog claim list --context <its handle>`.
- The receiving context is only read, for its binding; its journal records are never read, and a `retry` of the
  transfer never reads it again. A wrong but loadable receiving context gets the claim: only a transfer by
  the receiver, a release or a reclaim moves it again. There is no transfer to another host or user.
- The checks of the own context, the receiving context and the recovery proof run before any network, and the
  claim operation checks them again. If a context changes in between, the generic code of the same status
  appears instead (`request-invalid`, `context-corrupt` or `local-unavailable`).
- Under a hard end, a transfer needs a time-box action: `--time-box preserve` keeps the hard end, and
  `--time-box restart --hard-end <iso>` starts a new time box with that absolute hard end; a later one than the
  stored hard end goes over the time path (see "Time path"), an earlier or equal one is written in one step. A
  restart without `--hard-end` ends `rejected` with `requires-time-path`. `--hard-end` needs a restart:
  with `--time-box preserve`, or when neither `--time-box` nor `claims.transfer_time_box` resolves to `restart`, it
  is `option-not-applicable`. On a lease without a hard end, `--hard-end` sets its first hard end.
  Without `--time-box`, `claims.transfer_time_box` decides; with `require-explicit` or without the key the
  transfer is `rejected` with `time-box-required` and nothing is recorded or sent. The policy only supplies
  the time-box action; it never replaces an ownership, rights or deadline check. A `retry` replays the
  recorded operation and never reads the policy again.
- A transfer of a pure lease gives the receiver a fresh window: `--ttl-ms`, else `lease_ttl_ms`. Without
  either, a lease claim is `rejected` with `lease-required`. Under a hard end the window is cut at the hard
  end and `planned.capped` is `true`.
- `claim resume` works only in a context created with `--recover-from` from the context that holds the claim.
  It takes over the claim once: the chain reaches one step, and the proof is used up. It imports no journal
  of the old context; only the old context clarifies its own operations with `retry` or `resolve`. It keeps
  the stored timing, renews no lease window and revives no work right after the hard end.
- `claim change-bounds` takes the complete absolute target timing of the given `--mode`: `lease` needs
  `--lease-end` and `--grace-ms`, and a missing `--hard-end` removes the hard end; `hard` needs `--hard-end`
  and `--grace-ms`; `none` needs nothing. To keep a hard end, pass `--hard-end` again. Nothing is filled in
  from the configuration or the stored claim.
- A bound change extends a claim only through a later hard end of the same mode, and only over the time path
  (see "Time path"). A removed hard end or a later reclaim boundary under an unchanged hard end stays `rejected`
  with `requires-time-path`, and so does every extension with `enabled: false`. It never changes the mode
  (`mode-change`) and never touches a claim of another context. A target equal to the stored timing is still
  written as a new operation.
- On `claim resume` and `claim change-bounds`, `planned.capped` only says that the stored lease end equals the
  hard end; no lease window was computed.

The plan causes of these commands end `rejected` (exit 2) with `rejection.stage` `plan`, no operation ID
and nothing recorded or sent:

- `time-box-required`: the claim has a hard end and no time-box action was given or configured.
- `requires-time-path`: the change would extend the claim in a way the time path does not take: a restart
  without `--hard-end`, a removed hard end, a later reclaim boundary under an unchanged hard end, or any
  extension with `enabled: false`.
- `lease-required`: a lease claim needs a window and neither `--ttl-ms` nor a configured `lease_ttl_ms`
  gives one.
- `mode-change`: `--mode` differs from the stored mode of the claim.
- `pending-transition`: the ticket has an unresolved transition (see "Time path"); `rejection.boundary` is the
  earliest instant a reclaim can take it. Every command but `claim reclaim` and `claim emergency-release` gets
  it, from every context.
- `stale-root`: `claim emergency-release` only. The ticket's root is not the one given with `--expect-root`, or
  the ticket has no claim ref at all; run `--preview` again (see "Emergency release and new epochs").

## Time path

A later hard end extends a claim, so it never goes in one write. `claim change-bounds` with a later hard end of
the same mode and `claim transfer --time-box restart --hard-end <iso>` with a hard end later than the stored one
take the time path, and only with `enabled: true`; with `enabled: false` the bound change stays `rejected` with
`requires-time-path` and the restart is refused with `claims-disabled`. The calling context runs three steps in
one call:

1. P writes a pending state that holds the stored claim (the source) and the new one (the target). Nobody has a
   work right on it: for every context, the source and the receiver included, `rights.ownership` is `pending`
   and `workRight.cause` is `pending`.
2. The caller reads the pending state back and its clock once. Only while that reading plus
   `clock_uncertainty_ms` lies before the stored hard end, it records a witness in its own journal: the
   confirmation, an operation of its own whose ID is `transition.confirmOperationId`.
3. A, the confirmation, turns the pending state into the target. Only then does the new claim hold; the
   receiver of a transfer checks its own right with `backlog claim list --context <its handle>`.

The document of such a call carries `transition` with `phase`, `confirmOperationId` (`null` until a witness
exists), `observeBefore` (the stored hard end, the witness deadline), `reclaimBoundary` (the hull, below) and
`confirmation` (the storage fact of A, `null` while A was not sent). `operationId` and `storage` are those of P,
`planned` shows the target, `sends` counts P and A, and `rights` is the caller's own view.

| phase | meaning | outcome |
| --- | --- | --- |
| `none` | P is not stored | the outcome of P |
| `pending` | P is stored, no witness was recorded | `unknown` (exit 3); `unknown-history` (exit 4) once the pending state is gone |
| `witnessed` | the witness is recorded, A is not stored | `unknown` (exit 3) while A is open; `applied` (exit 0) once the query shows A not stored |
| `confirmed` | A is stored | `applied` (exit 0) |

- A `witnessed` call stays `unknown` until A lands. `backlog claim retry <confirmOperationId> --context <handle>`
  publishes A: it plans nothing, checks no binding, grants no right and works also after the hard end.
  `backlog claim retry <operation-id>` of P does the same, and it sends a P that was never sent.
- A call sends A again after a lost reply while the query shows A open at the pending state, up to its
  attempts. A rejected A that stays open ends `unknown` (exit 3) with the retry hint. Once the query shows A not
  stored because the ticket moved on, the call reports the historical `applied` (exit 0) with phase `witnessed`.
- The text of a `witnessed` call shows both ways, and both hold: the `confirm it` line retries the confirmation ID
  and publishes the recorded witness, the `next` and `while it stays open` lines name P, whose retry continues
  from the observation to the confirmation.
- `backlog claim resolve <operation-id>` of P gives the outcome of the whole transition with `transition.phase`
  and `confirmOperationId`; `resolve` of the confirmation ID gives that single operation's outcome.
- While P or A may still land, the calling context pauses on that ticket (`paused`, their IDs in
  `pause.operationIds`); `retry` is the way out.
- A ticket in the pending state refuses every other command of every context with `pending-transition`. Only
  `claim reclaim` takes it, once the reclaim boundary of the source and of the target have both passed: the hull,
  the later of the two. `claim list` shows it as `state: "pending"` with `claimGeneration`, `reclaimBoundary`
  and `transition: {from, to}` (both display names), never with `owner` or `timing`. `claim next` goes on to its
  next candidate, and `claim reclaim-preview` and `claim reclaim-batch` judge it by the hull.
- Without a witness (`pending`), `retry` of P observes once more and confirms, but only while its clock reading
  plus `clock_uncertainty_ms` lies before the stored hard end. After that the ticket stays pending until the hull,
  and its history may stay `unknown-history`.

What the time path does not promise:

- No work right from a pending claim, for anybody, and none from publishing a confirmation. The receiver and the
  publisher read their rights afresh.
- No time authority on the server. The witness is only as good as `clock_uncertainty_ms`: a clock that lags by
  more than that can record a false witness.
- The source stops its own work before it sends; nothing enforces that.
- No rescue of a lost witness: no export or import, no observation by another context (a replacement context sees
  neither P nor A and gets `operation-not-found`), and no new observation after the hard end. Such a ticket stays
  pending until the hull.
- No liveness: nobody publishes a confirmation automatically.
- Not offered: removing a hard end, a later reclaim boundary under an unchanged hard end, a restart without
  `--hard-end`, or a second unresolved transition on one ticket; they end `requires-time-path` or
  `pending-transition`.
- `applied` says nothing about who holds the claim now, and the confirmation is no acknowledgement by the
  receiver.

## Ready selection and order

`claim next` selects locally, then tries candidates one after another with the same acquire as
`claim acquire`, each with its own operation ID and its own `operation_budget_ms`.

- The filter flags are those of `task list`: `--status`, `--exclude-status`, `--assignee`, `--unassigned`,
  `--milestone`, `--parent`, `--priority`, `--type`, `--project`, `--labels` (every label must match) and
  `--search`, with the same matching. An unknown `--status` is refused as `invalid-option`, unlike
  `task list`, and so is a flag given with only blank values. There is no `--ready` (always on), `--sort`,
  `--limit` or `--watch`, and no label exclusion.
- Candidates are the matching local tickets that are ready under the same rule as `task list --ready`,
  judged against every local task and the completed records, never against the filtered list alone. Blocked,
  unresolved and finished tickets are counted in `excluded`; tickets whose prerequisites cannot be resolved
  are named in `diagnostics`. An empty selection stays empty: nothing is widened, and nothing is sent.
- `--order priority` (the default) sorts by the configured priority, highest first (a missing or unknown
  priority last), then by `created_date`, oldest first, then by task ID. `--order age` sorts by `created_date`,
  then by task ID. A date without a time counts as 00:00 UTC, a time without a zone as UTC; a missing or
  unreadable date sorts after every dated ticket. This differs from `task list --ready --sort priority`, which
  sorts by priority and then by task ID.
- `--max-candidates` (default 5, from 1 to 50) bounds the attempts; every attempt counts, also one that ends
  `not-free` or `held`. `candidates` always lists every candidate; `untried` counts those not attempted.
- `--assignee` and `--unassigned` filter the task's assignee field only: `--unassigned` is not "unclaimed",
  and `--owner` is only the display name of the claim. `claim next` never writes an assignee, a status or a
  task file.

After the local selection and the preflight, `claim next` reads this context's journal and one listing of
the claim refs. If an own acquire on any ticket may still land (its recorded root is still the current one),
the call stops `paused` with `stop.kind: "outstanding-acquire"` and those operation IDs, before any attempt.
An unreadable journal stops it `paused` with `stop.kind: "journal-unknown"`. `backlog claim retry` of the
named operations is the way out, or the ticket's root moving on.

Each attempt decides whether the call goes on, first match wins:

| attempt | then |
| --- | --- |
| `status` `unknown` (also `code: "internal"` with status `unknown`) | stop, exit 3 |
| `status` `unknown-history` | stop, exit 4 |
| `applied` | stop, the ticket is claimed, exit 0 |
| `rejection` `plan` `not-free`, `held` or `pending-transition`, `storage` `stale`, `resolution` `not-stored` | next candidate |
| any other `rejection` (`plan` cause or `storage` `remote`) | stop, exit 2 |
| `unavailable` (not sent, `admission-held` included) | stop, exit 6 |
| `claim-pause` naming only own operations other than acquire | next candidate |
| any other `claim-pause` | stop, exit 7 |
| `claim-error` `state-corrupt`, `state-unsupported`, `dependency-blocked`, `dependency-unknown`, `ticket-not-found`, `ticket-ambiguous` | next candidate |
| any other `claim-error` | stop with its status |

A write the endpoint refused is read again before it is reported: `storage` `stale` when the ticket ref no
longer holds the root the attempt started from, `storage` `remote` when it still does or the re-read fails; a
lost race therefore moves the call to the next candidate, a refusal by the endpoint itself stops it.

`stop.kind` and the status of the document: `claimed` is `applied` (exit 0); `no-candidates`, `exhausted`
(every candidate tried) and `bound` (untried candidates left) are `rejected` (exit 2); `attempt` has the status
of the stopping attempt; `outstanding-acquire` and `journal-unknown` are `paused` (exit 7). Exit 0 means this
call claimed a ticket; `ticket` and `operationId` name the claimed or the stopping attempt, else `null`.
Refusals before the first attempt, like invalid options or `tasks-unavailable`, are one `claim-error`.
With `enabled: false` an empty selection still ends `no-candidates`, and the first attempt ends
`claims-disabled`.

What `claim next` does not promise:

- No fairness and no queue. The order is only the order of local attempts; two agents with the same filters
  meet at the same first candidate.
- The local task files are the input. Nothing is fetched, merged or compared with another branch, so a ticket
  finished elsewhere can be selected.
- Ready is no work right. A claim certifies no readiness; a prerequisite reopened after the claim leaves the
  claim in place, and nothing reports it.
- At most one ticket per call; there is no reservation of several tickets.
- The bound limits attempts, not time: a call can run for about `--max-candidates` times
  (`operation_budget_ms` + `attempt_timeout_ms`) after its own preflight.
- The acquisition stop sees only this context's journal and has no timeout. An own acquire that never
  landed blocks `claim next` of this context until its ticket's root moves on or `claim retry` settles it; a
  finally rejected one needs a new context. Direct `claim acquire` of other tickets is not affected.
- Filters are no ownership check.
- Unreadable task directories read as empty: `claim next` then ends `no-candidates`, while the dependency gate
  of `claim acquire` refuses over the unresolved prerequisites.
- A claim ref of one candidate that cannot be read stops the whole call, because it cannot be told apart from
  an unreachable endpoint.
- No label exclusion, no filters of its own and no MCP `next` yet.

## Batch reclaim and preview

`claim reclaim-batch` selects once and then runs `claim reclaim <ticket> --expect-generation <g>` for each
candidate, one after another, each with its own operation ID and its own `operation_budget_ms`.
`claim reclaim-preview` runs the same selection and verdicts and sends nothing.

- A scope is required: `--ticket`, `--claim-owner`, a filter flag of `task list` (`--status`,
  `--exclude-status`, `--assignee`, `--unassigned`, `--milestone`, `--parent`, `--priority`, `--type`,
  `--project`, `--labels`, `--search`) or `--ready`, or `--all` for every claim ref of the endpoint. Without a
  scope, or with a scope option given only blank values (`--ticket ""`, `--labels ,`), the call ends
  `scope-required` before any network; a scope is never widened. `--all` stands alone; next to another scope
  option it is `invalid-option`. Refusals come in this order: scope, then `--context`, then the configuration.
- Several scope options narrow together. `--ticket` tickets are read directly, also without a local task file;
  every other scope lists the claim refs once.
- The filter flags and `--ready` see the local task files only, with the matching of `task list` and the ready
  rule of `task list --ready`. A claim whose ticket has no local file is reachable only through `--ticket`,
  `--claim-owner` or `--all`. An unknown `--status` is `invalid-option`; unreadable local tasks end
  `tasks-unavailable`.
- `--claim-owner` compares the stored display name of an active claim byte for byte, and for a claim with an
  unresolved transition the source's and the target's. It is not the assignee and no identity check. A stored
  state that cannot be read or decoded is never dropped by it.
- The selection reads the tickets in task ID order, each once, within one `operation_budget_ms`. A ticket that
  was not read, in time or at all, is not free: the batch lists it in `unreadable` and does not try it, the
  preview shows the verdict `unknown`. One clock reading after the reads is `observedAt`.
- A candidate is a ticket whose reclaim is planned at `observedAt` (verdict `eligible`), with the claim
  generation observed then as its expectation. The candidate list is fixed; a claim that becomes reclaimable
  later waits for the next call. A stored state that is corrupt or needs a newer Backlog.md keeps its entry:
  `claim-error` `state-corrupt` or `state-unsupported` in the batch, the verdict of that name in the preview.
- Each reclaim checks the current state again. A claim renewed meanwhile ends `rejected` with plan cause
  `not-yet` (a renewal whose window has already ended again is reclaimed), one reclaimed by another context
  with `free`, one released and acquired anew or transferred with `generation-changed`, and a lost race with
  storage `stale`.

After each candidate the batch decides whether it goes on:

| entry | then |
| --- | --- |
| `claim-error` `not-configured`, `config-invalid`, `context-invalid`, `context-corrupt`, `descriptor-missing`, `format-mismatch`, `schema-unsupported`, `coordination-corrupt` or `preflight-invalid` | stop |
| `claim-pause` with `pause.kind` `unknown` | stop |
| every other entry: any `claim-operation`, `unknown` included, a `claim-pause` with open operations, any other `claim-error` | next candidate |

Unlike `claim next`, an `unknown` outcome does not stop the batch: it belongs to its ticket alone, and the
batch goes on. After a stop, `stoppedAt` names the stopping ticket, which keeps its normal entry, and every
later candidate is `untried` with `document: null`. A sent reclaim is never reported untried, and nothing is
rolled back.

The status of `claim-reclaim-batch` is the most urgent status among its entries, in this order: `unknown` (3),
`unknown-history` (4), `internal` (1), `paused` (7), `refused` (5), `unavailable` (6), `rejected` (2), `ok` (0).
An `applied` entry counts as `ok` and an `untried` one not at all; an incomplete selection (an unread ticket or
a skipped ref name) counts as `unavailable`. So exit 0 means a complete selection without a stop in which every
candidate was reclaimed, or there was none; exit 3 means at least one reclaim has an unknown outcome. Run
`claim resolve` for each `unknown` entry's operation ID and `claim retry` for the operations a `paused` entry
names. An unexpected error after the first reclaim started ends as status `unknown` with code `internal`.

`claim reclaim-preview` needs `--context` like the batch: it reads this context's journal and shows `pause` for
a read ticket with own open operations or an incomplete journal. It never prepares, admits, records or sends
anything and reserves nothing; a later batch checks every ticket again. Its status is `ok` for a complete
selection and `unknown` (exit 3) for an incomplete one, as for `claim list`; unlike `claim list`, the verdicts
`state-corrupt` and `state-unsupported` do not make it incomplete. The verdicts are `eligible`, `not-yet`,
`never`, `free`, `absent`, `unknown`, `state-corrupt` and `state-unsupported`. `boundary` is set for `eligible`
and `not-yet`, `owner` and `timing` for an active claim, `transition` (both display names) for a claim with an
unresolved transition (its `boundary` is the hull, see "Time path"), and `claimGeneration` whenever the stored
state has one.

What batch reclaim does not promise:

- No transaction over several tickets, no rollback and no all-or-nothing.
- The candidate list is no atomic snapshot of the coordination area.
- No batch budget, size limit or pagination: the runtime grows with each candidate, up to
  `operation_budget_ms` per candidate plus its preflight.
- It stops only on faults proven for the whole call. A shared remote permission fault, such as an expired
  token, is not detected: each ticket then ends `unknown` or `rejected` with its own open operation.
- No batch journal. A lost output is recovered through the operations of each ticket, which later calls of
  the same context report as `paused` with their IDs.

## Dependency policy

`claims.acquire_dependency_policy` decides whether `claim acquire` checks prerequisites. It is optional and
never written by `claim setup`; without it the policy is `strict`.

- `strict`: before any network, `claim acquire` reads every local task and refuses a ticket that has an
  unfinished prerequisite (`dependency-blocked`) or only prerequisites that do not name exactly one local task
  (`dependency-unknown`). A ticket that is itself finished stays acquirable. Nothing is recorded or sent;
  unreadable local tasks end `tasks-unavailable`.
- `permissive`: no check and no task read. The claim reserves the ticket; it does not certify that the ticket
  is ready.

The ready selection of `claim next` is always strict and never reads the key. `renew`, `release`, `reclaim`,
`transfer`, `resume`, `change-bounds`, `resolve`, `retry` and `list` never check prerequisites, so a
prerequisite reopened after the claim never takes the claim away.

## Emergency release and new epochs

`claim emergency-release` frees the claim of one ticket without its holder. It is the way out when a holder is
gone and its claim never becomes reclaimable, as a claim in `lifetime_mode: none`, or must be freed before its
reclaim boundary. It is an operator's command: it is not offered over MCP, and it never frees more than one ticket.

`emergency-release` needs a context whose authority ID is listed in `claims.recovery_authorities`, and the
exact root from `--preview`. It frees the claim and nothing else: nobody is assigned, the former holder is not
stopped and learns it from its next renew or list, and a running `claim next` loop may take the ticket at once.

1. `backlog claim context show --context <operator handle> --json` prints `contextId` and `authorityId`.
2. Add the `authorityId` to `claims.recovery_authorities` in the project configuration and commit it. The grant
   is a change of the versioned configuration, so it can be reviewed like any other change.
3. Set the task's status or assignee, or stop the workers, first; otherwise a `claim next` loop may take the
   freed ticket at once.
4. `backlog claim emergency-release <ticket> --context <operator handle> --preview --json` prints the
   `claim-emergency-preview` document. Check its `root` against the endpoint, for example with
   `git ls-remote <endpoint> refs/claims/<ticket>`.
5. `backlog claim emergency-release <ticket> --context <operator handle> --expect-root <root> --json` frees the
   claim at exactly that root.

What the command checks and does:

- The authority ID is `ta1-` and a SHA-256 digest derived from the context's own secret. It is not the binding,
  and it is no password: only the context that holds the secret has it. A context made with `--recover-from` has
  its own authority ID, never its source's.
- The authorisation is checked locally, before any network: without the key or without the ID in the list the
  command ends `authority-required`, and nothing is recorded or sent. `--preview` needs the same authorisation.
- Exactly one of `--preview` and `--expect-root` is required (`expectation-required`), and a root has 40 or 64
  lowercase hex digits (`invalid-option`). `--owner`, `--ttl-ms`, `--expect-generation` and every other claim
  option are `option-not-applicable`; there is no force flag.
- The preview reads the ticket once. It sends, records and pauses nothing. `state` is `active`, `free`,
  `pending`, `unknown` or `absent`; `claimGeneration`, `epoch` and `root` are `null` when the ticket has no
  claim ref (`absent`) or cannot be read (`unknown`). It is the only document that prints a root.
- The release writes the free state with the stored generation, for an active claim and for a pending one (with
  the generation of its target), whoever holds it, in every mode and at any time. The generation grows only at
  the next acquire. A root that changed since the preview ends `rejected` with `stale-root`, and so does a ticket
  without a claim ref; nothing is recorded or sent. A root that moves between the release's read and its push
  ends `rejected` at the storage lease. A free ticket ends `rejected` with `free`, a corrupt or unsupported
  stored state `state-corrupt` or `state-unsupported`.
- It runs under `enabled: false`. It records one operation in the operator's journal and stores one receipt
  under its own operation ID beside the former holder's, which stay readable. The former holder's journal is
  never read, and a late write of the former holder fails at the moved root.
- `claim retry` of a release record checks the authorisation again and resends only while the context is
  listed; otherwise it ends `authority-required`. `claim resolve` answers for it like for any record. Over MCP,
  `claim_retry` refuses a release record with `authority-required`.
- Anyone who can commit the project configuration can list their own context: a checkout owner can list
  themselves. The list is no protection against direct Git manipulation, like the rest of the coordination area.

`backlog claim install-epoch` installs the next epoch of the coordination area: after the area was restored from
a backup, or to change its storage format. The new epoch ends every claim at once. Every ticket becomes free, with
the next generation when its old state was readable and generation 1 otherwise, and the workers acquire again.
Like `emergency-release` it is an operator's command: it needs a context whose authority ID is listed in
`claims.recovery_authorities` (`authority-required`), it is not offered over MCP, and it runs under
`enabled: false`.

1. Stop the workers. Cut off every write path to `refs/claims/*` and `refs/claim-meta/*` at the endpoint, pushes
   already in flight and the creation of new refs included.
2. `backlog claim resolve <operation-id> --context <handle> --json` settles what can still be settled. After the
   new epoch every earlier operation answers `unknown-history`.
3. `backlog claim init --json` prints the current `epoch`. Then
   `backlog claim install-epoch --context <operator handle> --expect-epoch <epoch> --isolation-confirmed --preview --json`
   prints the `claim-epoch-preview` document and writes nothing.
4. `backlog claim install-epoch --context <operator handle> --expect-epoch <epoch> --isolation-confirmed --json`
   installs the next epoch. Add `--storage-format <format>` to change the format, and `--ticket <ticket>` for a
   ticket without a local task file that needs a claim ref.
5. After a format change, set `storage_format` in the project configuration and commit it. The command never
   changes the configuration, so until then every checkout ends `format-mismatch`.
6. Lift the isolation and restart the workers.

What `install-epoch` checks and does:

- `--expect-epoch` is required: the epoch the descriptor holds now, digits only, from 1 (`invalid-option`
  otherwise). `--isolation-confirmed` is required too (`isolation-unconfirmed`): it is your statement that every
  write path is cut off. `--storage-format` is `blob`, `tree` or `commit-chain`; without it the format stays.
  `--ticket` is repeatable and takes a ticket ID (`invalid-ticket`). There is no force flag and no
  `--operation-id`.
- The options, the configuration, `--isolation-confirmed` and the authorisation are checked before any network,
  and only the local task files are read besides them. `--preview` needs the same.
- The run reads the descriptor. Another epoch than `--expect-epoch` ends `claim-epoch` with status `rejected` and
  `cause: "epoch-changed"`. It lists the claim refs, reads every listed ticket once for its generation, and lists
  them again right before it swaps the descriptor; any difference ends `rejected` with
  `cause: "writes-observed"`. It then swaps the descriptor to the next epoch, leased on the descriptor it read: losing
  that swap to another run ends `rejected` with `cause: "epoch-changed"` as well, and an endpoint that refuses
  the swap ends `remote-rejected`. A `rejected` run wrote nothing. `epoch-changed` and `writes-observed` are
  causes of `claim-epoch`, not error codes.
- From the swap on every client reads each claim of the old epoch as unreadable: `unknown` in `claim list`, never
  free. The run then keeps each listed ticket's old root under `refs/claim-archive/<old epoch>/<ticket>`,
  rewrites the ticket ref as a free claim of the new epoch, creates a free claim for every local task without a
  claim ref (finished tasks included) and for every `--ticket`, and lists the refs a last time. Every root it
  writes is new, no ref is deleted, and the archived roots keep every earlier receipt readable.
- The result is `applied` (exit 0) when every write applied and the last listing shows only the roots the run
  wrote. A ticket ref the run did not write, or on another root, is listed in `breached`, a ticket whose write
  did not apply in `unsettled`. Any of them, a failed last listing or a run that stopped after the swap ends
  `unknown` (exit 3): cut the write paths off again and rerun with `--expect-epoch` set to the reported `epoch`.
  Every run installs the next epoch and rewrites everything; there is no resume.
- The run records nothing in a journal. Each new claim carries one maintenance receipt with your statement. An
  operation recorded before the new epoch is never sent again: `claim retry` and `claim resolve` answer
  `unknown-history`. After a format change a record of the old format is `format-mismatch` for `claim retry`
  while the checkout still carries the old format, and `scope-mismatch` once it carries the new one.
- Compare generations only within an epoch: every `claim list` entry with `claimGeneration` also carries `epoch`.

None of these proves that no write is still in flight: deleting refs, an empty `claim list`, a client timeout, or two
scans that show the same refs. `--isolation-confirmed` records your statement in every new claim; it proves nothing
either. `install-epoch` detects some writes that break isolation, never all. A difference between its first two
listings ends the run `rejected` with nothing written; a ticket ref in its last listing that the run did not write, or
a change in the number of names under `refs/claims/*` that are no ticket ID, ends `unknown`; such names that stood
before the run are counted and left alone; no difference is no evidence.

This path was measured in Linux containers against a plain Git 2.47.3 server (`git daemon`,
`git http-backend`, OpenSSH 10.0p2) and Gitea 1.24.7 (its HTTP and built-in SSH server), with clients
running Git 2.47.3: both hosts accept, list and keep `refs/claims/*` and `refs/claim-meta/*` in all three
storage formats, through the host's garbage collection too. On the plain Git server, `install-epoch` behaved
as described above: over `https://` and `ssh://`, an old-epoch write released after the swap ended `rejected`
and one that landed between the swap and the rewrite left the run `unknown` with that ticket unreadable until
a rerun settled it; over `ssh://`, a restore followed by `install-epoch` freed every ticket. That qualifies no
host's isolation: no host was shown to cut off the write paths for you, and the path is not qualified on a
host where:

- the operator cannot restrict writes to `refs/claims/*` and `refs/claim-meta/*`, the creation of new refs
  included, to the maintenance run;
- pushes that already passed a new gate can neither be stopped nor awaited;
- replicas or mirrors accept pushes and replicate them asynchronously;
- the host rejects, hides or prunes refs outside branches and tags (the two hosts above keep them, other hosts
  and versions are unmeasured);
- clients of an older Backlog.md are still in use: they read every epoch but 1 as unreadable, so update every
  client before the maintenance.

## Configuration

`backlog claim setup` writes twelve keys. Three more keys are optional and never written by `setup`:

- `claims.transfer_time_box`: `require-explicit`, `preserve` or `restart`. It supplies the time-box action
  of `claim transfer` when `--time-box` is absent; an explicit `--time-box` always wins. Without the key the
  behaviour is `require-explicit`. It is valid in every `lifetime_mode`. An empty, mistyped, unknown or
  repeated value makes every command that reads the claims block end with `config-invalid`, before any
  network.
- `claims.acquire_dependency_policy`: `strict` or `permissive` (see "Dependency policy"). Without the key the
  behaviour is `strict`. The same validation applies: it is valid in every `lifetime_mode`, and an empty,
  mistyped, unknown or repeated value ends every command that reads the claims block with `config-invalid`.
- `claims.recovery_authorities`: a list of authority IDs, each `ta1-` and 64 lowercase hex digits as
  `backlog claim context show` prints it (see "Emergency release and new epochs"). Without the key nobody may
  run `claim emergency-release` or `claim install-epoch`. It is valid in every `lifetime_mode`; a value that is not a list, an entry of
  another form, an empty value or a repeated key ends every command that reads the claims block with
  `config-invalid`.

Claims are qualified on Linux only; macOS, Windows and NFS are unqualified.

## Versioning

`schemaVersion` is 1. New codes, kinds and optional fields may appear without a version change; treat an
unknown code by its `status`. A new `status` value or a removed field raises `schemaVersion`.

## Clock uncertainty and budget

`claims.clock_uncertainty_ms` is the largest deviation of any host clock from the true time that operation
assures; it has no default and a configured value proves nothing by itself. Nothing checks it. A clock that
runs ahead by more than `clock_uncertainty_ms` can reclaim a claim before its reclaim boundary; a clock that
lags by more still reads its own work right as `live` after the hard end and can record a false witness on the
time path. Each window is as long as the excess over `clock_uncertainty_ms`. Repeated sends pause with full
jitter between 0 and `min(retry_pause_max_ms, retry_pause_base_ms · 2^(n−2))` milliseconds. The budget
`operation_budget_ms` starts before the preflight and stops every further pause and send once it is spent; a
send stopped by the budget ends `unknown` with `stoppedBy: "budget"`. The preflight itself and one in-flight
Git command are not cut short: each may run up to `attempt_timeout_ms`, so a command can overrun the budget by
that much. Size your own timeout accordingly.

## Owner and ticket changes

To follow who holds a ticket and whether the ticket changed, join two reads on the canonical ticket ID:

1. `backlog claim list --ticket <ticket> --json` (or without `--ticket` for every claim) gives `observedAt` and,
   per entry, `owner`.
2. `backlog task list --json --revision` gives `revision` and `updatedAt` per task `id`. `revision` is `sha256:`
   plus the SHA-256 of the task file's bytes, or `null` when the file vanished while listing.

Keep both, read again later and compare revisions; never infer fields from them. A new `revision` says only that
the file changed: read the task to learn what changed. `updatedAt` misses hand edits. A ticket that appears only in
the claim list is not a local task. A ticket that leaves the task list (completed, archived or demoted) counts as
changed.

`--revision` reports what this working copy holds. It is not a watch engine and does not capture every foreign
change: edits on other branches or remotes appear only once they reach this working copy, and `--watch` may
coalesce intermediate edits.
