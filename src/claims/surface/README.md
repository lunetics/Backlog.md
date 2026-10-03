# Claim surface core

This module is the shared core behind `backlog claim <verb>` (`src/commands/claim.ts`); the MCP
claim tools (`src/mcp/tools/claims/`) reuse it unchanged. It composes the preflight and init of `../config`, the
executor and `resendClaimIntent` of `../execution`, the query of `../query` and the rights of
`../rights` into closed public documents. It has no parser, planner or resolver of its own.

## Documents

Every `runClaim*` function returns exactly one document
`{ schemaVersion: 1, kind, status, command, ... }` with the fixed key set of its kind:
`claim-operation`, `claim-pause`, `claim-resolution`, `claim-list`, `claim-next`,
`claim-reclaim-batch`, `claim-reclaim-preview`, `claim-emergency-preview`, `claim-epoch`,
`claim-epoch-preview`, `claim-setup`, `claim-init`, `claim-context` or `claim-error`. `status` decides the exit code through
`CLAIM_EXIT_CODES`; every error code has one status in `CLAIM_ERROR_CODES`. The CLI guide
`claims` carries both tables, and a test compares them with the constants.

Documents are built field by field. Every copied value is checked against its enumerated
range first; an upstream object is never spread, an upstream `reason` is never copied, and
`message` comes from a fixed table keyed by code. The human renderer
(`../../formatters/claim-text.ts`) takes only the document, so both output modes share
this allowlist.

Never in any document or text: a binding or recovery binding, a secret, a context, parent
or journal path, an endpoint or URL, a receipt or digest, a root or OID (`observedRoot`
included), Git stderr, an upstream reason, or the intent fields `remote`, `parameters` and
`targetBinding`. The one exception is `root` of `claim-emergency-preview`: the operator checks it
against the endpoint and passes it back. `owner` appears only in `claim-list` and
`claim-reclaim-preview` entries and in `claim-emergency-preview`, as display data, `contextId` only
in `claim-context`, and `authorityId` only in the `claim-context` of `context show`. The scope and
filter values of a batch or preview are never echoed. Instants are integer epoch milliseconds,
durations end in `Ms`.

## Mapping

- Executor `operation`: `storage`, `outcome` and `rights` stay three separate facts.
  `not-sent` (admission causes included) is `unavailable`; a first-send rejection carries
  `rejection: { stage: "storage", cause }`, a queried `not-stored` carries
  `{ stage: "resolution", cause: "not-stored" }`.
- Executor `not-planned`: a plan rejection is `rejected` with `operationId: null`,
  `stage: "plan"` and the boundary when the plan has one; `corrupt`, `unsupported`,
  `invalid` and `unknown` plans are `state-corrupt`, `state-unsupported`,
  `request-invalid` and `state-unknown`.
- Executor `paused`: `claim-pause` with exit 7, the own open operation IDs as data and
  `retry` as the way out. `resolve` and `list` never pause.
- Top-level executor failures lie before any send: `unknown` there is `unavailable`
  (`storage-unreadable`), never `unknown`.
- An unexpected error after the executor or resend call is `status: "unknown"` with code
  `internal` and the operation ID: the change may have been sent.
- `resolve`: `stored` applied, `not-stored` rejected, `open` unknown, `conflict` and lost
  history unknown-history; journal failures are refusals (`operation-not-found` never means
  "never sent").
- `list`: every non-ready preflight verdict is an error, never an empty list; unreadable
  tickets, skipped ref names and tickets left when the budget runs out are
  `state: "unknown"` entries and make the list `complete: false`, status `unknown`. An entry
  with `claimGeneration` carries `epoch`, the descriptor's epoch, so
  generations are compared only within an epoch.
- `init`: `unknown` stays `init-unknown` (status `unknown`), never ok.

## Mutating commands

`runClaimMutation` serves acquire, renew, release and reclaim (the base commands) and transfer,
resume and change-bounds (the administration commands); the command name is the action name. It
takes these steps in order and ends at the first failure:

1. The monotonic start of the budget, before anything else.
2. Input checks without IO, in this order: ticket; owner (acquire, transfer); explicit
   absolute `--context`; explicit absolute `--to-context` (transfer,
   `target-context-invalid`); operation ID (journal rule); the numbers `--ttl-ms`,
   `--expect-generation` and `--grace-ms` (`>= 0`); the instants `--hard-end` and
   `--lease-end` (ISO-8601 with a zone); the values of `--time-box` and `--mode`; fields
   the command does not use (`option-not-applicable`); the completeness of a bound change
   (`bounds-required`). The base verbs refuse only the fields the administration commands introduced
   and stay lenient for their own.
3. The configuration through the config resolver (`claims.transfer_time_box` included), then the
   surface keys: all three for mutating commands and `retry`, eps only for `list --context`.
   The transition request is built from the options and the lifetime mode as plain object
   literals (`hard-end-required`, `option-not-applicable`); a bound change must pass
   `isClaimTiming` (`invalid-option`) and takes nothing from the configuration.
4. Acquire only: the ticket must exist locally, before any network. Then the dependency gate: unless
   `claims.acquire_dependency_policy` is `permissive`, the corpus from `env.loadLocalTickets(null)`
   must not show the ticket blocked (`isBlocked` of the shared ready rule): `dependency-blocked` for
   an unfinished prerequisite, `dependency-unknown` for only unresolvable ones or a ticket without a
   single local record, both refused with `dependencies`; an unreadable corpus is
   `tasks-unavailable`. Nothing is recorded or sent. No other command checks prerequisites.
5. Transfer and resume only: the context pre-check through `env.contextIO`. The own
   context first (`context-invalid`, `context-corrupt`, `context-unavailable`), then for
   resume a recovery proof (`recovery-missing`; the proof itself is never read here), for
   transfer the target context (`target-context-invalid`, `target-context-unavailable`,
   and `target-context-invalid` when it has the own binding). The target is read only.
6. The shared preflight with the command's purpose: `acquire` for acquire and for a transfer
   restart with `--hard-end` (it can extend a right), `maintain` for every other
   command, so the other administration calls stay allowed under `enabled: false`.
7. The budget check: nothing is prepared once it is gone (`budget-exhausted`, no ID).
8. The operation ID: the caller's must be free in the journal (`operation-id-in-use`), a
   generated one is `op-<uuid v4>`.
9. The executor with the send schedule, the planned-display callback and `timePath:
   settings.enabled`; a transfer passes `targetContextDirectory`, no other command does.
   `planned.capped` of a transfer follows the lease TTL like renew; resume and change-bounds
   use the stored ends like `retry`.

`--hard-end` on transfer is refused with `--time-box preserve` in stage 1 (the input
checks of step 2) and, after the configuration, whenever the resolved time box is not a restart
(`option-not-applicable`); it goes into the restart's time box as an absolute instant.

`emergency-release` is the eighth mutating command, an administration command like transfer, resume
and change-bounds:

- Step 2 adds, right after `--context`: exactly one of `preview` and `expectRoot`
  (`expectation-required`), and a root of 40 or 64 lowercase hex digits (`invalid-option`). Every
  other option field, `expectGeneration` included, is `option-not-applicable`; `preview` on any
  other command is too.
- After the configuration and before the preflight, the authorisation: `claimContextAuthority` of
  `--context` (its failures keep the context codes) must be listed in `claims.recovery_authorities`,
  else `authority-required`. Nothing before it starts a Git command or touches the journal.
- The preflight purpose is `maintain`, so it runs under `enabled: false`.
- A preview then reads the ticket once through the preflight's store and answers
  `claim-emergency-preview`: `ticket`, `state` (`active`, `free`, `pending`, `unknown`, `absent`),
  `owner` on active and `transition` on pending (the list entry's values), `claimGeneration` and
  `epoch` from the stored document and `root`, each `null` for an absent or unreadable ticket. No
  budget, operation ID, journal, pause or send.
- A release goes on like every mutation, with the request `{ action, expectedRoot }` through the
  unchanged executor. `stale-root` is a plan rejection (rejected/2, no operation ID, no record).

`runClaimRetry` loads the record first. A record whose action is `emergency-release` ends
`authority-required` unless the third argument is `{ administrative: true }`, which only
`src/commands/claim.ts` passes after it re-checked the configured list against the authority ID
of `--context`; MCP calls with two arguments and so never resends a release. Then it checks the
record's endpoint and format against the configuration (`scope-mismatch`) and, for an acquire
record and a time-path call's P record, `enabled`; a confirmation (A) record is allowed while
disabled. A record of another epoch than the descriptor skips the
`enabled` check: `resendClaimIntent` compares the same epochs and answers it unsent, so the retry
ends `claim-operation` `unknown-history`/4 with `sends: 0`, never `scope-mismatch`; a record of
the old format after a migration stays `scope-mismatch`. Then it calls `resendClaimIntent`,
which never plans, never makes a new ID and never pauses. `runClaimResolve` reads a release record like any other.
`runClaimResolve` answers a P ID with the composite outcome (`queryClaimTransition`) and every
other ID, an A ID included, with the single one.

`ClaimSurfaceEnv.loadLocalTickets(selection | null)` is mandatory, so no surface can drop
the gate. A selection is the shared `TaskListFilter` of `task list` plus the search query
(`src/commands/task-filter-options.ts` maps the flags); the CLI answers it with the same
calls as `task list --ready`: `Core.queryTasks` on the working copy and `loadTaskCorpus`
for readiness over every local task and the completed records.

## claim next

`runClaimNext` has a pre-phase with its own read budget, then a loop:

1. Input checks without IO: owner, explicit absolute `--context`, `--order`
   (`priority` or `age`), `--max-candidates` (integer 1 to 50, default 5), `--ttl-ms`,
   `--hard-end`. There is no `--operation-id`. (The CLI maps the task filter flags
   before calling the core, reading the configuration and, for `--parent`, task files;
   an invalid filter is therefore reported before these checks.)
2. The configuration with the three surface keys, then the acquire request as for acquire.
3. The local selection: `loadLocalTickets(selection)`, then `selectClaimCandidates`
   (pure): the shared ready rule over the whole corpus, the order of
   `compareByPriorityThenAge` or `compareByAge` (`utils/task-sorting.ts`), counts of
   blocked, unresolved and finished tickets, diagnostics with canonical IDs only. An empty
   selection ends `no-candidates` without network.
4. The preflight with purpose `acquire`. A disabled block goes on to the loop, whose first
   attempt ends `claims-disabled`.
5. The acquisition stop: one `listClaimRefs` (with `roots`) and this context's journal
   through `evaluateClaimAcquireStop` of `../pause`. An own acquire still open at its
   listed root stops the call `paused` (`outstanding-acquire`); an unreadable journal stops
   it `paused` (`journal-unknown`); a failed listing is `list-unavailable`. Open intents of
   other actions are the maintenance operations of the next step.
6. `driveClaimNext`: each candidate once, at most `maxCandidates` attempts, each one
   `runClaimMutation` acquire with its own budget and operation ID; `claimNextStep` (pure) decides
   after each attempt.
7. `claimNextDocument`, built field by field; the attempts stay the unchanged documents.

`runClaimContextCreate` passes an optional `recoverFrom` to `createClaimContext`, which
validates that context before it creates anything. Its failures keep the `context create`
codes (`context-invalid`, `context-corrupt`, `context-unavailable`), and the document names
only the new context ID, never the source.

`runClaimContextShow` is local like `context create` and reads no project
configuration: it loads the context and answers `claim-context` with `command: "context-show"`,
`contextId` and `authorityId`, nothing else of the context. `context create` never carries
`authorityId`. Failures keep the context codes.

## install-epoch

`runClaimInstallEpoch` is a storage operation beside the executor:
no journal, no operation ID, no pause, no budget (each Git command has `attempt_timeout_ms`), never
over MCP. Its steps, each with its abort rule:

1. Without IO: `--context` (context codes), `--expect-epoch` a safe integer from 1 whose successor
   is safe too, `--storage-format` one of the three formats (both `invalid-option`), every
   `--ticket` a ticket ID (`invalid-ticket`). Then the configuration, `isolationConfirmed`
   (`isolation-unconfirmed`), the authorisation of `emergency-release` (`authority-required`)
   and the local corpus (`loadLocalTickets(null)`, completed tasks included; `tasks-unavailable`).
   No Git command runs before the preflight, whose purpose is `maintain`.
2. The descriptor the preflight read: another epoch than `--expect-epoch` is `claim-epoch`
   `rejected` with `cause: "epoch-changed"`.
3. `listClaimRefs` (L1) and one read per listed ticket through the preflight's store, for the
   generation only: one more than a readable ACTIVE, FREE or PENDING state of the old epoch, else
   1. A read that fails (not `corrupt` or `absent`) is `storage-unreadable`. The creation set is
   every local task and every `--ticket` without a ref in L1. `--preview` answers here with
   `claim-epoch-preview` (`epoch` the one a run would install, `format`, `listed`, `toCreate`,
   `unreadable`), status `ok`. Then the seam `installEpochSeams.afterFirstListing`; a throw there
   is `internal`, nothing was written.
4. `listClaimRefs` again (L2): another name, root or count of skipped names is `rejected` with
   `cause: "writes-observed"`.
5. `swapClaimEpoch` on the preflight's store: a lost CAS is `rejected` `epoch-changed`, a
   refusal with the descriptor unchanged, or with a re-read that fails, `remote-rejected`, an unknown
   push outcome `unknown`.
   Then the seam `afterDescriptorSwap`; from here any throw ends `claim-epoch` `unknown`.
6. `installClaimEpoch` with every ticket of L2 (leased on its L2 root) and of the creation set,
   each a FREE tombstone with its generation.
7. `listClaimRefs` once more (L3): every ticket whose ref is extra, missing or on another root
   than the run wrote, unless unsettled, is `breached`.

`claim-epoch` has `fromEpoch` (the expected epoch), `epoch` (the one installed or tried, also the
rerun hint), `format`, `previousFormat`, the ticket lists `rewritten`, `created`, `breached` and
`unsettled` in the order of `claim list`, `isolation: "attested"`, and `cause` on a rejection
only. `applied`/0 needs every write applied and a clean L3; a breach, an unsettled ticket, an
unreadable L3 or an interrupted run is `unknown`/3, `rejected`/2 wrote nothing. No document of
the command names a root, a receipt or a path.

## Batch reclaim and preview

`runClaimReclaimBatch` and `runClaimReclaimPreview` share one selection:

1. `claimReclaimScope` (pure) checks the scope before `--context`, configuration and network:
   a blank-valued option, the shared filter module's `blankOptions` report included, and a
   missing scope are `scope-required`; `--all` next to another option is `invalid-option`; a
   bad ticket is `invalid-ticket`. Explicit tickets become canonical, deduplicated and
   `compareTaskIds`-ordered; `--claim-owner` stays byte-exact. (The CLI maps the task
   filter flags before calling the core, reading the configuration and, for a non-blank
   `--parent`, task files; an invalid filter is therefore reported before this check.)
2. The configuration (all three surface keys for the batch, eps for the preview), then ticket
   filters and `--ready` through `env.loadLocalTickets` (the seam of `claim next`, the shared ready
   rule) before any network; an unreadable corpus is `tasks-unavailable`.
3. The preflight, `maintain` for the batch and `observe` for the preview; both run under
   `enabled: false`.
4. Explicit tickets are read directly, every other scope starts with one `listClaimRefs`.
   `readAll` shares one `operation_budget_ms` from the start of the call; one clock read after
   it is `observedAt`. `claimReclaimVerdict` (pure) maps `planClaimTransition` with
   `{action: "reclaim"}` onto the verdict and takes the boundary from `evaluateClaimRight`; there
   is no second reclaimability rule. The preview adds `evaluateClaimOperationPause` over a
   read-only `enumerate` of this context's journal.

The batch fixes its candidates from that one selection: every `eligible` ticket with its
observed generation, and every corrupt or unsupported state with the single core's refusal.
Each candidate runs `runClaimMutation` reclaim with `expectGeneration`, so it gets its own
fresh read, plan, CAS, operation ID, budget, pause and admission. `claimReclaimStops` (pure)
ends the loop on the closed list of call-wide faults; `claimReclaimBatchDocument` (pure) ranks
the entry statuses. An unexpected error after the first single reclaim is `unknown` with code
`internal`, before it `internal`.

What batch reclaim and preview do not guarantee:

- **No multi-ticket transaction.** Each ticket is its own conditional mutation; there is no
  rollback and no all-or-nothing, and reclaimed tickets stay free after a later failure.
- **The candidate set is no atomic snapshot.** It is chosen once per call; a claim that becomes
  reclaimable later is taken only by a later call.
- **The preview reserves nothing and promises no later result.** The batch takes no preview as
  a plan and checks every ticket again.
- **No batch budget, size limit or pagination in V1.** The runtime grows with each candidate:
  up to `operation_budget_ms` per ticket plus its uncapped preflight.
- **Stops only on proven call-wide faults from shared checks** (configuration, context,
  descriptor, journal view). Transport errors, timeouts and remote rejections count as
  ticket-local. A shared remote permission fault is not detected: each
  affected ticket ends `unknown` or `rejected` with its own open intent, cleared later by
  `retry`.
- **Filters are neither permission nor readiness.** `--claim-owner` compares the stored display
  name, never an identity; `--assignee` is no owner check.
- **Ticket filters see local task files only.** A claim without a local task file is reachable
  through `--ticket`, `--all` or `--claim-owner`.
- **No batch journal.** A lost output is recovered only through the per-ticket intents, which
  later calls of the same context report as a pause with their IDs.
- **Per ticket, every guarantee and limit of the single reclaim applies**, since each entry is
  the document `claim reclaim <ticket> --expect-generation <g>` prints.

## Pauses and budget

`claimOperationSchedule` is the policy behind the executor's `schedule` option. A gate
before send `n >= 2` draws once and pauses `floor(random · (window + 1))` with
`window = min(retry_pause_max_ms, retry_pause_base_ms · 2^(n−2))`. It stops without
sleeping when the pause would reach the deadline `startedAt + operation_budget_ms`, and
stops after the sleep when the deadline passed meanwhile. Each Git command gets
`max(1, min(attempt_timeout_ms, remaining))`. A stop, or an unknown outcome reached past
the deadline, is `stoppedBy: "budget"`; an intent still open after the last permitted send
is `stoppedBy: "attempts"`. Clock, monotonic clock, random, sleep and the ID generator are
injected (`ClaimSurfaceEnv`).

## Excluded guarantees

- **The budget is not exact.** The preflight runs with `attempt_timeout_ms` uncapped, and
  the store the executor opened before the deadline keeps its timeout, so a command can
  overrun the budget by one per-command timeout (V1).
- **No execution admission.** `applied` and `rights` describe observed state; they do not
  permit an external effect.
- **No fairness, no queue.** The claim-next order is only the order of local attempts; two
  agents with the same filters meet at the same first candidate.
- **The local ticket state is the input.** No fetch, merge or comparison with another
  branch; a ticket finished elsewhere can be selected.
- **Ready is no work right.** A claim certifies no readiness; a prerequisite reopened after
  the claim leaves the claim in place, and no observer reports it.
- **Permissive reserves without certifying readiness.** Under
  `acquire_dependency_policy: permissive` a direct acquire skips the gate.
- **At most one ticket per `claim next` call**, no multi-ticket reservation.
- **The bound limits attempts, not time.** A call runs up to about the pre-phase plus
  `maxCandidates × (operation_budget_ms + attempt_timeout_ms)`.
- **The acquisition stop sees only this context's journal and has no liveness.** An own
  acquire that never landed blocks `claim next` of this context until its ticket root moves
  on or `retry` settles it; a finally rejected intent needs a new context. Other instances,
  contexts and hosts are not seen, and direct acquires of other tickets are not affected.
  The candidate list is a snapshot.
- **Filters are no ownership check.** `--assignee` is not the owner, `--unassigned` is not
  "unclaimed"; `claim next` changes no assignee, status or task file.
- **Unreadable task directories read as empty.** `claim next` then ends `no-candidates`,
  while the gate refuses over the unresolved prerequisites.
- **An unreadable ref of one candidate stops the whole call**, because the executor cannot
  tell a read error from a network error.
- **No label exclusion, no claim-own filters and no MCP `next`** in this slice.
- **No cross-host transfer.** `--to-context` must be a context the calling process can load:
  same host, same user ID. A wrong but valid target gets the claim; only a transfer by the
  receiver, a release, a reclaim or an emergency release moves it again.
- **No acknowledgement, no notice, no ticket change.** A transfer neither waits for nor
  notifies the receiver and changes no assignee, status or task file; it has no dependency
  gate.
- **`rights` after a transfer is the source's view.** The receiver's right is not checked
  here; the receiver reads it with `claim list --context`.
- **The target context is read only.** Its journal records are never read, and a `retry`
  of a transfer never reads it again, because the record is frozen.
- **The pre-check is advisory.** The executor checks the own context, the recovery proof and
  the target again. When a context changes between both reads, the executor's generic codes
  appear with the same status: `request-invalid` or `context-corrupt` (refused),
  `local-unavailable` (unavailable).
- **Resume is one hop.** It imports no journal of the old context (only the old context
  clarifies its operations through `retry` or `resolve`), renews no lease window and revives
  no work right after the hard end.
- **change-bounds is absolute.** It extends only by a later hard end over the time path (no
  removed hard end, no later reclaim boundary under an unchanged one), never changes the mode
  and never touches a foreign claim. A target equal to the stored timing is still a write.
- **The time-box policy replaces only the time-box action.** `claims.transfer_time_box`
  never replaces a rights, ownership or deadline check; a configuration change alone changes
  no stored claim and no recorded operation.
- **`capped` on resume and change-bounds** only says that the stored lease end sits on the
  hard end; no window was computed.
- **Handles are not protected against copies.** A copied context directory cannot be told
  apart from its original.
- **The human text is not an interface.** Only the `--json` document is.

## Time path

A change-bounds to a later hard end and a transfer restart with a later `--hard-end` run over
the time path when `enabled` is true (see `../execution/README.md`); with `enabled: false`
the extension stays `rejected` with `requires-time-path` and the restart is `claims-disabled`.
The documents are additive to those described above:

- `claim-operation` of a T call adds `transition: {phase, confirmOperationId, observeBefore,
  reclaimBoundary, confirmation}`; `operationId` and `storage` are P's, `sends` counts P and
  A, `planned` shows the target, `confirmation` is A's storage view or `null`. A D document
  keeps exactly its base keys. `status` stays a function of `outcome`: confirmed and a witness
  whose A the query shows not stored (the root moved past p) are applied/0, witnessed with A
  open or unsent and pending are unknown/3, P rejected or not stored rejected/2, P not sent
  unavailable/6, unresolved history unknown-history/4. A is always sent as a re-send: after a
  lost reply it goes out again while the query shows it open at p (up to `attempts`), and a
  rejected A still open at p stays unknown/3 with the retry hint. `stoppedBy` reads A's fact
  once a witness has one.
- `claim-resolution` of a P ID adds `transition: {phase, confirmOperationId}`; its `query` is
  P's single resolution and `outcome` the logical one.
- A `claim-list` entry of a PENDING ticket has `state: "pending"`, `claimGeneration`,
  `transition: {from, to}` (both display names, list only), `reclaimBoundary` (the hull) and
  optional `rights`, never `owner` or `timing`. `rights` shows ownership and cause `pending`.
- The plan cause `pending-transition` carries the hull as `boundary`; there is no new error
  code. `claim next` continues past it. A preview entry of a PENDING ticket has
  `transition: {from, to}` instead of `owner` and `timing`, verdict and boundary from the
  hull, and `--claim-owner` keeps it when the source's or the target's owner is listed.
- The text adds a `phase` line and, for `witnessed`, `backlog claim retry <A-ID> --context
  <context>`; `requires-time-path` and `pending-transition` have their hints.

Excluded guarantees of the time path:

- **No work right from PENDING**, for anybody, and none from publishing a witness: `rights`
  is always the caller's fresh rights view.
- **No server time authority**: a clock that lags by more than `clock_uncertainty_ms` can
  record a false witness.
- **The source stops work before sending**, a workflow duty.
- **No rescue of a lost witness**: no export or import, no observation by another context (a
  replacement context gets `operation-not-found` for both IDs), no re-observation after the
  stored hard end. PENDING blocks until the hull; the history may stay `unknown-history`.
- **No liveness**: nobody publishes A automatically; `retry` of the A ID is the way out.
- **Not in V1**: removing a hard end, a later reclaim boundary under an unchanged one, a
  restart without `--hard-end`, a second unresolved transition per ticket.
- **`applied` says nothing about current ownership**, and A is no acknowledgement by the
  receiver.
