# Single claim mutation resolution

This module defines internal evidence handling for exactly one conditional Git
storage mutation (one CAS / stage intent). Receipt creation validates the
original journal record; resolution compares its receipt against an observed
storage document. The behavior below is the internal contract, not a public
claim lifecycle API.

These pure helpers perform no I/O, dispatch, retries, context lookup, time
decisions, cleanup, or implicit fallback. They introduce no public library API,
CLI, or settings. The logical outcome of a time-path call's two records is
`resolveClaimTransition` (below). A single stage receipt cannot establish
logical `APPLIED`, confirmed transfer, current ownership, or a work right.

## Original record and receipt

`createClaimMutationReceipt(record)` returns exactly `{ kind: "receipt",
receipt }` for a valid original journal record, or `{ kind: "invalid", reason }`.
The deterministic receipt contains exactly:

```ts
{ schema: 1, intentDigest: record.digest, parameterDigest: record.parameterDigest }
```

Both helpers must capture the record once as a validated JSON snapshot, using
the journal's existing predicates and digest rules, and use only that snapshot
afterwards. Validation covers exact record fields/schema and both digests:
changing intent fields, target binding, resolved times, or parameters while
retaining old digests is invalid. Accessors must not change the operation ID or
binding between validation and lookup; non-JSON values must not be normalized
into accepted input. Journal byte-level decoding checks remain separate.

An own receipt is looked up by the original operation ID and must match the
exact receipt fields and values. Operation-ID equality, matching payload,
revision, or a later renewal alone does not prove the earlier mutation. The
receipt contains no secret, raw intent, owner, deadline, or logical outcome.

## Source and observation assumptions

`resolveClaimMutation({ record, source, observed })` relies on a native caller
that loads the persisted original intent, opens its intended explicit endpoint
and descriptor, and obtains a fresh read for the same ticket after intent
preparation. A non-null expected root must have been authoritatively observed;
it cannot be guessed from a future computed write. The caller must not replace
the original intent with a newly constructed retry.

Source remote equality and matching descriptor schema (`1`), format, and epoch
bind the input scope. They do not cryptographically authenticate an endpoint;
URL equality does not prove physical server identity. Arbitrary in-memory
objects do not establish Git evidence, and this is not a generic history parser.

Historical inference assumes a stable epoch, cooperative native writers,
never-repeated roots, and complete in-epoch receipt retention. Destructive
maintenance needs a separate contract. Receipt count equal to revision is only
a consistency check under these assumptions, never independent proof that the
history is complete.

## Resolution order and results

Apply these rules in order; a later rule cannot override an earlier failure:

1. An invalid or mutated original record, or a mismatched source remote or
   descriptor, yields `invalid` without a historical verdict.
2. A native `unreachable`, `corrupt`, or `invalid` read yields `unknown`.
3. A structurally malformed observation yields `unknown`. A present observation
   requires a 40- or 64-character lowercase hexadecimal root and the current
   storage document shape: schema `1`, positive safe-integer revision, JSON
   object payload, and an object of JSON object receipts. For a well-formed
   successful observation, the ticket (including the document ticket) must
   match the intent; document format and epoch must match the source (equal to
   the intent after rule 1). Scope
   mismatches yield `invalid`. Storage decoding remains authoritative.
4. An absent observation with a null expected root yields `open` with
   `observedRoot: null`; with a non-null expected root it yields
   `unknown-history`, never `not-stored`.
5. A present observation containing an own operation-ID receipt yields
   `conflict` if the receipt differs or is already at the expected root.
   Otherwise an exact receipt yields `stored`, even if unrelated receipts are
   incomplete or later mutations have advanced the root.
6. A present observation without an own receipt at the unchanged expected root
   yields `open`: a delayed push may still become effective.
7. A present observation without an own receipt at a changed root yields
   `not-stored` only when receipt count equals revision under the assumptions
   above; otherwise it yields `unknown-history`.

`stored` and `not-stored` return exactly `{ kind, observedRoot }` with a string
root; `open` has the same fields with a string or null root. `observedRoot` is
the current observed root, which need not be the root originally created by
the historical mutation. `conflict`, `unknown`, `unknown-history`, and `invalid`
return exactly `{ kind, reason }`. Reasons are fixed safe diagnostics without
raw endpoints, private intent values, or source errors.

`stored` establishes receipt evidence for this single storage mutation only.
`not-stored` is the scoped negative conclusion supported by a changed root and
the retained history assumptions. `open` leaves the mutation unresolved;
`conflict` identifies contradictory own-receipt evidence. `unknown` supplies
no usable observation verdict, while `unknown-history` means history cannot
support the negative conclusion. None of these results authorizes a retry,
a new operation, or work under current claim rights.

## Time-path transitions

A T call leaves two ordinary records in the source's journal: P, whose
`resolved.next` is a PENDING state (`claimTransitionOf(record)` returns it,
`undefined` for every other record), and, once the witness was taken, A under
`claimConfirmationId(P-ID)`: "c-" and 40 hex of SHA-256 over the fixed domain
string `backlog.md/claim-confirm/v1\0` and the P ID, derived from the P ID
alone. `isClaimConfirmation(P, A)` holds when A carries that ID, P's action,
scope and ticket, the target's binding, `next` = P's target and exactly the
parameters `{stage: "confirm", transition: P-ID, transitionDigest: P's digest,
observedAt, clockSkewMs, observeBefore: H_s}` with
`observedAt + clockSkewMs < observeBefore`.

`resolveClaimTransition({ record, confirmation, source, observed })` is pure
and reads no clock. It resolves P and A (when given) with
`resolveClaimMutation` on the same observation and answers
`{ kind, phase, transition, confirmation }` (the logical kind, the phase and the
single kinds of P and A) or `{ kind: "invalid", reason }`:

| P | A record | A / state | logical | phase |
| --- | --- | --- | --- | --- |
| invalid, or not a T record | - | - | invalid | - |
| open, unknown | - | - | unknown | none |
| not-stored | - | - | rejected | none |
| unknown-history, conflict | - | - | unknown-history | none |
| stored | no | p current | unknown | pending |
| stored | no | p no longer current | unknown-history | pending |
| stored | yes | stored | applied | confirmed |
| stored | yes | open, unknown | unknown | witnessed |
| stored | yes | not-stored, unknown-history, conflict | applied (historical) | witnessed |

"p current" means the observed payload is canonically P's PENDING. An A record
that is invalid, belongs to another P or took its witness at or after
`observeBefore` makes the whole answer `invalid`. APPLIED rests only on the
exact P and A receipts: a later own renew or an ACTIVE target payload without
A's receipt proves nothing. The single resolution above is unchanged; `stored`
is still never APPLIED there.

Excluded guarantees of the time path:

- **No work right from PENDING**, for anybody, and none from publishing a
  witness; no result here grants one.
- **No server time authority**: a witness proves timeliness only under the
  recorded skew; a clock that lagged by more than that can have recorded a
  false one, which this resolver cannot detect.
- **The source stops work before sending**, a workflow duty.
- **No rescue of a lost witness**: without an A record the answer can stay
  UNKNOWN or become UNKNOWN_HISTORY for good; no export, import or observation
  by another context adds one.
- **No liveness**: an open A stays UNKNOWN until someone re-sends it.
- **Not in V1**: removing a hard deadline, raising the reclaim boundary under
  an unchanged one, a restart without a new hard end, a second unresolved
  transition per ticket.
- **APPLIED says nothing about current ownership**, and A is no acknowledgement
  by the receiver.
