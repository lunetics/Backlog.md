# Private claim operation intents

Internal pre-dispatch persistence for the native claim implementation. This is
not a public TypeScript API, a claim command, an instance credential store or
a workflow engine. The internal executor and mutation query use it; no command
is connected.

## Meaning of results

- `prepared`: this call published and synchronized a new intent.
- `loaded`: an existing, validated intent was synchronized and returned.
- `conflict`: the operation ID already binds different canonical content.
- `absent`: no final record was found in this private journal; not proof that
  this operation was never sent from another context.
- `invalid`: invalid input or private-directory preconditions.
- `corrupt`: an existing final path is unsafe or its record fails validation.
- `unavailable`: IO or synchronization failed. A final record may already exist;
  retry with the original intent, never silently allocate a replacement ID.
- `enumerated`: the read-only list of valid final records, sorted by operation
  ID in code units, and the count of `corrupt` entries.
- `admitted`: the admission slot of the record's key holds exactly this record.
- `held`: the slot of that key holds another record, named by its operation ID.

Neither successful result says that a Git mutation happened, that it failed,
or that the caller currently owns a claim. The future execution layer must
check those facts separately, and must not send without a durable intent.

The record binds the endpoint, format, epoch, ticket, expected root, target
binding, action, parameters and already-resolved values. Retrying does not
recalculate a deadline or resolve a newer configuration. Canonical object-key
ordering is shared with the storage adapters; array order remains meaningful.
SHA-256 digests detect inconsistent records, not malicious owner rewrites.

## Persistence boundary

The caller provides an existing absolute private directory (0700, current UID)
outside version control. No directory is implicitly created, permission-fixed
or discovered from the repository. Parent directories must be trusted and
stable, including the journal directory itself while an operation is running.
Directory checks are point-in-time checks; subsequent file operations use paths,
not descriptor-relative access that would pin their lookup to that directory.
Each operation rechecks the journal directory; final regular files
must be owned by the same UID and have mode 0600. No-follow opens reject final
symlinks, but do not protect every ancestor from a same-UID attacker.

Publication uses a unique 0600 temporary file in that directory:

1. Write the complete canonical record and synchronize the file.
2. Hard-link it to `<operationId>.json`, without replacing an existing name.
3. Remove only this call's temporary name and synchronize the directory.
4. Return `prepared`.

An existing name is loaded and compared, never overwritten. Loaded records
are file- and directory-synchronized before returning `loaded`; this can finish
an interrupted publisher's persistence. The API never deletes final records.
Crash leftovers are ignored, not swept while another process may still use
them. A cleanup failure may leave the current call's temporary name too.

Atomic publication is not the same property as durable storage. File-sync
does not by itself persist a directory entry: see [fsync(2)](https://www.man7.org/linux/man-pages/man2/fsync.2.html).
The no-replacement primitive is documented by [link(2)](https://www.man7.org/linux/man-pages/man2/link.2.html).

## Enumeration

`enumerate()` checks the directory like every other operation, lists it with
`readdir` and classifies each name, in code-unit order:

- `<operationId>.json` with a valid journal ID is validated exactly like a load
  (owned private regular file, no-follow open, same inode, UTF-8, canonical
  record whose ID equals the name), but without the file and directory
  synchronization. A failing record, or one gone again after `readdir`, counts
  as corrupt: the API never deletes records.
- `.intent-<lowercase UUID>.tmp` and `.admission-<64 lowercase hex>` are ignored
  and never opened. A temporary was never published, a slot duplicates a
  record.
- Every other name counts as corrupt.

An unsafe or missing directory is `invalid`; a `readdir`, `lstat` or `open`
failure is `unavailable`, also for an IO seam without `readdir`. Opening the
journal does not check the seam's shape. Enumeration never creates, links,
removes, renames or synchronizes anything, and it proves nothing about records
that appear or disappear after the listing.

## Send admission

`admit(record)` decides which intent of one key may be sent. The key is the
intent's ticket, endpoint, format, epoch and expected root; action, parameters
and target binding are not part of it. The slot name is `.admission-`
followed by the lowercase hex SHA-256 of the UTF-8 bytes
`backlog.md/claim-admission/v1\0` and the canonical JSON of that key.

1. The argument must be a valid record (else `invalid`), and it must equal the
   published `<operationId>.json` canonically: a missing record is `invalid`,
   a different one `corrupt`. The record is read with load's checks and
   synchronization.
2. An existing slot is read with the same checks. It is `corrupt` unless it
   holds a valid record whose key hashes to the slot name; that record is
   `admitted` when it equals the argument, otherwise `held`.
3. A missing slot is published exactly like a record: a 0600 temporary with
   `${canonicalJson(record)}\n`, file synchronization, a hard link to the slot
   name without replacement, removal of the temporary and directory
   synchronization. `EEXIST` reads the slot as in step 2.

A slot is its own file, so records keep one link. Slots are never replaced,
removed or renamed, and there is no rename, copy or exclusive-create fallback
when linking fails (`unavailable`). Admission is idempotent and never waits for
another call. The executor sends only an `admitted` intent; see
[pause/README.md](../pause/README.md) for what this proves.

## Tested scope

The tested environment is Bun on Linux with a local disk-backed filesystem,
separate processes, deterministic SIGKILL gates and injected syscall failures.
A test plan alone is not a passed run.
Process-crash tests say nothing about physical power loss, storage controllers,
NFS/CIFS/FUSE, Windows or macOS. Unsupported hardlinks or synchronization fail
closed; there is no rename, database or best-effort fallback.

An existing private directory is assumed to have been durably provisioned by
its context owner. Loss of that directory, restoration of old private state,
instance-secret cloning, remote outcome reconstruction and receipt retention
are separate concerns. In particular, an old intent never authorizes a new
worker instance to act as the previous owner.

`claimJournalIO` is an internal test seam for filesystem calls, not a configurable
storage backend. Production has no environment-variable crash switches.
