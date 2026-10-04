# Internal claim transition planning

This module is an internal building block, not a public library or a claim
command. `planClaimTransition` turns one explicitly scoped observation, the
caller's current context binding, an explicit clock reading with its assumed
error and an exact request into a **state plan**: the expected Git root the
mutation must be conditioned on and the complete next claim state. Every
planned result carries `scope: "state-plan-only"`.

A plan is not a journal intent, not a mutation, not execution admission and
no proof that no own operation is outstanding. It contains no operation ID,
endpoint or parameter envelope, and its request never carries a binding; a
binding appears only in the successor state. Mapping a plan to a
`ClaimOperationIntent`, including what the journal's target binding means for
a free successor state, belongs to the executor integration.

## Actions

- `acquire` plans from an absent ticket (expected root `null`) or a free
  tombstone (its root), with generation tombstone plus one or `1`, binding
  generation `1`, the caller binding and the requested owner name. An active
  claim is `held` for the same binding and `not-free` for another one, even
  when it is already reclaimable; reclaim is its own operation.
- `renew` plans only for the current binding holder of a lease. The new lease
  end is the clock reading plus the requested TTL, capped at a stored hard
  deadline for a default TTL and rejected as `overlong` for an explicit one.
  A pure lease stays renewable after its lease end and after becoming
  reclaimable, until an atomic reclaim actually wins.
- `release` plans a free tombstone for the current binding holder in every
  mode and at any time, also after the hard deadline; a superseded holder
  cannot release.
- `reclaim` plans a free tombstone for any caller once the clock reading minus
  its error reaches the stored boundary: lease end plus grace, or hard
  deadline plus grace. The no-expiry mode never becomes reclaimable.
- `transfer` plans for the current binding holder, in one step from
  ACTIVE to ACTIVE: the successor has claim generation plus one, binding
  generation `1`, the requested owner name and the binding passed as
  `targetBinding`. The request is `{ action, owner, timeBox, lease }`;
  `timeBox` is `null` or `{ action: "preserve" | "restart", source:
  "explicit" | "policy" }`, a restart optionally with an absolute `hardEnd`
  (`null` or any other value is `invalid`), and `lease` is `null`
  or `{ ttlMs, ttlSource }`. Under a stored hard deadline (hard mode, or a
  lease with `hardEnd`) a missing time box is `time-box-required` and a
  restart without `hardEnd` of any source is `requires-time-path`; `preserve`
  keeps the deadline. Without one, an explicit restart without `hardEnd` is
  `requires-time-path` and a policy restart has nothing to restart. A restart
  with `hardEnd` restarts the time box under that end: see "Time path". A lease needs `lease` (`lease-required`) and gets a fresh window
  from the clock reading like renew, also after its lease end and after
  becoming reclaimable: capped at a stored hard deadline for a default TTL,
  `overlong` for an explicit one, `hard-expired` once `C + eps >= H`. Hard and
  timeless claims keep their timing, also after the deadline; a default lease
  is ignored there and an explicit one is `not-renewable`.
- `resume` plans for a replacement context: `binding` is its fresh
  binding and `recoveryBinding` the old proof from its recovery record. It
  plans in every mode and at any time when the stored binding equals the old
  proof; the fresh binding already holding is `held`, any other holder
  `not-holder`. The successor keeps claim generation, owner and timing and
  carries the fresh binding with binding generation plus one.
- `change-bounds` plans an absolute target timing in the state form of
  the rights module for the current binding holder, without a clock verdict,
  so also after the lease end, the reclaim boundary and the hard deadline. A
  different mode is `mode-change`. With W the work-right end (the hard
  deadline; unbounded without one) and R the reclaim boundary (lease end or
  hard deadline plus grace; unbounded for the timeless mode), a change extends
  the claim when W grows, or when W is finite and R grows; that is
  `requires-time-path`, except a finite later hard deadline with `timePath`
  (see "Time path"). Without a hard deadline every same-mode change plans,
  including a first hard deadline. An unchanged timing is a planned write.
- `emergency-release` (the eighth action) plans for any caller. The
  request is exactly `{ action, expectedRoot }` with a 40- or 64-digit
  lowercase hex root. The observed root must equal `expectedRoot` before any
  state rule (`stale-root`); an absent ticket has no root and always ends
  there. A free tombstone is then `free`, and an ACTIVE or a PENDING state
  plans the free tombstone with the stored generation, for PENDING the
  target's, like reclaim. There is no binding, generation, time or mode check,
  and the generation grows only at the next acquire. Who may send it is the
  surface's check (`claims.recovery_authorities`), not the planner's.

The role options are bound to their action: `targetBinding` is mandatory for
`transfer` and allowed nowhere else, `recoveryBinding` is mandatory for
`resume` and allowed nowhere else. Both use the binding format of the rights
module and must differ from `binding`; anything else is `invalid` before the
observation is looked at. The target goes only into the successor's binding,
the old proof is only compared with the stored binding.

Rejections are reported in a fixed order: input, request and role validity
(`timePath` must be a boolean when given), the observation itself (as
classified by the rights module), scope, then state and ownership, generation
continuity, mode, time and finally numeric range. An emergency release reports
`stale-root` right after the observation, before the state slot. A PENDING
state takes the state slot: every action but reclaim and the emergency release
is `pending-transition` there, before the generation check; both keep their
own order.
Within the mode slot a transfer reports `requires-time-path`,
`time-box-required`, `lease-required`, then `not-renewable`; a bound change
reports `mode-change` before `requires-time-path`. A resume reports `held`
before `not-holder`, both before the generation. `boundary` accompanies
exactly `hard-expired`, `overlong`, `not-yet` and `pending-transition` (the
hull); the causes `time-box-required`, `requires-time-path`, `lease-required`
and `mode-change` carry none.

## Time

With `C` the clock reading, `eps` its assumed error and `H` a hard deadline,
a new lease acquire or renew requires `C + eps < H`; after that there is no
positive remaining time, and capping alone would move the reclaim boundary.
The planner reads no clock and no configuration: TTL, grace and hard deadline
are mandatory inputs, and the caller reports a capped default itself.

The planner is deterministic. A plan is computed once per new operation; an
identical retry replays the frozen plan and never asks the planner again. A
previously valid plan that lands after the hard deadline is not re-planned and
grants no work right; a new request after the deadline is rejected. The target
binding, the fresh window, the time-box source and the target timing are
frozen in the plan's request and successor, so a replay keeps them.

## Time path

With `timePath: true` two changes plan a PENDING successor instead of an
ACTIVE one: a `change-bounds` to a finite later hard deadline of the same mode
(the target is the stored state with the new timing), and a transfer restart
whose `hardEnd` is later than the stored hard deadline (the target is the
transfer successor with that end). A restarted time box keeps the stored
grace: hard stays `{hard, hardEnd}`, a lease gets `leaseEnd(C, lease,
hardEnd)`, capped at the new end for a default TTL and `overlong` with
`boundary` at the new end for an explicit one. The new end is absolute and
frozen in the request, so a replay never restarts the box again. Every T plan
needs `C + eps < H_s` (`hard-expired` with `boundary` H_s otherwise).

Without `timePath` (the default) every extension stays `requires-time-path`,
exactly as before the time path. A restart with `hardEnd` at or before the
stored hard deadline, or on a lease without one, is planned directly, in the
latter case with the first hard end; on the timeless mode it is `mode-change`.
`requires-time-path` therefore means exactly: a restart without `hardEnd`, a
removed hard deadline, a later reclaim boundary under an unchanged one, or any
extension with the time path off.

On a PENDING state every action but reclaim and the emergency release is
`pending-transition` with the hull as `boundary`, for every binding; reclaim is
`not-yet` before the hull and then plans a FREE tombstone with the PENDING
state's generation, and the emergency release plans that tombstone at once
when its root matches.

The witness, its clock assumption and the logical outcome belong to the
executor and the resolution module; the planner reads no clock. Excluded
guarantees of the time path:

- **No work right from PENDING**, for the source, the target or a third party,
  and none from publishing a witness.
- **No server time authority**: a clock that lags by more than `eps` can
  produce a false witness.
- **The source stops work before sending**, as a workflow duty.
- **No rescue of a lost witness** (no export or import, no observation by
  another context, no re-observation after H_s): PENDING blocks every action
  but reclaim until the hull, and the history may stay UNKNOWN_HISTORY.
- **No liveness**: nobody publishes a confirmation automatically.
- **Not in V1**: removing a hard deadline, raising the reclaim boundary under an
  unchanged one, a restart without a new hard end, a second unresolved
  transition per ticket.
- **APPLIED says nothing about current ownership**; the confirmation is no
  acknowledgement by the receiver.

## Limits

The observation may be superseded immediately; the expected root only makes a
later conditional mutation safe, and `expectedClaimGeneration` is a continuity
check, not a lock. The emergency release's authorisation, dependency policy,
own-operation pause and public CLI/MCP are separate work. Diagnostics never echo bindings
(including the target and the old proof), owner names, roots or request
contents.

## Excluded guarantees of transfer, resume and bound changes

- **No execution admission and no fencing.** A planned or applied transfer,
  resume or bound change grants no permission for an external effect. After a
  transfer, the executor's `rights` show the source's foreign view; the
  receiver's right is not checked here and is queried by the receiver itself.
- **No cross-host transfer.** The target binding comes from a context the
  source process can load (same UID). A wrong but valid target receives the
  claim; only a transfer by the receiver, a release, a reclaim or the
  emergency release moves it on.
- **No acknowledgement, notice or ticket change.** A transfer needs no ACK,
  sends no notification and changes no assignee, ticket status or ticket
  file; it has no dependency check.
- **Resume imports no journal.** Intents of the old context stay invisible in
  the new one; they can no longer land, their history may stay open. Resume
  renews no lease window, moves no hard deadline and revives no work right
  after it. Clones of the old context are not detected, only resolved by the
  conditional write.
- **No liveness.** A loser is not retried, and no binding is ever taken over
  automatically.
- **Bound changes extend only over the time path.** No foreign change (no
  permission model for it), no mode change, no removed hard deadline and no
  later reclaim boundary under an unchanged one; a later hard deadline only as
  a PENDING plan with `timePath`. A no-op is a write.
- **No restart without a new hard end and no policy resolution.** A restart
  without `hardEnd` is `requires-time-path` wherever it would restart a box;
  the planner reads no configuration, so the caller resolves a policy
  source.

Glossary: `resume` always means the binding takeover (action, journal
`action`, later `claim resume`). Re-sending an earlier process's intent is
`retry` or `resendClaimIntent` (a re-send), never "resume". `transfer` hands a
claim to another context; `change-bounds` changes its lifetime bounds.
