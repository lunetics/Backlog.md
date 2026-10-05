# Internal claim storage

This directory implements a Git-backed storage boundary, not a public library
API or the complete claim feature. It does not decide who may own a ticket,
whether a lease has expired, or which workflow should run next. There are no
public claim CLI/MCP commands wired to this module yet.

## Coordination and representation

Independent clients coordinate through the same explicit Git endpoint. The
remote ref, not a local branch or `FETCH_HEAD`, is authoritative. Ticket refs
live under `refs/claims/<canonical-ticket-id>`; the format descriptor is a blob
at `refs/claim-meta/format`.

The configured format is exactly one of the following; there is no automatic
default or fallback. The schema is `1`. The epoch is a positive safe integer:
`1` at initialization, one more with every `claim install-epoch`.
Every document carries the epoch of the descriptor it was written under.

| Format | Ticket-ref target | Required receipt retention |
| --- | --- | --- |
| `blob` | One canonical JSON blob containing the complete document | All receipts remain in the current blob |
| `tree` | A tree with a `state` blob and a `receipts` subtree | Every receipt remains reachable through tree entries |
| `commit-chain` | A separate single-parent chain of claim commits | Each commit adds one receipt; parent edges retain earlier receipts |

Tree entries use mode `100644` for blobs and `040000` for subtrees. The `state`
blob contains the document without `receipts`. Receipt filenames are operation
IDs and their contents are receipt JSON. Blob/tree snapshots contain the full
receipt set; each commit-chain layer contains only its new receipt.

JSON keys are recursively sorted by ECMAScript code-unit order, with compact
encoding and one final newline. Commit-chain writer metadata is fixed solely
for deterministic object IDs: author and committer are
`Backlog.md Claims <claims@backlog.invalid> 0 +0000`, with message
`claim <TICKET> revision <n>` followed by one newline. These headers are neither
agent identity nor time authority. All three codecs have passed the native
Git-TCP contract suite.

## Internal operations

- `initializeClaimStorage` creates the descriptor only if absent. An existing
  matching format is reported as `exists`; another format is `conflict`. A
  same-format initializer that loses the race reads the descriptor again and
  reports `exists`.
- `openClaimStore` validates the descriptor without creating it. Opening a
  store is preflight, not a guard against subsequent live migration. The
  store keeps the descriptor's epoch and the root it was read at.
- `read` obtains a fresh remote snapshot through an isolated local fetch ref.
  `absent` means a successful remote lookup found no ticket ref. Unreachable
  or corrupt storage is not a free ticket.
- `write` accepts a snapshot and one change: operation ID, opaque receipt and
  opaque payload. It derives the next safe-integer revision, preserves previous
  receipts, and checks a present snapshot against its local object graph.
  It pushes with an explicit expected-root lease. No unconditional force,
  deletion, fallback ref, or retry against a newer root is performed. A
  refusal by the endpoint is read again before it is reported: `stale` when
  the ticket ref no longer holds the snapshot's root (the ref moved, vanished or
  appeared), `remote` when it still does or the re-read fails; a refusal met
  at exactly this write's own root reads `unknown`, as after an up-to-date
  push, and the caller resolves it by query.
- `read` and `write` check every document, and every commit-chain layer,
  against the epoch of the opened store: a document of another epoch reads
  `corrupt`, never free, and is never the base of a write (`invalid`). A new
  document carries the store's epoch.
- `swapClaimEpoch` and `installClaimEpoch` belong to `claim install-epoch`
  only and take the store the run opened. The swap writes the descriptor of
  the next epoch, leased on the descriptor root the store opened: a lost lease
  is `epoch-changed`, a remote refusal with the descriptor unchanged is
  `declined`, and so is one whose re-read of the descriptor fails (unreachable,
  corrupt, absent or of an unsupported schema), the reason naming both facts. The install then writes,
  per ticket, first `refs/claim-archive/<old epoch>/<TICKET>` onto the old root (created, empty
  lease), then the ticket ref, leased on that root or created, as a fresh
  document of the new epoch and format: revision 1, the given payload and one
  maintenance receipt `{schema: 1, kind: "epoch", fromEpoch, epoch,
  isolation: "attested"}` under one `m-<uuid v4>` per run. Its commit-chain
  layer has no parent. A ticket whose archive or rewrite did not apply is
  reported unsettled and left as it is. `write` never moves a document into
  another epoch or format.

`applied` confirms the storage update, not current claim ownership. `not-sent`
guarantees that this invocation did not attempt a remote mutation, although it
may have read the remote earlier. `rejected` reports a confirmed refusal;
initialization reports it only when the descriptor remains absent. `unknown`
remains conservative when the outcome cannot be positively classified. In
particular, a lost response can follow a successful remote write. An unchanged
(`=`) push is not proof of a new successful compare-and-swap. A fresh read and
the reachable operation receipt allow a higher layer to investigate an
ambiguous outcome.

Payloads such as `claimed` or `free` have no lifecycle meaning here. A release
is stored as another revision, not by deleting the ref. Reusing an earlier
payload therefore does not reuse the earlier root. Assignee, agent selection,
notification and recovery policy belong outside this storage boundary.

## Tests and limits

Run the native storage and primitive integration suites with:

```sh
bun run test claim-
bun run check:types
bun run check .
```

Tests use real Git processes, independent clients and a loopback TCP daemon.
They cover concurrent/held writes, lost responses, identical retries, corruption,
receipt reachability after GC and unchanged local branch/tag/tracking refs.
One commit-chain overflow fixture is explicitly skipped: a valid chain of
`Number.MAX_SAFE_INTEGER` revisions is infeasible to construct; blob/tree cover
the shared overflow guard and chain tests reject truncated histories.

This covers no other Git host, transport helper or platform. Endpoint
syntax validation is not a hosting guarantee. Per-command timeouts are not a
proof of end-to-end claim deadlines. The descriptor is not an atomic
multi-ref migration lock, and the module provides no claim authorization or
tamper resistance. Required receipts are not automatically pruned.

### Epochs and maintenance

A new epoch makes every document of the old one unreadable at once: its roots
stay where they are until the maintenance run rewrites them, and every client
reads them as `corrupt` meanwhile. Every root the run writes is new, since its
content names the new epoch; no earlier root is written again or used as the
lease of a claim write. No ref is removed. The archive refs keep every old
root, and so every old receipt, reachable through Git garbage collection;
nothing cleans them up automatically. Operations recorded before the new epoch
are not resolved through the archive refs.

The maintenance receipt records the operator's isolation statement, remotely
and durably; it proves no isolation. The descriptor CAS is the only guard
between two runs. The run compares two listings before the swap and checks a
third one after its writes, which detects some foreign writes, never all: a
write the endpoint accepts after the last listing, or a receive that passed its
checks before the swap and lands later, stays unseen until someone reads the
ticket. Isolating every write path, in-flight receives and ref creation
included, is the operator's job: the maintenance run was tested on a plain Git
server, and server garbage collection on the plain server and on Gitea
([evidence repository](https://github.com/lunetics/backlog-md-claims-qualification)), but no host was shown to isolate the write
paths. Clients of a version that reads only epoch 1 treat every later epoch as
unreadable. The command never changes `config.yml`: after a format change every
checkout reports `format-mismatch` until the configuration names the new format.

### Operational limits

Endpoints must be explicit URLs using `git:`, `http:`, `https:`, `ssh:`, or
`file:`. Named remotes and scp-style shorthand are not supported. The endpoint
never carries credentials: a password is refused on every scheme, and a
username is accepted only on an `ssh:` endpoint, whose account name is not a secret.

Reading a present snapshot fetches its objects into the local repository under
an isolated temporary ref, then deletes that ref. The snapshot can therefore
be used for a write only while those local Git objects remain available: a
present-snapshot write validates the snapshot against them. Aggressive local
garbage collection can remove them. Reads and writes also leave fetched or
newly written objects for normal Git garbage collection, including when a push
is rejected.

Receipt retention makes stored data and work grow with the receipt history.
Commit-chain reads traverse more commits as revisions grow, and tree-format
receipt work grows with the receipt set. Sizes and latencies up to 1000 claims:
[evidence repository](https://github.com/lunetics/backlog-md-claims-qualification), see its table of sizes
and latencies. The configured timeout applies to
each Git command, not to the end-to-end operation. Every claim Git command runs
in its own process group; a command that exceeds `attempt_timeout_ms` is killed
together with its transport helpers, and the call returns within the attempt
bound plus a small margin. A command that ends on its own while a transport
helper it started still holds its output gives that output the same small
margin, then ends the helper and returns Git's own result. The claim commands
never prompt: authentication must come from an ssh agent, a key without
passphrase, or a credential helper that does not ask. Interrupting the command
from the terminal (SIGINT, SIGTERM or SIGHUP) reaches the Git call: while a
claim Git command is in flight the signal is forwarded to its process group, so
git and its transport helpers end with the command; the command itself ends with
the signal's conventional status. A surface with its own shutdown handler (the
MCP server, the browser server) keeps that handler; the Git call still receives
the signal.

### Strict object types

Descriptor and ticket roots must have the actual object type required by the
format. An annotated tag wrapping a valid blob, tree or commit is corrupt
storage, not an alternative representation. Readers inspect the type of the
resolved object ID before decoding its contents; `git cat-file blob` alone
can dereference a tag and does not prove a genuine blob root.

The contract suite checks descriptor and ticket-root wrappers for all three
formats, including valid-root controls and unchanged authoritative refs.
