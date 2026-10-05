# Private claim execution contexts

This is an internal local-persistence contract for a claim worker incarnation,
not a public TypeScript API, CLI feature, export/import format, or lifecycle
policy. The module implements explicit create/load primitives; local success
does not establish remote ownership or complete worker recovery.

## Create and load

`createClaimContext({ parent, recoverFrom? })` returns either a newly
created public context or `invalid`, `corrupt`, or `unavailable` with a fixed,
safe diagnostic. `loadClaimContext({ directory })` returns a validated
public context or the same failure kinds. The public context is exactly
`{ contextId, binding, journalDirectory, recovery }`; `recovery` is `null` or
`{ binding }`. It never returns a secret, owner, authority flag, ticket, lease,
timestamp, or remote-outcome field.

Both calls require an explicit absolute directory. There is no default based on
the current directory, host, user, actor, or process, and no automatic lookup
by any of those values. Loading never creates, rotates, or repairs a context.

## Private layout

The caller supplies an existing absolute `parent` directory that is owned by
the current UID, nonsymlink, and exactly mode `0700`. Its ancestors, the parent,
and context paths must be trusted and stable while an operation runs; the
checks are not a continuing protection against later path replacement. There is
no `mkdir -p`, permission repair, overwrite, or adoption of a pre-existing
context.

Creation generates a lowercase UUID and creates exactly `parent/contextId`
with mode `0700`; `EEXIST` is reported as `unavailable`, without retrying into
another or existing directory. The process umask must preserve owner bits;
otherwise creation fails closed and can leave an unusable partial directory.
Permissions are never repaired automatically. Before the record is published,
it provisions a mode-`0700` `journal` subdirectory for the existing journal
primitive. `context.json` is a
current-UID-owned regular mode-`0600` file containing canonical JSON with one
LF and exactly:

```text
{schema:1,contextId,binding,secret,recovery}
```

`secret` is 32 random bytes encoded as 64 lowercase hexadecimal characters.
`binding` is `tb1-` followed by lowercase SHA-256 hex over UTF-8
`backlog.md/claim-context/v1\0` plus the raw secret bytes. The selected
directory basename must equal the record's `contextId`.

This is plaintext private storage protected by OS permissions, not encryption.
Secrets must not appear in returned values, logs, or interpolated errors.

## Recovery and publication

With `recoverFrom`, creation fully validates the explicit source first. It
leaves that source—including its journal—unchanged, then creates a fresh
destination secret and binding. The new record stores only the immediate source
`{ binding, secret }`; its public recovery value exposes only the binding. It
does not copy a transitive recovery chain or operation records. Multiple
recoveries may retain the same old proof while each gains its own distinct
binding; none is thereby a remote winner or an authorized worker.

Publication writes the complete record to a unique mode-`0600` temporary file
in the new context directory, synchronizes and closes it, hard-links it to
`context.json` without replacement, then removes only that call's temporary
file. It synchronizes the journal directory, context directory, and parent
directory, in that order, before returning `created`. It performs no recursive
cleanup after failure: partial or orphan contexts remain corrupt/unadopted, and
a later fresh create is neither a retry nor cancellation of a claim operation.

Load validates the directory and parent preconditions, private journal, record
identity and canonical bytes, and the own and recovery secret-to-binding
derivations. Missing or unsafe requested directories are `invalid`; an
existing context with an unsafe/malformed record or journal is `corrupt`; I/O,
synchronization, or unsupported-runtime failures are `unavailable`. Before
returning `loaded`, it synchronizes the record and then the journal, context,
and parent directories. A local `created` or `loaded` result means only that
local material was persisted and validated—not that a Git/remote operation
succeeded, that current rights exist, or that any worker owns a claim.

## Authority ID

`claimContextAuthority({ directory })` loads and validates the same private
record as `loadClaimContext` and returns `{ kind: "derived", authorityId }` or
the same failure kinds. The authority ID is `ta1-` followed by lowercase
SHA-256 hex over UTF-8 `backlog.md/claim-authority/v1\0` plus the context's own
raw secret bytes, never the recovery proof's; the hash shape is the binding's,
with another prefix and domain. The ID is not a binding and names no binding:
neither can be computed from the other without the secret, which never leaves
this module. It is not stored in `context.json` and is not part of the public
context. An operator lists it in `claims.recovery_authorities` to allow
`claim emergency-release`; `claim context show` prints it. A byte-equal copy
of a context has the same secret and therefore the same authority ID, so a
copy cannot be told apart from its original here either.

## Tested boundary

No CLI or export/import interface is specified here, and this sidecar makes no
physical-power-loss durability claim. The native contract tests use Linux local
files, separate Bun processes, injected synchronization failures and gated
process kills. Run them with `bun run test src/test/claim-context.test.ts`;
`bun run test claim-` also checks the existing journal and storage adapters.
These tests cover none of: other platforms, network filesystems, hostile
same-UID clients, copied active secrets, or automatic worker-restart detection.
