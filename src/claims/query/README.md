# Read-only claim mutation query

This module provides an internal bridge from an existing private journal record
to a fresh native storage read and single-mutation resolution. It queries
storage evidence only; it never dispatches a mutation or evaluates current work
rights.

## API and sequence

`queryClaimMutation({ journalDirectory, operationId, storage, journalIO? })`
returns a promise of a query result. `storage` is the explicit native
`ClaimStorageOptions`; the operation ID selects the original persisted intent
in the existing private journal. There is no public library, CLI, settings,
executor, or rights-evaluation interface here.

Before the first await, capture primitive inputs and a separate storage-options
object, including repository, endpoint, format, and timeout. If `journalIO` is
supplied, capture its function entries too. Later caller mutations must not
redirect the query or change the operation ID or timeout.

1. Open the explicit existing journal with `openClaimIntentJournal` and load
   the original operation ID. Any result other than `loaded` ends the query
   before storage opening. Do not prepare another intent or create a journal
   or context directory.
2. Require captured `storage.remote` and `storage.format` to equal the loaded
   original intent exactly. A mismatch is `invalid` before storage opening.
   Do not substitute current project scope or normalize endpoint aliases.
3. Open that explicit native store without initialization or format fallback.
   Check its actual descriptor schema, format, and epoch against the original
   intent before reading the ticket.
4. Read `record.intent.ticket` freshly through that same opened store. Pass
   the original record, captured exact endpoint, actual opened descriptor, and
   new read result to `resolveClaimMutation`. No caller-provided observation,
   cached verdict, or previous read supplies the evidence.
5. Return `{ kind: "resolved", resolution }` with the unchanged resolver result.
   Even an `open` resolution triggers no dispatch, retry, new operation ID or
   binding, or recalculated deadline.

Basic invalid input may fail early. No network action precedes a valid loaded
record and the explicit source equality check.

## Results and failure mapping

| Origin | Query result |
| --- | --- |
| Invalid own input or journal open/load `invalid` | `invalid`, before any remote call |
| Journal open/load `unavailable`, or unexpected local journal exception | `unavailable`, without repair or remote call |
| Journal load `absent` | `record-absent`, without a remote verdict |
| Journal load `corrupt` | `record-corrupt`, without rewrite or remote call |
| Explicit endpoint/format differs from the original intent | `invalid`, before storage opening |
| Store open `invalid` | `invalid`, from local checks before any remote call |
| Store open `descriptor-missing` or `format-mismatch` | `unknown-history`, without initialization, migration, or fallback |
| Opened descriptor schema/format/epoch differs from the original intent | `unknown-history`, before ticket read |
| Store open `schema-unsupported` | `unsupported`, without downgrade |
| Store open `corrupt` or `unreachable` | `unknown` |
| Unexpected store opening/read exception | `unknown` |
| Any native store read result | `resolved` with the single-mutation resolution; read errors become nested `unknown` |

Results contain exactly `{ kind: "resolved", resolution }`,
`{ kind: "record-absent" }`, or `{ kind, reason }` for `record-corrupt`,
`invalid`, `unavailable`, `unknown`, `unknown-history`, and `unsupported`.
Reasons are fixed safe strings: no input paths, endpoints, raw intents, receipt
digests, upstream errors, or raw exceptions enter caller diagnostics.

`resolved` means the resolver ran; its nested answer may still be `open`,
`conflict`, `unknown`, `unknown-history`, or `invalid`, as well as `stored` or
`not-stored`. Outer local failures do not fabricate remote verdicts.
`record-absent` never proves the operation was never sent or stored. A missing
or changed descriptor yields `unknown-history` because this scope cannot now
establish the old result; it does not prove that a reset occurred.

## Read-only boundary and limits

Queries publish no journal records, create no contexts, mutate no remote refs,
and write no code or ticket branches. They do not retry reads or writes, repair
state, or authorize another operation. Existing journal loading still performs
file/directory synchronization; native store opening and reading may fetch Git
objects and use existing transient local refs. These local filesystem effects
are permitted by the read-only contract.

`journalIO` is solely the existing journal's internal filesystem-fault test
seam. Production omits it; it is not a backend, CLI option, setting, store mock,
or replaceable runtime connector.

The optional positive storage timeout applies per Git command. Omitting it
uses the existing storage default. A query can execute several commands, so
this is not an end-to-end time budget and adds no retry policy.

The journal's trusted stable-path requirements and the resolver's stable epoch,
cooperative writers, never-repeated roots, and complete in-epoch receipt
retention assumptions remain necessary. Exact endpoint equality does not
authenticate a server; receipt-count consistency does not independently prove
complete history. Local record absence cannot reconstruct missing evidence.
A query result neither authenticates the worker nor establishes logical
`APPLIED`, current ownership, a work right, or authorization for a retry.
