# Internal claim configuration

This module is an internal building block, not a public library API or a
complete claim feature. The canonical claim CLI uses it through
`src/claims/surface/`, and so do the MCP claim tools. It has three parts: a
pure resolver over the raw
`claims:` block, a read-only preflight shared by every future caller, and an
initialization facade over the existing descriptor bootstrap in
`../storage`.

## The `claims:` block

One block, in column 0 of the project's existing configuration file
(`backlog/config.yml` or equivalent), with nine required snake_case sub-keys,
three optional ones, two optional policy keys and one optional authority list:

| Key | Type | Required | Notes |
| --- | --- | --- | --- |
| `enabled` | YAML boolean | always | gates `acquire` only, see below |
| `endpoint` | explicit `git:`/`ssh:`/`http:`/`https:`/`file:` URL | always | byte-identical, never normalized; same rule as the storage endpoint check |
| `storage_format` | `blob` \| `tree` \| `commit-chain` | always | no format default |
| `lifetime_mode` | `lease` \| `hard` \| `none` | always | selects which of the next two keys apply |
| `lease_ttl_ms` | safe integer > 0 | only for `lease` | `not-applicable` under `hard`/`none` |
| `reclaim_grace_ms` | safe integer ≥ 0 | for `lease` and `hard` | `not-applicable` under `none`; `0` is explicitly allowed |
| `attempt_timeout_ms` | safe integer, 1 to 2147483647 | always | per Git command, not per attempt |
| `attempts` | safe integer ≥ 1 | always | counted and returned, not applied here |
| `operation_budget_ms` | safe integer, 1 to 2147483647 | always | counted and returned, not applied here |
| `clock_uncertainty_ms` | safe integer, 0 to 2147483647 | optional here | eps; no start value; tested up to 2000 ms ([evidence repository](https://github.com/lunetics/backlog-md-claims-qualification)); larger values were not |
| `retry_pause_base_ms` | safe integer, 0 to 2147483647 | optional here | start value 1000 (`CLAIM_RETRY_START_VALUES`) |
| `retry_pause_max_ms` | safe integer, 0 to 2147483647, not below the base | optional here | start value 5000; `max < base` is `out-of-range` on this key |
| `transfer_time_box` | `require-explicit` \| `preserve` \| `restart` | optional everywhere | time-box action of a transfer; absent means `require-explicit` |
| `acquire_dependency_policy` | `strict` \| `permissive` | optional everywhere | dependency gate of a direct acquire; absent means `strict` |
| `recovery_authorities` | list of `ta1-` + 64 lowercase hex digits | optional everywhere | authority IDs that may run the operator commands `claim emergency-release` and `claim install-epoch`; absent means nobody |

**The three surface keys.** Before them, the block had no key for eps or retry
pauses. The resolver validates each of them fully when the block names it
(type, range, duplicates, `max >= base`) and adds it to the settings as
`clockUncertaintyMs`, `retryPauseBaseMs` and `retryPauseMaxMs`; an absent key
stays absent and is never filled in. Requiring them is the surface core's job,
per command: every mutating command and `retry` need all three,
`list --context` needs eps only, and a missing key is reported there as
`config-invalid` with `{ key, problem: "missing" }`, before any network. The
nine-key contract and its tests are otherwise unchanged; the start values of
the two pause keys live in `CLAIM_RETRY_START_VALUES` of the surface core, and
`CLAIM_START_VALUES` keeps its five entries.

**The policy key `transfer_time_box` (with one deviation).** It
names the time-box action a `claim transfer` uses under a hard end when the
caller passes no `--time-box`. Before it, the block had no key for a transfer
policy. The resolver validates it like the three surface keys when the block
names it: `missing` for a key without a value (`null`), `wrong-type` for a
non-string, `unsupported-value` for any other string (case included),
`duplicate`. It is the last entry of the schema order, so every existing
problem list keeps its order; it is valid in every lifetime mode (never
`not-applicable`), and `transferTimeBox` appears in the settings only when the
block names the key. **The deviation:** unlike the surface keys, no caller
requires it. The requirements name its default, so an absent key is
`require-explicit` by definition and never a `missing` problem; the resolver
still writes no value for it. `claim setup` does not write it, so the template
keeps its twelve keys. `restart` is accepted and ends `requires-time-path`
under a hard end; a restart with a new hard end needs an explicit `--hard-end`.
A `retry` replays the recorded operation and never reads the key again.

**The policy key `acquire_dependency_policy` (the explicit exception to "no
defaults").** It decides whether a direct `claim acquire` checks the ticket's
prerequisites against the local task corpus before any network: `strict`
refuses a blocked or unresolved ticket, `permissive` skips the check. Before
it, the block had no key for a dependency policy. The resolver validates it
exactly like `transfer_time_box` (`missing`, `wrong-type`, `unsupported-value`
for any other string, case included, `duplicate`), in every lifetime mode; it
is appended after `transfer_time_box` in the schema order, so every existing
problem list keeps its order, and `acquireDependencyPolicy` appears in the
settings only when the block names the key. **The exception:** an absent key
means `strict`. The resolver still writes no value; the surface core reads the
absence as `strict`, so a project without the key gets the fail-closed gate.
`claim setup` does not write it. The ready selection of `claim next` is always
strict and never reads the key; renew, release, reclaim, transfer, resume,
change-bounds, resolve, retry and list never check prerequisites.

**The authority list key `recovery_authorities`.** A list of authority IDs
(`ta1-` plus 64 lowercase hex digits, as `claim context show` prints them)
whose contexts may run every operator command that consults the list: today
`claim emergency-release` (and a `claim retry` of its record) and
`claim install-epoch`. The resolver validates it
when the block names it: `missing` for a key without a value, `wrong-type` for
anything but a list, `unsupported-value` once for the whole key when any entry
is not a string of that form (a binding included), `duplicate`. It is the last
entry of the schema order, valid in every lifetime mode, and
`recoveryAuthorities` (a copy of the list) appears in the settings only when
the block names the key. An absent key or an empty list authorises nobody; the
surface core compares the operator's authority ID with it locally, before any
Git command. `claim setup` does not write it. The list is versioned
configuration: whoever can commit it can list their own context, so it is no
protection against direct Git manipulation.

**There are no defaults** (except the documented reading of an absent
`acquire_dependency_policy` above). `CLAIM_START_VALUES` exists only for an
explicitly written template and for the wording of a `missing` message; the
resolver never substitutes it. A project without a `claims:` block resolves
to `not-configured`. Any block that is present, even an empty one, is
validated in full: a missing, empty, or `null` value for a required key is
reported as `missing`, never treated as "disabled" or "not configured".

`resolveClaimSettings` is pure and detects duplicate sub-keys and a second
column-0 `claims:` block itself, by scanning the raw text, rather than
trusting whatever a YAML parser does with a repeated key. Problems are
reported as a complete, schema-ordered list, with unrecognized keys appended
afterward in document order. No message ever repeats a configured value or
parser text, since an endpoint may carry credentials.

## Embedding in the project configuration

`parseConfig` captures the block byte-identically into
`BacklogConfig.claimsYaml`, without validating it: a bad or absent block
must never stop normal startup or make the MCP server skip the project root
(a deliberate, documented deviation from validating every config value
eagerly). `saveConfig` appends the block unchanged behind a narrow guard —
its header must be a column-0 `claims:` line, and every following line must
be blank, a comment, or indented, else the save throws and the file stays
untouched. This is what lets every existing config writer (the CLI, the
browser settings page, the startup migration, ...) keep a block it never
knows about, instead of silently dropping it the next time it saves.

## The purpose gate

A preflight always names one purpose: `observe` (list, show, resolve
outcome, rights query), `maintain` (renew within an unchanged hard end,
release, reclaim, transfer, resume and change-bounds, the emergency release
and its preview and `claim install-epoch`), or `acquire` (new claim work).
`enabled: false` blocks `acquire` only:

- `observe` and `maintain` stay `ready`.
- Disabling never writes anything and never releases anything by itself;
  stored claim times keep running exactly as before, and another holder can
  still reclaim after their boundary passes.
- Initialization is allowed regardless of `enabled`, because it creates no
  claim.

Configuration is read per checkout and branch. There is no remote switch:
disabling only affects clients that read this particular file. A different
endpoint on another branch is an undetected second coordination area; that
stays a documentation duty, not a check this module performs.

## What a `ready` preflight does not prove

`preflightClaimStorage` makes exactly one network attempt, using
`attempt_timeout_ms` as the per-Git-command timeout; `attempts` and
`operation_budget_ms` are validated and returned but never applied here —
that belongs to the command run that includes the preflight.
A `ready` result carries `scope: "preflight-only"` for a reason:

- It reserves nothing. A concurrent writer can still win a race the instant
  after a `ready` snapshot is read; `store.write` still resolves that
  through the storage layer's own optimistic concurrency.
- It proves the endpoint is reachable and the descriptor matches, not that
  the caller can write to it, and not any server-side capability.
- Only `ready` allows continuing. Every other verdict — including
  `unknown` — carries just `kind` and `reason`, never a store or a
  ticket observation.

Preflight failures are always one of the fixed kinds in
`ClaimPreflightResult`, with a fixed reason text; raw Git stderr and
configured values (an endpoint's credentials, a repository or context path,
a private binding or secret) never appear in a reason or a problem message.

## Explicit context selection

A private context is chosen only through an explicit, absolute
`contextDirectory` — never derived from an environment variable, host,
user, cwd, or Git remote, and never "the only context that happens to
exist". It is mandatory for `maintain` and `acquire`, optional for
`observe`; a context that is given but broken is always reported
(`context-invalid`, `context-corrupt`, `context-unavailable`), never
silently ignored. A byte-identical copy of a context directory is
indistinguishable from its original; this module does not attempt to
detect that (see `../context/README.md`).

## Initialization

`initializeClaimCoordination` opens the area first, without writing, so an
unsupported schema is reported exactly instead of folded into `corrupt`
(the way a direct call to `initializeClaimStorage` would). Existing ticket
refs without a descriptor are reported as `not-empty` through a small
read-only probe (`probeClaimRefs`) and nothing is written; that probe is
racy, since the descriptor is not a multi-ref lock. A local configuration
change never migrates anything: a different configured format on an
existing area is `conflict` with the existing descriptor, and a different
endpoint is simply a new, empty area until it is explicitly initialized.
An unknown push outcome is passed through unchanged, never reinterpreted
as `created` or `exists` through a follow-up read. Initialization is
allowed while `enabled: false`, since it creates no claim.
