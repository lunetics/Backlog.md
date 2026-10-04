# Internal single claim transition executor

This module is an internal building block, not a public library or a complete
claim feature. The canonical claim CLI reaches it only through
`src/claims/surface/`, and so do the MCP claim tools. It composes the
qualified claim modules for exactly one acquire, renew, release, reclaim,
transfer, resume or change-bounds and adds no second parser, resolver, clock
rule or default. Every `operation` result carries `scope:
"transition-execution-only"`.

## Sequence

`executeClaimTransition` runs these steps in order; a failing step ends the call.

1. Capture and check every option before the first await: the request through
   the request parser (`parseClaimTransitionRequest`), the canonical ticket,
   the caller's operation ID under the journal identifier rule (at most 128
   characters), a positive safe-integer `attempts` without default, a
   nonnegative `clockSkewMs`, a clock function and the IO seams. The endpoint
   syntax is not checked here but by `openClaimStore` in step 4, still before
   any Git call; an invalid endpoint together with a failing context therefore
   reports the context failure. `targetContextDirectory` is a string exactly
   for a transfer request and absent for every other action; its path is
   checked by the context loader in step 2.
2. Load the explicit context. `context.binding` and
   `context.journalDirectory` are used; the recovery record only by a resume.
   Two local steps follow, both before the journal:
   - Step 1a (resume only): `context.recovery.binding` of the same load is the
     old proof passed to the planner as `recoveryBinding`. A context without a
     recovery record is a top-level `invalid`; a resume without the old proof
     is impossible here (recovery without proof belongs to the emergency
     release).
   - Step 1b (transfer only): `loadClaimContext` of `targetContextDirectory`
     through the same `contextIO` seam. A failure keeps its kind (`invalid`,
     `corrupt`, `unavailable`) with a fixed diagnostic of its own; the loader
     validates the whole target file, so a target whose own recovery record
     is damaged refuses the transfer as `corrupt` although only its binding is
     needed; a target whose binding is the own binding is `invalid`. Only the target's
     `binding` is used, as `targetBinding` for the planner; its recovery
     record is never read, and its journal is never opened, read or written.
     The loader's privacy checks and directory syncs are the only effects on
     the target context.
3. Open the context journal; the operation ID must be absent there.
4. Open the explicit store without initialization, then read the ticket once.
   That read is the base of every send.
5. Call the clock once, only after a successful read. The operation ID must not
   already be a receipt in the observed document.
6. Pause: enumerate the journal opened in step 3 and apply
   `evaluateClaimOperationPause` with the captured endpoint, the opened
   descriptor and the read of step 4. `outstanding` or `unknown` returns
   `paused`; an enumeration failure is `paused` with `unknown`, never a
   top-level failure.
7. Plan with `planClaimTransition`, with `targetBinding` for a transfer and
   `recoveryBinding` for a resume. Anything but `planned` returns
   `not-planned` with the unchanged plan and the rights evaluation of the same
   read at the same instant; the rights evaluation never sees the target or the
   old proof.
8. Map the plan to the journal intent (`claimOperationIntentOf`, pure) and
   prepare it. Only `prepared` permits a send.
9. Build the change once from the prepared record: its operation ID, the
   receipt from `createClaimMutationReceipt` and the payload
   `record.intent.resolved.next`.
10. Admission: `journal.admit(prepared.record)`. Only `admitted`
    permits a send. `held` ends `not-sent` with cause `admission-held`;
    `invalid`, `corrupt` and `unavailable` end with `admission-invalid`,
    `admission-corrupt` and `admission-unavailable`. Each of them sends
    nothing and keeps the single clock call.
11. Send the change with `store.write`. After an `unknown` send, or a rejected
    later send, ask `queryClaimMutation`. A repetition sends the admitted
    intent again; it is never admitted a second time.
12. After at least one send, evaluate rights with `queryClaimRight` on a fresh
    read (the second clock call), expecting the successor's claim generation.

Steps 1 to 3 never touch the network, and nothing is enumerated before a
successful read. Failures before the pause are top-level `invalid`, `corrupt`,
`unavailable`, `unknown` or `unsupported` results with fixed diagnostics that
never echo bindings, owners, roots, endpoints, paths, secrets or the operation
ID.

The checks take precedence in this order: options, context, the missing
recovery proof (resume) or the target context and a target equal to the own
binding (transfer), journal open and load, store open, read (`unknown`, no
clock), clock (`invalid`), receipt collision (`invalid`), `paused`,
`not-planned`, `operation`. Inside
`operation`, a `not-sent` from prepare precedes a `not-sent` from admission,
which precedes any send. The IO seam's `readdir` is captured and checked with
its other entries, so a seam without it is an options `invalid`.

## Pause and admission

`paused` has exactly `kind`, `pause` and `rights`. `pause` is
`{ kind: "outstanding", operationIds }` or `{ kind: "unknown", reason }`;
operation IDs appear nowhere else in any result. `rights` is the rights
evaluation of the planning read at the same instant. A paused call writes no
record and no slot, sends nothing and calls the clock once. No action is
exempt: renew, release, reclaim, transfer, resume and change-bounds pause
alike. For a transfer the own journal is the source's; for a resume it is the
replacement context's, which never sees the old context's intents. The rule and
its limits are described in [pause/README.md](../pause/README.md).

A race loser is an `operation` with `storage: { kind: "not-sent", cause:
"admission-held" }`, its own operation ID, `sends: 0` and the rights evaluation
of its planning read. Its record stays published without a slot.

After `rejected {remote}` or a first send that ended `not-sent`, the intent
stays outstanding: later calls of the same context pause at that root until the
root changes or the intent is re-sent. The journal records no
completion. This holds after a transfer too: the source pauses.

The intent carries the caller's operation ID, the captured endpoint byte for
byte, format and epoch of the opened descriptor, the ticket, the plan's
expected root, action and canonical request, and `resolved: { next }`.
`targetBinding` is the binding of an ACTIVE successor, the target's binding of
a PENDING one and `null` for a FREE one (release, reclaim): the
receiver's for a transfer, the fresh one for a resume and the own one for a
bound change. It never decides which operations belong to a context.
Clock, skew, expectations and scope are not persisted.

## Three facts

- `storage` states what journal and store show for this intent: `applied` with
  the root only, `rejected` with exactly `kind` and `cause` (`stale` or
  `remote`), `queried` with the verdict that led to the query (`after`) and the
  unchanged query result, or `not-sent` with its cause.
- `outcome` is the logical D-path result: `applied`, `rejected`, `unknown`,
  `unknown-history` or `not-sent`. After a query, `stored` is `applied`,
  `not-stored` is `rejected`, `conflict` and lost history are
  `unknown-history`, an open intent that is not sent again is `unknown`, and
  every other query result is `unknown`.
- `rights` is a rights evaluation, never derived from the other two. Without a
  send it evaluates the planning read; after a send it comes from a fresh read.

`sends` counts `store.write` calls. A write that reports `invalid` or
`not-sent` on the first call ends as `not-sent`; the intent stays open in the
journal. On a repetition it keeps the preceding open query result.

## Retry rule

A rejection is final only on the first send of the intent prepared in this
call. A later send can meet its own delayed first push, so its rejection is
queried. The same change is sent again on the original base only when the
previous send was `unknown`, the query reports `open` at the expected root and
fewer than `attempts` sends of that intent have happened. Nothing is ever
replanned, retried against a newer root or sent under a new operation ID, and
the clock is not called again before the final evaluation (a T call reads it
once more for its witness, see "Time path").

## Send schedule and planned display

Two options are additive; without them the executor behaves exactly as above,
with the same clock calls, sends and result schema.

- `schedule: { beforeSend(n), commandTimeoutMs() }`. `beforeSend(n)` is asked
  only before a repetition (`n >= 2`) that the retry rule already allows, and
  on a T call before A's first send (`n` counts the call's sends), never before
  the call's first send and never after a query that found the intent stored,
  not stored or contradicted. `"stop"` ends sending and returns the preceding
  queried result; a throwing gate stops too. `commandTimeoutMs()` is
  asked for the store open, for every query and for the final rights read, and
  replaces `storage.timeoutMs` there; the pushes and reads of the opened store
  keep the timeout it was opened with. A value that is not a positive safe
  integer falls back to `storage.timeoutMs`. The schedule's policy (pauses,
  budget) belongs to the surface core; the executor never sleeps by itself.
- `onPlanned(view)` is called once after a `planned` plan and before the intent
  is prepared, with `{ at, claimGeneration, status, timing }` of the successor
  (`at` is the planning instant; for a PENDING successor its target). It never
  carries a binding, an owner or a reason. A throwing or rejecting callback is
  swallowed and changes nothing.

## Re-send (`resendClaimIntent`)

`resendClaimIntent` resends an intent an earlier call prepared, for
`claim retry`. It has no ticket, request, plan or target context of its own;
the record under `operationId` decides everything, and no new operation ID is
ever made. Every action of `CLAIM_TRANSITION_ACTIONS` (transition) is
accepted, so a transfer, resume or change-bounds record is re-sent like the
other four; the target context of a transfer is never read again.

1. Capture the options as above. Load the explicit context and the record of
   `operationId` from its journal; `absent` is `invalid`, other failures keep
   their kind. A record whose endpoint or format differs from
   `storage.remote`/`storage.format` is `invalid` before any network.
2. Open the store (scheduled timeout). A record of another epoch than the
   opened descriptor ends here, before the read:
   `storage: { kind: "queried", after: "earlier-process", query: { kind:
   "unknown-history" } }`, outcome `unknown-history`, `sends: 0` and no rights
   (`unknown`), since its history ended with the new epoch and it is never sent
   into another one. Otherwise read the record's ticket once. That fresh read
   is the base of every send.
3. `resolveClaimMutation` on that read. Anything but `open` at the record's
   expected root ends here with `storage: { kind: "queried", after:
   "earlier-process", query: { kind: "resolved", resolution } }`, `sends: 0`
   and the outcome of the resolution (`stored` applied, `not-stored` rejected,
   `conflict` and lost history unknown-history, anything else unknown).
4. `onPlanned` with `at: null` and the record's successor.
5. The change is the record's: the receipt from `createClaimMutationReceipt`
   and the payload `intent.resolved.next`.
6. Admission: `journal.admit(record)`. The slot is idempotent for the same
   record, so a re-send of an admitted intent, and two parallel re-sends of
   one ID, are admitted and send identical bytes. `held`,
   `invalid`, `corrupt` and `unavailable` end `not-sent` with the
   `admission-*` cause and send nothing.
7. Send as above, with one difference: no rejection of a re-send is
   final. The earlier process's send may still land, so every rejection is
   queried, and a query that finds the change stored ends `applied`.

Rights come from the fresh read while nothing was sent and from another fresh
read after a send; each takes one clock call. The clock is never used for
planning.

## Excluded guarantees

- **No execution admission.** `outcome: applied` and `rights` with
  `workRight: live` do not permit an external effect. `rights` remains a
  projection with `scope: "observed-state-only"`. The DD1 recipe is not
  fencing.
- **Pause and admission reach one context only.** They hold among cooperating
  processes of the same UID on a local filesystem, qualified for Linux only.
  A call that is not paused has no work right. Other contexts, the recovery
  source context, copied contexts, other endpoint spellings and other tickets
  are not seen; there is no liveness (no timeout, no giving up), no cleanup of
  records or slots and no protection against non-cooperating writers. The full
  list of what the pause proves and does not prove is in
  [pause/README.md](../pause/README.md).
- **`applied` or `stored` is neither current ownership nor the logical result
  of composed operations.** The logical outcome of a T call is its own
  (below).
- **No clock qualification, no endpoint authentication, no fencing.**
- **No retry budget of its own.** Pauses, jitter and the operation budget come
  only from a caller's `schedule` (the surface core); without one,
  `timeoutMs` applies per Git command and repetitions follow immediately. The
  store opened before the deadline keeps its timeout, so its pushes and reads
  can overrun a deadline by at most one per-command timeout.
- **A re-send is not a resume.** `resendClaimIntent` resends the identical
  change of the same context. `resume` always means the binding takeover
  (action, journal `action`, later `claim resume`); re-sending an earlier
  process's intent is `retry` or `resendClaimIntent` (a re-send).
- **No retention or cleanup rule for journal records.** The API never deletes.

## Excluded guarantees of transfer, resume and bound changes

- **No execution admission and no fencing.** `outcome: applied` and `rights`
  stay the three separate facts above. After a transfer, `rights` is the
  source's view (foreign, the successor's generation expected); the
  receiver's right is not checked and is queried by the receiver with
  `queryClaimRight`.
- **No cross-host transfer.** The target must be a context the source process
  can load, with the same UID. A wrong but valid target context receives the
  claim; only a transfer by the receiver, a release, a reclaim or the
  emergency release moves it on.
- **No acknowledgement, notice or ticket change.** A transfer needs no ACK,
  sends no notification, changes no assignee, ticket status or ticket file,
  and has no dependency check.
- **Resume imports no old journal.** Old intents are invisible in the new
  context; they can no longer land, and their history may stay open. Resume
  renews no lease window, moves no hard deadline and revives no work right
  after it. Clones of the old context are not detected, only resolved by the
  conditional write: exactly one resume wins, the loser's first send is
  rejected and every later plan of it is `not-holder`.
- **No liveness.** A loser is not retried, and no binding is ever taken over
  automatically.
- **Bound changes extend only over the time path** (below): no foreign change,
  no mode change, no removed hard deadline and no later reclaim boundary under
  an unchanged one. A no-op is a write.
- **No restart without a new hard end and no policy resolution.** A restart
  without `hardEnd` is `requires-time-path` wherever it would restart a box;
  the planner reads no configuration, so the caller resolves a policy source.
- **Otherwise as above:** no clock or endpoint qualification, no retry budget
  of its own and no retention rule.

## Time path

With `timePath: true` the planner may plan a PENDING successor (a later hard
deadline by `change-bounds`, a transfer restart with a later `hardEnd`). The
call then runs two ordinary journal intents on the path above, P and A, with no
new record form:

- T0 to T2: P is the planned intent (expected root q, `targetBinding` the
  target's binding, `resolved.next` the PENDING state), prepared, admitted
  (slot key q) and sent like any intent.
- T3: after `applied` p is the written snapshot; after a query that finds P
  `stored`, a fresh read whose payload is canonically the planned PENDING.
  Anything else ends with phase `pending`.
- T4: exactly one clock reading C_o after p; a witness only while
  `C_o + eps < H_s` (H_s is the source's hard deadline, `observeBefore`).
- T5: the witness is the A intent under `claimConfirmationId(P-ID)` ("c-" and
  40 hex of SHA-256 over a domain string and the P ID), with P's action,
  expected root p, the target's binding, `resolved.next` the target and the
  parameters `{stage: "confirm", transition, transitionDigest, observedAt,
  clockSkewMs, observeBefore}`. A journal `conflict` reuses an existing A
  record only when it confirms this P.
- T6: A is admitted (slot key p, never P's q, so it never pauses itself) and
  sent while it is open at p, always as a re-send (below). One budget covers
  P and A: A's first send passes
  the schedule's gate like any later send of the call; `attempts` holds per
  intent and `sends` counts both.
- T7: the final rights come from a fresh `queryClaimRight` with the successor's
  generation, the caller's own view (after a transfer the source's, foreign).

A T call reads the clock three times (plan, C_o, final rights); a D call keeps
its two. The result adds `transition: {phase, confirmOperationId,
observeBefore, reclaimBoundary, confirmation}`; `operationId` and `storage` are
P's, `confirmation` is A's storage fact or `null` while A is unsent, and
`outcome` is the logical one: `confirmed` (A applied or stored) is `applied`;
`witnessed` is `unknown` while the query shows A open at p or cannot tell
(open, unknown, not sent, stopped by the budget or by `attempts`) and the
historical `applied` once the query shows A not stored (the root moved past
p) or lost history; `pending` is `unknown`, or `unknown-history` when the read
shows that p is no longer current; `none` keeps P's outcome.
A is always sent as a re-send, so no rejection of A is final by itself: a
rejection alone cannot tell a root that moved past p from a remote that
refuses the write, only the query can. After a lost reply A is re-sent while
the query shows it open at p, up to the call's `attempts`; a rejected A that
the query still shows open at p ends `unknown`, and `retry <A-ID>` sends it
again.

`resendClaimIntent` takes no `timePath`: a P record whose successor is PENDING
switches the continuation on. An unsent P is sent first. A stored P continues
with T3 to T7 from the resend's own fresh read; an existing A record of this P
is sent as it is, without a new observation, and without one p is observed
anew only while `C + eps < H_s`. A re-send of an A record is the ordinary
identical re-send: no plan, no binding check, no work right, valid after H_s,
one clock reading for its rights.

Excluded guarantees of the time path:

- **No work right from PENDING**, for the source, the target or a third party,
  and none from publishing a witness: the publisher's `rights` are its own
  fresh rights view.
- **No server time authority**: the witness holds only under the assumed
  `eps`; a clock that lags by more than `eps` can produce a false witness.
- **The source stops work before sending**, a workflow duty; the
  journal pause holds only calls of the same context.
- **No rescue of a lost witness**: no export or import, no observation by
  another context (a replacement context sees neither record), no
  re-observation after H_s. PENDING then blocks until the hull, and the history
  may stay UNKNOWN_HISTORY.
- **No liveness**: nobody publishes A automatically; the source's context
  pauses at p until someone re-sends it.
- **Not in V1**: removing a hard deadline, raising the reclaim boundary under
  an unchanged one, a restart without a new hard end, a second unresolved
  transition per ticket.
- **APPLIED says nothing about current ownership**, and A is no acknowledgement
  by the receiver.
