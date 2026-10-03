# Internal own-operation pause

This module is an internal building block, not a public library or a complete
claim feature. The CLI and MCP reach it only through the executor and the
surface core. A call that is not paused has **no execution admission** and no
work right: `rights` stays a projection with `scope: "observed-state-only"`.

## Rule

`evaluateClaimOperationPause({ journal, observation })` is pure. It performs no
IO and reads no clock. `journal` is the result of `enumerate()` on the journal
of the loaded context (`context.journalDirectory`). `observation` is the
captured endpoint, the descriptor of the opened store and the successful
planning read of the ticket.

A record is *own* because it lies in that journal, never because of its
`targetBinding`, `action`, `parameters` or `resolved` values. The journal of a
recovery source context is never read. A record is *outstanding* when its
ticket, endpoint (byte for byte, without alias normalization), format, epoch
and `expectedRoot` equal the observation. The observed root is `present.root`,
and `null` for an absent ticket. No action is exempt: renew, release and
reclaim pause exactly like acquire. No query is needed, because the resolver
reports exactly these records as `open` on the same read.

The results, checked in this order:

1. `invalid`: the observation is not a present or absent read of a canonical
   ticket, the present root is not 40 or 64 lowercase hex digits, the
   descriptor is not schema 1 with a known format and a positive safe-integer
   epoch, or the endpoint is not a nonempty string. The journal is not looked
   at.
2. `unknown`: the enumeration is not `enumerated`, it counts a corrupt entry,
   or it lists a record that fails the journal's record validation. `unknown`
   beats `outstanding`: beside an unreadable entry a list could be read as
   complete.
3. `outstanding { operationIds }`: every matching operation ID once, sorted by
   code units.
4. `clear`: no matching record.

Diagnostics are fixed texts that echo no endpoint, root, binding, ticket or
operation ID. Operation IDs appear only in `operationIds`; they are data, not
evidence of an outcome.

## Cross-ticket acquisition stop

`evaluateClaimAcquireStop({ journal, remote, descriptor, roots })` applies the
same `outstanding` predicate to every own record at once instead of to one
planning read. `roots` maps each ticket to the root one listing of
`refs/claims/*` returned (`listClaimRefs` in `../storage`); a ticket without an
entry has no ref, so its observed root is `null`. A record is open when its
endpoint (byte for byte), format and epoch match the observation and its
`expectedRoot` equals the listed root of its ticket.

The results, checked in this order:

1. `invalid`: the endpoint, the descriptor or a listed root (40 or 64
   lowercase hex digits) is malformed. The journal is not looked at.
2. `unknown`: the same incomplete journal views as for the pause.
3. `outstanding { operationIds }`: every open `acquire` record, once, sorted
   by code units.
4. `clear { maintenanceOperationIds }`: no open acquire; the open records of
   other actions are returned, sorted, so `claim next` can tell a pause caused
   only by its own operations other than acquire from one caused by an acquire.

`claim next` runs it after its preflight and before any attempt: an open own
acquire on any ticket stops the call before it reserves another one. It
inherits every limit of the pause below: it sees only this context's journal,
cannot tell a lost or finally rejected intent from one in flight, and has no
liveness. The ticket's root moving on or `claim retry` ends it.

## Enumeration and admission

`enumerate()` lists the journal read-only: final `<operationId>.json` records
are validated like `load` without its synchronization, publication
temporaries and admission slots are ignored, and every other entry counts as
corrupt. See [journal/README.md](../journal/README.md).

A scan is only a snapshot, so two calls of one context can both see `clear`.
After `prepared`, the executor therefore asks `admit(record)`: the journal
publishes the record's exact bytes under an admission slot named by a
SHA-256 over a domain string and the canonical key (ticket, endpoint, format,
epoch, expected root), through the same no-replace hard-link publication as
the record. Only the call whose record fills the slot (`admitted`) sends. A
second intent of the same key gets `held` and sends nothing. Nobody waits:
there is no lock file, no `flock`, and no PID, boot-ID or time-based stale
rule. A slot is never replaced, deleted or renamed.

After a SIGKILL before the record link, at most an ignored temporary remains.
After the record link, the record is reported as outstanding and stays
admissible exactly once. After the slot link, admission is idempotent for that
record. No state needs time, a PID or a cleanup rule to make progress.

## What the pause proves

Among cooperating processes of the same UID on a local filesystem, qualified
for Linux only:

1. **No matching record at the scan.** When the journal of the loaded context
   was enumerated, it held no valid record with the same ticket, byte-identical
   endpoint, format, epoch and an `expectedRoot` equal to the observed root,
   and no unreadable or unknown entry.
2. **At most one send per source.** For each combination of ticket, endpoint,
   format, epoch and root, a context sends at most one intent. Concurrent calls
   of the same context, in one or in several processes, never both pass the
   admission.
3. **Crash tolerance.** After a process is killed, the pause reports every
   published intent against this root. No admission expires through time, a
   PID or a restart.

## What the pause does not prove

- **No execution admission and no work right.** `rights` stays
  `observed-state-only`. A call that is not paused does not permit external
  effects.
- **Nothing outside the context.** Other instances and contexts, the recovery
  source context, copied contexts on other hosts, other spellings of the same
  endpoint and other tickets are not seen. Only `claim next` looks across
  tickets, through the acquisition stop above; a direct acquire does not.
- **Nothing about own intents against other roots.** They cannot land on the
  observed root, but they are not settled; `unknown-history` stays possible.
- **Not that a reported intent was sent or is still in flight.** Never sent,
  lost and finally rejected intents look the same. After `rejected {remote}`
  or a first send that ended `not-sent`, the intent stays outstanding, so the
  context pauses at that root until the root changes or the intent is resumed.
  This costs availability, not safety. The journal records no outcome.
- **No liveness.** There is no timeout, no giving up and no cancellation. A
  pause ends only when the root changes or the intent is resolved by resuming
  it.
- **No protection against non-cooperating writers.** Whoever deletes or
  changes records or slots is not covered.
- **No qualification** for NFS, CIFS, FUSE, macOS or Windows. On Windows the
  journal already fails at `process.getuid`.
- **No retention or cleanup rule.** Slots grow with the journal.
- **No fencing**, no clock qualification and no endpoint authentication.
- **No performance promise.** Every executor call enumerates the whole
  journal, with O(n) effort.

## Remaining integration

The base claim commands resume an intent from an earlier process as load, query
(open at the same root), `admit`, identical send; `held` never sends, never
bypassing the slot, also after a restart. There `paused` becomes its own JSON
kind and exit code, and read-only commands never pause. Transfer, resume,
change-bounds and the time path use the same pause and admission with the same
key. macOS and NFS are unqualified (src/claims/QUALIFICATION.md: Linux
containers only); slot retention is unmeasured.
