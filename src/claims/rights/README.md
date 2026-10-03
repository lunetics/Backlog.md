# Internal observed-state rights

This module is an internal building block, not a public library or a complete
claim feature. No CLI or MCP commands are connected to it. In particular,
`workRight.kind === "live"` is **not standalone execution authorization**.
Every evaluated result carries `scope: "observed-state-only"`.

## Separate facts

- `ownership` compares the supplied execution binding with the observed state.
  Owner names are display data, not credentials. A different binding cannot
  inherit rights merely by using the same name.
- `workRight` projects that state's lifetime rules and optional expected claim
  generation. It does not inspect outstanding local source operations.
- `reclaim` indicates time eligibility for a hypothetical conditional reclaim,
  not a completed reclaim, lock, or grant to a challenger.

A pure renewable lease remains live for its observed holder after its renewal
deadline and after becoming reclaimable. Actual atomic loss of ownership ends
that right. An additional hard deadline independently ends work rights; grace
does not extend it. A current holder may therefore have no work rights while
still holding the binding needed for non-extending administration elsewhere.

The parser accepts versioned, exact JSON state payloads. It rejects malformed
data rather than repairing deadlines, reports invalid schema-1 data as corrupt
and unknown versions or statuses as unsupported. Arbitrary payloads used in
storage-only tests do not acquire rights semantics. Free states are tombstones;
read failure is never treated as a free ticket. Receipts never confer rights.

## Pending transitions

A PENDING state is exactly `{claimState: 1, status: "pending",
claimGeneration, source, target}`: two complete ACTIVE states of the same mode,
both with a finite hard end, the target's later than the source's, and the
target's claim generation. The transfer form has the target at generation plus
one, binding generation 1 and another binding; the bound form differs from the
source only in its timing. Every other shape with status `pending`, an extra
field included, is corrupt. The payload is the same document field in every
storage format.

`evaluateClaimRight` gives every binding (source, target, third party) the
ownership `pending` and `workRight: {kind: "none", cause: "pending"}`, also
with any expected generation. The reclaim verdict uses the hull
`max(R(source), R(target))` with the same `C - eps >= boundary` comparison, so
it is always finite. `claimReclaimBoundary(state)` is the one rule for R and
the hull, shared by this module, the planner and the batch reclaim preview; it
answers `null` for the timeless mode and a FREE tombstone.

What this projection never grants on PENDING:

- **No work right from PENDING**, for the source, the target or a third party,
  and none from publishing a witness; the target works only after its own fresh
  query shows an ACTIVE claim, and even that is no fencing.
- **No server time authority.** A witness proves timeliness only under the
  assumed `eps`; a clock that lags by more than `eps` can produce a false one.
- **The source stops work before sending**; that is a workflow duty, not a
  native lock.
- **No rescue of a lost witness**: no export or import, no observation by
  another context and no re-observation after the source's hard end. PENDING
  then blocks until the hull; the history may stay UNKNOWN_HISTORY.
- **No liveness**: nobody publishes a confirmation automatically.
- **Not in V1**: removing a hard end, raising the reclaim boundary under an
  unchanged hard end, a restart without a new hard end, a second unresolved
  transition per ticket.
- **APPLIED says nothing about current ownership**, and the confirmation is no
  acknowledgement by the receiver.

## Inputs and time

`isClaimBinding` and `isClaimTiming` export the parser's own binding and state
timing rules unchanged, so the transition planner checks role bindings and
bound changes without a second parser.

`evaluateClaimRight` is pure: its caller must establish observation provenance,
the current private context binding, and explicit time assumptions. It performs
no IO and reads no clock. Plain data is copied without invoking accessors;
cycles, accessors, symbols, non-enumerable object properties and non-JSON data
are not accepted. This is not a sandbox against malicious JavaScript Proxies.

`queryClaimRight` captures options before its first await, loads the explicitly
selected private context, opens the explicit native store without initialization,
and reads the ticket afresh. It uses the context's current binding, never its
recovery binding or an arbitrary public binding supplied by the caller. Context
failure precedes network access. After a successful present/absent read, the
captured clock is called once. There are no writes, retries, fallback stores or
context creation. Existing local Git fetch effects still apply.

Times use nonnegative safe-integer epoch milliseconds. Clock uncertainty is
explicit and assumed, not measured or qualified by this module. With `C` the
clock reading, `eps` its assumed maximum error, `L` the lease end, `H` the hard
end, and `g` grace:

- Hard work rights require `C + eps < H`.
- Lease `renewalDue` is `C + eps >= L`.
- Reclaim eligibility requires `C - eps >= L + g` or `H + g` for hard-only mode.
- The no-expiry mode never becomes time-reclaimable.

Stored timing values are used as-is; later configuration cannot silently change
an existing claim. `reclaim: not-yet` is not a holder safety signal. For a
conservative workflow, renew after a missed renewal before starting new
unprotected irreversible external effects; isolated preparation may be treated
differently. This is an example policy, not native scheduling or a pause rule.

## Limits and remaining integration

A read can be superseded immediately by another writer. Even a successful
renewal cannot fence an external effect that happens after ownership changes.
Mutation admission must still use the exact expected root and current proofs.
The private context assumes trusted stable ancestors and cooperative processes;
full copies of a running context and its secrets remain indistinguishable.

A future execution-admission layer must also establish that no own unresolved
operation requires the source to pause. The journal's read-only enumeration and
the pure pause rule (`src/claims/pause`) report own outstanding intents against
the observed root for one context; this projection does not consult them, and
the pause is still no work right. Logical operation outcomes, time witnesses,
mutations, clock qualification and hosting qualification are separate work
(the time path adds the first two elsewhere; the clock qualification is measured
in src/claims/QUALIFICATION.md: U = 2000 ms, see its clock section). This scoped
projection must not be presented as those guarantees or as an offline right to
work.
