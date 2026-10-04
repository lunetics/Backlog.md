# Claims qualification

A qualification run exercised Backlog.md claims end to end against real Git servers: separate client containers, one
shared coordination area, real transports, shifted clocks, injected failures and growing sizes. This page lists what
is qualified by that measurement, with which bounds, and what is not. A sentence of `CLAIMS.md` or of the claims guide
(`backlog instructions claims`) that no measurement covers is labelled below instead of being softened.

## What was qualified

- Backlog.md revision `bce2acc` (`backlog --version` 1.53.0), all three storage formats: `blob`, `tree` and
  `commit-chain`.
- Commits after the measured revision change only Markdown documentation (`git diff --name-only bce2acc`
  lists `*.md` files only). The claim modules of the published head are byte-equal to the product archived
  with every counted run (compared by Git blob hash), so the numbers below describe the shipped code, not an
  earlier state of it.
- Linux containers only. macOS, Windows and NFS are unqualified.
- Three client containers ran the shipped `backlog` CLI, and for some checks `backlog mcp start`, against one
  coordination area. Server hooks held pushes so that concurrent writes really overlapped, a network proxy cut,
  stalled, slowed or throttled the connection, and libfaketime shifted the clock of single clients.
- A stage counted only after a deliberately broken harness turned exactly the predicted checks red.

| component | version |
| --- | --- |
| Git (server and clients) | 2.47.3 |
| OpenSSH (plain Git server) | 10.0p2 |
| Gitea (rootless, HTTP and built-in SSH) | 1.24.7 |
| Bun | 1.3.14 |
| libfaketime | 0.9.10 |
| toxiproxy | 2.11.0 |

| stage | what it measured | official run | result |
| --- | --- | --- | --- |
| A | smoke per server, transport and format; acquire races, transfer; storage format and preflight | `k20a-native2` | 124 of 124 checks passed |
| B | lost replies and network loss; batch reclaim; CLI and MCP parity; secrets in output | `k20b-native2` | 115 of 115 passed |
| C | clock skew and late writes; restore, new epochs, incompatible data, `enabled: false`; sizes up to 100 claims | `k20c-native2` | 87 of 87 passed |
| size run | 1000 claims and a bandwidth-limited link | `k20c-size-native2` | 13 of 13 passed |

Each stage counts its run on this revision. The same matrix ran three times before: twice on the earlier revision
`fd23b8d` (`k20a-green1`, `k20b-green2`, `k20c-final1`, `k20c-size3`, then `k20a-rep2`, `k20b-rep4`, `k20c-rep1`)
and once on `cb45f9f` (`k20a-native1`, `k20b-native1`, `k20c-native1`, `k20c-size-native1`), with the same
verdicts, and on this revision every check kept its status and completeness. The size stage ran once per
revision by design; no call differed by more than 30 % between the three formats, which would have asked for a
second run.

## Servers and transports

All three formats passed every row listed for a server and transport. "Smoke" is one sequence per combination: init
from two clients, acquire, the other client's list and refused acquire, renew, release, the other client's acquire.

| server | transport | blob | tree | commit-chain | rows beyond the smoke |
| --- | --- | --- | --- | --- | --- |
| plain Git server (`git daemon`) | `git://` | smoke passed | smoke passed | smoke passed | none: control transport, not qualified for production |
| plain Git server (`git http-backend`) | `http://` | qualified | qualified | qualified | none |
| plain Git server (`git http-backend`, private CA) | `https://` | qualified | qualified | qualified | races, lost replies, batch reclaim, MCP, formats, epochs, sizes |
| plain Git server (OpenSSH, key) | `ssh://` | qualified | qualified | qualified | races, lost replies, batch reclaim, MCP, formats, epochs, clock, restore, maintenance |
| Gitea | `http://` | qualified | qualified | qualified | none |
| Gitea | `ssh://` | qualified | qualified | qualified | repeated acquire races, refs kept through Gitea's GC, 100 claims (blob) |

The private CA reached Git through `GIT_SSL_CAINFO` and the SSH key through `GIT_SSH_COMMAND`. Gitea over HTTP
authenticated through `GIT_ASKPASS`; a Git credential helper was not used. Both hosts accepted, listed and kept
`refs/claims/*` and `refs/claim-meta/*` in all three formats.

## Clock

`clock_uncertainty_ms` is qualified at 2000 ms; larger values are unqualified. With 2000 ms the measured skews within
that bound behaved like a true clock: reclaims with a clock 1000 or 2000 ms ahead ended `not-yet` at the true
boundary, and holders with a clock 2000 ms behind had no `live` work right after the hard end and recorded no witness
(`hard-expired`, nothing sent).

Nothing checks it. A clock that runs ahead by more than `clock_uncertainty_ms` can reclaim a claim before its
reclaim boundary; a clock that lags by more still reads its own work right as `live` after the hard end and can
record a false witness on the time path. Each window is as long as the excess over `clock_uncertainty_ms`. Measured
with a skew of 8000 ms over `ssh://`, three formats each:

| consequence | measured |
| --- | --- |
| clock 8000 ms ahead: early reclaim | `claim reclaim` started 5.0 s before the boundary: `applied`, one send, ended 2.3–2.7 s before the boundary |
| clock 8000 ms behind: false `live` work right | `claim list` 0.5 s after the hard end: `workRight` `live` |
| clock 8000 ms behind: false witness | `change-bounds` 0.2 s after the hard end: `applied`, two sends, phase `confirmed`; a true-clock reclaim after the old boundary then ends `not-yet` |

In every row the early takeover was an explicit `claim reclaim`; `claim next`, measured on a true clock, only
acquired free tickets.

## Sizes and latency

Measured over `https://` through the proxy, three formats, defaults `attempt_timeout_ms` 10000 and
`operation_budget_ms` 30000 (`k20c-native2` up to 100 claims, `k20c-size-native2` at 1000 claims, each alone on the test
machine). Latency is added per direction. Each cell shows the elapsed time across the three formats and the
status; "incomplete" means `complete: false`.

| claims | latency | `list` | `list --context` | `reclaim-preview --all` | `next` | batch of 10 | batch of 100 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 0 ms | 1.1–1.4 s `ok` | 1.2–1.4 s `ok` | 1.1–1.4 s `ok` | 3.3–3.9 s `applied` | 3.1–3.3 s `ok` (1 ticket) | — |
| 1 | 200 ms | 5.0–5.5 s `ok` | 4.7–5.4 s `ok` | 4.8–4.9 s `ok` | 17.7–18.1 s `applied` | 14.3–14.5 s `ok` (1 ticket) | — |
| 1 | 1000 ms | 22.9–23.1 s `ok` | 20.7–20.9 s `ok` | 20.8–21.1 s `ok` | 67.1–67.3 s `applied` | 48.0–48.4 s `ok` (1 ticket) | — |
| 100 | 0 ms | 19.5–21.4 s `ok` | 15.6–18.0 s `ok` | 15.7–17.8 s `ok` | 3.9–4.0 s `rejected` | 18.0–20.6 s `ok` | 165.1–168.1 s `ok` |
| 100 | 200 ms | 32.5–33.0 s `unknown`, incomplete | 30.6–31.0 s `unknown`, incomplete | 31.1–31.7 s `unknown`, incomplete | 28.8–29.0 s `rejected` | 122.1–123.4 s `ok` | not run |
| 100 | 1000 ms | 32.9–33.4 s `unknown`, incomplete | 39.2–39.5 s `unknown`, incomplete | 30.7–31.4 s `unknown`, incomplete | 140.7–141.3 s `rejected` | 125.7–126.6 s `unavailable`, incomplete | not run |
| 100, Gitea `ssh://`, blob | 0 ms | 31.0 s `unknown`, incomplete | — | 31.2 s `unknown`, incomplete | — | 24.6 s `ok` | — |
| 1000 | 0 ms | 31.0–31.1 s `unknown`, incomplete | 30.5–30.9 s `unknown`, incomplete | 30.5–31.0 s `unknown`, incomplete | 7.7–8.2 s `rejected` | 19.2–19.8 s `ok` | 153.5–176.4 s `ok` |
| 1000 | 200 ms | 31.0–31.1 s `unknown`, incomplete | 31.6–32.2 s `unknown`, incomplete | 31.7–32.2 s `unknown`, incomplete | 32.3–32.9 s `rejected` | 124.3–125.6 s `ok` | not run |
| 1000 | 1000 ms | 33.0–33.4 s `unknown`, incomplete | 39.0–39.6 s `unknown`, incomplete | 30.9 s `unknown`, incomplete | 145.0–145.1 s `rejected` | 126.7–127.2 s `unavailable`, incomplete | not run |
| 1000, 128 KB/s | — | 30.8–31.1 s `unknown`, incomplete | — | 30.7–30.9 s `unknown`, incomplete | — | — | — |

- **The 30 s budget is per call, never per batch.** A batch reclaims one ticket after another, each with its own
  `operation_budget_ms`; the batch of 100 took 165.1–168.1 s at 100 claims and 153.5–176.4 s at 1000 claims. No
  list-type call ran longer than 39.6 s, below `operation_budget_ms` plus `attempt_timeout_ms`.
- **Incomplete answers say so.** Where a read ran out of budget, `list` and `reclaim-preview` reported every unread
  claim as `unknown` and ended `unknown` with `complete: false` (at 100 claims and 200 ms: 14 to 16 of 100 read;
  at 1000 ms: 2 to 3 of 100). At 1000 claims they did so at every latency: 121 to 156 of 1000 read at 0 ms, 13 to 16
  at 200 ms, 2 to 3 at 1000 ms, 22 over 128 KB/s. None reported an unread claim as free.
- **A batch stops trying what it could not read.** At 100 and at 1000 claims and 1000 ms the batch of 10 reclaimed
  3 tickets, listed the other 7 in `unreadable` and ended `unavailable`.
- **`claim next` can take minutes.** At 100 and 1000 claims its five candidates were all taken; it ended `rejected`
  with stop `bound` after five `not-free` attempts, at 1000 ms after up to 141.3 s (100 claims) and 145.1 s (1000
  claims).

With 1000 claimed refs, `claim list` and `claim reclaim-preview` return no complete answer under the default budgets
at any measured latency (0/200/1000 ms, 128 KB/s); they report that honestly as `unknown` / `complete: false`.
`claim next` answers unambiguously at all three latencies (after ≈ 145 s at 1000 ms); `reclaim-batch` of 10 stays
complete up to 200 ms and ends `unavailable` after 3 of 10 candidates at 1000 ms (`k20c-size-native2`).

Recommendation, not measured: a project that holds that many claims needs a larger `operation_budget_ms`. Only the
defaults were measured.

## Guarantee-to-row mapping

Every guarantee sentence of `CLAIMS.md` and the claims guide is listed with the qualification rows that cover it. Row
ids name the checks in the full reports. Tiers:

- `qualified`: the rows passed in an official run over real transport, on the stage's combinations.
- `loopback`: a local behaviour (option parsing, a refusal before any network, a document's shape) covered only by
  the shipped test suites on a local `file://` area.
- `unqualified`: no row passed, and the behaviour is not local.
- `non-promise`: a "does not do" sentence; `shown` where a row showed the documented consequence.

Stage combinations, unless a row says otherwise: stages A and B on the plain Git server over `https://` and
`ssh://`; stage C clock and operations rows over `ssh://`, size rows over `https://`; always the three formats.
The `S` numbers in the guarantee column, S1 to S15, name the scenarios of [CLAIMS.md](../../CLAIMS.md); `S-01`
is the smoke row of the matrix.

### What a claim is, and setup

| guarantee | rows | stage | tier |
| --- | --- | --- | --- |
| One valid claim per ticket: of concurrent acquires exactly one lands | P1-01, P1-02, P1-06, P1-01g, S-01 | A; Gitea `ssh://` and all smoke legs | qualified |
| Every change is one conditional write; the slower one ends `rejected`, nothing is overwritten | P1-01, P1-06, P1-08, P7-03, P1-05s | A | qualified |
| Claim commands never change a task's status, assignee or content, and never commit | — | — | loopback |
| Task edits never move a claim; a release needs no local task file | P5-04 | B | qualified |
| Lease: a renew moves the lease end; reclaimable after the lease end plus the grace | S-01, P3-01-A0, P3-01c, P1-05 | A, C | qualified |
| A hard end on a lease: no renewal passes it | P3-04, P3-07 | C | qualified |
| Hard mode: every acquire needs `--hard-end` | — | — | loopback |
| Hard mode: reclaimable after the hard end plus the grace | P3-05 | C | qualified |
| `none`: never reclaimable | P2-05 | B | qualified |
| Contexts are private 0700 directories; a copy cannot be told apart | — | — | loopback |
| `--owner` is a display name only; the context makes a claim yours | P2-03, P4-02, P4-03 | B | qualified |
| Endpoints over `ssh://`, `http://`, `https://` | S-01 and every package row | A to C | qualified |
| Endpoints over `git://` | S-01 | A | unqualified (control transport only) |
| Endpoints over `file://` | — | — | loopback |
| Credentials in the endpoint URL are refused | — | — | loopback |
| SSH keys pass through unchanged | S-01, every `ssh://` row | A to C | qualified (key given through `GIT_SSH_COMMAND`) |
| A Git credential helper passes through unchanged | — | — | unqualified (HTTP authentication used `GIT_ASKPASS`) |
| `claim setup` writes twelve keys and never overwrites; `config set` takes no claims keys | — | — | loopback |
| `claim init` creates the area; run again it reports `exists` | S-01 | A | qualified |
| `context create` prints only the context ID | — | — | loopback |
| Commands never ask: broken credentials end `unavailable` | P5-02, P4-02k | B | qualified |
| A missing mandatory option ends `refused` before anything is sent | — | — | loopback |

### Workflows and recipes

| guarantee | rows | stage | tier |
| --- | --- | --- | --- |
| S1, S2: acquire, list, renew, release | S-01 | A | qualified |
| S3: the second agent gets `not-free`; a reclaim is `not-yet` with its boundary | S-01, P1-01c, P3-01-A0 | A, C | qualified |
| S4, "Ready selection and order": which tickets `claim next` selects and in which order | — | — | loopback (the selection is local; the acquire it runs is the qualified one) |
| `claim next` tries candidates with the acquire of `claim acquire`, never reclaims, stops at its bound | P6-10 | C, size run | qualified (the stop at the bound is noted in every N = 100 and N = 1000 row, not pinned by an assertion) |
| S5, "Dependency policy" | — | — | loopback |
| S7: a transfer is one write; a lease gets a fresh window | P1-04, P1-07 | A | qualified |
| S7: under a hard end `time-box-required`, a restart without `--hard-end` `requires-time-path`, `preserve` keeps the hard end | P3-08 | C | qualified |
| S9: `change-bounds` to an earlier hard end; `mode-change` | — | — | unqualified |
| S13: a later hard end over the time path ends `confirmed` with two sends | P3-03c | C | qualified |
| S14: a restart with a later hard end over the time path | — | — | unqualified |
| S6: a lost reply ends `unknown`; a new acquire from that context sends no second change; `resolve`; `retry` | P2-01, P2-04 | B | qualified (over real transport the change had landed: the new acquire ended `rejected` `held` and `resolve` answered `applied`) |
| S6: while the outcome is open, that new acquire ends `paused` (exit 7) | — | — | loopback (admission is local, decided from the journal and the planning read, before any send) |
| `claim retry` resends an open operation under its ID | P4-02 | B | qualified |
| `unknown` is not free | P2-02u, P4-01 | B | qualified |
| S15: a `witnessed` transition and `claim retry` of the confirmation | — | — | unqualified |
| S8: one replacement context resumes; the other gets no right | P2-03, P2-04 | B | qualified |
| S10: preview, batch of eligible tickets, `scope-required`, `--all` alone | P4-03, P4-04a, P4-05 | B | qualified |
| S11: refusals before any network | — | — | loopback |
| Refusals after reading the area: `format-mismatch`, `schema-unsupported`, `state-unsupported`, `claims-disabled` | P7-02, P6-02, P6-02s, P6-03 | A, C | qualified |
| S12: one JSON document per command; MCP `claim_list`, `claim_acquire`, `claim_resolve` print the CLI document | every row; P1-02, P5-01, P5-03, P6-02 | A to C | qualified |
| The other MCP tools over a real endpoint | — | — | unqualified |
| Free a claim whose holder is gone: exact root, `stale-root`, nobody assigned | P2-05, P1-05s | A, B | qualified |
| Install a new epoch after a restore: every ticket free, old proofs rejected, old operations `unknown-history` | P6-01 | C | qualified |
| `install-epoch`: an old write after the swap is `rejected`; one between swap and rewrite leaves `unknown` until a rerun | P7-04a, P7-04b | A | qualified |
| `install-epoch` causes `epoch-changed` and `writes-observed` | — | — | unqualified |
| The host keeps `refs/claims/*` and `refs/claim-meta/*`, through its garbage collection too | S-01, P6-04 | A, C; plain Git server and Gitea | qualified (these two hosts) |
| The host isolates the write paths for `install-epoch` | — | — | unqualified |

### Status, time path, budget and batch

| guarantee | rows | stage | tier |
| --- | --- | --- | --- |
| Exit codes: `ok` and `applied` 0, `rejected` 2, `unknown` 3, `unknown-history` 4, `refused` 5, `unavailable` 6, `paused` 7 | every CLI step; 0 and 2: S-01; 3: P2-01; 4: P7-04b; 5: P4-05; 6: P2-02r; 7: P4-02 (a host rejection) | A to C | qualified |
| `internal` 1 | — | — | unqualified (never produced) |
| `unavailable`: nothing was sent | P2-02r, P2-02s, P4-02k | B | qualified |
| Time path: a witness only while the clock plus `clock_uncertainty_ms` lies before the hard end | P3-03-L2000, P3-03c | C | qualified |
| Time path: the pending write (P) without a witness is `unknown`; others get `pending-transition` until the hull; then a reclaim | P3-05 | C | qualified |
| A renew sent before the hard end that lands after it: capped at the hard end, no `live` right after it | P3-04 | C | qualified |
| Stored timing is used as-is; a configuration change does not move it | P3-06 | C | qualified |
| The clock rules hold with `clock_uncertainty_ms` 2000 | P3-01-A0 to -A2000, P3-02-L0, -L2000, P3-03-L2000 | C | qualified (2000 ms) |
| A send stopped by the budget ends `unknown` with `stoppedBy: "budget"` | — | — | unqualified (no send was stopped) |
| A read past the budget reports the rest `unknown`, `complete: false` | P6-10, P6-11, P6-12 | C, size run | qualified |
| The batch's candidate list is fixed; a claim that becomes reclaimable later waits | P4-03 | B | qualified |
| Each reclaim of a batch checks the state again; a renewed claim ends `not-yet` | P4-04a, P4-04b | B | qualified |
| An `unknown` entry does not stop the batch | P4-01 | B | qualified |
| Unread tickets go to `unreadable` and are not tried | P6-10 | C, size run | qualified |
| A fault proven for the whole call stops the batch before any reclaim | P4-02k | B | qualified |
| Not promised: detecting a shared remote permission fault | P4-02 | B | non-promise, shown |
| Not promised: a batch budget, size limit or pagination | P6-10 | C, size run | non-promise, shown |

### What claims do not do

| sentence | rows | stage | tier |
| --- | --- | --- | --- |
| No fencing | P3-02-L8000, P3-04 | C | non-promise, shown |
| No clock check | P3-01-A8000, P3-02-L8000, P3-03-L8000 | C | non-promise, shown |
| No scheduler; no fairness of `claim next` | — | — | non-promise, not measured |
| No worker stopping | P1-05, P2-05 | A, B | non-promise, shown |
| No offline exclusivity | P2-02r, P2-02s, P5-03 | B | non-promise, shown |
| No protection against direct Git manipulation | P6-01w | C | non-promise, shown |
| No automatic reassignment after an emergency release | P2-05 | B | non-promise, shown |
| No quiescence proof | P7-04a, P7-04b | A | non-promise, shown |
| No task changes | P5-04 | B | non-promise, shown |
| No watch engine | — | — | non-promise, not measured |
| `enabled: false` only stops new claims | P6-03 | C | non-promise, shown |
| No transaction over several tickets | P4-01, P4-04b | B | non-promise, shown |
| No time-box extension outside the time path | P3-08, P6-03 | C | non-promise, shown |
| Time path: no work right on a pending claim | P3-05 | C | non-promise, shown for other contexts |
| Time path: no time authority on the server | P3-03-L8000 | C | non-promise, shown |
| Time path: no rescue of a lost witness | — | — | non-promise, not measured |
| Time path: no liveness | P3-05 | C | non-promise, shown |

## Operational observations

A host whose hooks hold a claim ref lock longer than its own ref lock wait (`core.filesRefLockTimeout`) makes the
overlapping writer end `rejected` with `storage` `remote` instead of `stale`: the writer's re-read still finds the
old root because the winner's update is not committed yet. Observed on the raw Git server with a harness hook that
held the lock (`k20b-injoff1` on the earlier revision `fd23b8d`, P2-03, 6 of 6; a guard run, not evidence); with
that hook changed the official runs show `stale` 6 of 6 (`k20b-green2`, `k20b-native1`, `k20b-native2`). Not seen
on Gitea. By the documented stop rules, `claim next` stops at such a candidate with exit 2 instead of trying the
next one; that was not measured.

A restore outside the install-epoch procedure turns back operations that had already landed, and by the documented
pause rule every context whose own operation it turned back is paused. Observed only in a dry run of the
qualification (`k20c-dry1`, P6-01w, three formats; not evidence): after a context's `claim release` had landed, the
server repository was restored to an earlier snapshot, and that context's next `claim renew` ended `paused`, naming
the release. The official row (P6-01w, `k20c-native2`; the same in `k20c-native1` and `k20c-final1`) frees the
ticket with `claim emergency-release` instead and shows only that the restored proof works again. How such a
context gets out of the pause was not measured; follow
"Install a new epoch after a restore" in `CLAIMS.md`.

OpenSSH 9.8 and later penalise a client address after failed logins by default (`PerSourcePenalties`; defaults
documented in sshd_config(5): 5 s per connection that failed authentication, enforced once 15 s have accrued,
accumulating up to 10 min). After broken credentials, the next claim calls from the same address can end
`unavailable` / `unreachable` — even with working credentials — until the penalty expires; the client output does not
name the cause, the server log does (`penalty: failed authentication`). All clients behind one NAT address
share the penalty. Fix the credentials and wait, or exempt known client addresses on the server
(`PerSourcePenaltyExemptList`). Observed against the raw OpenSSH 10.0p2 server of the qualification harness in a run
outside the evidence set; the counted runs of run 1 showed no penalty line, and the runs from `k20b-rep4` on set
`PerSourcePenalties no`. Not measured against Gitea.

## Unqualified modes

- Other Git hosts and versions: GitHub, GitLab, Forgejo, and Git, OpenSSH or Gitea versions other than those above.
- macOS, Windows and NFS.
- `git://` for production use.
- `clock_uncertainty_ms` above 2000.
- A Git credential helper for HTTP authentication.

## Not measured

- Isolation of the write paths by any host, and pushes that passed a new gate being stopped or awaited.
- Replicas and mirrors.
- Clients of an older Backlog.md.
- A restore without the new-epoch procedure, beyond one check that the restored proof works again. That a context
  whose own operation the restore turned back then pauses follows from the pause rule; it was seen only in a dry run
  (see "Operational observations").
- Retention of journal slots.
- Sizes beyond 1000 claims, and a second run of the 1000-claim measurement.

## Full evidence

The full reports, one per storage format with every row, run id, injection and measured value, are in
[docs/claims/qualification/](../../docs/claims/qualification/README.md) (`REPORT-<format>.md`, with a README on the
stack and the evaluation). The archives themselves, the harness and the evaluator are not part of this repository.

Every counted run was evaluated by the frozen evaluator `k20.py` (sha256 `c44b87ff…`, recorded by the driver in the
run and checked at evaluation) with this revision as its base parameter; it reported the archived product
byte-equal to `bce2acc` in every run and no problem. The earlier runs on `cb45f9f` were read by the previous
evaluator (`2a243518…`), whose built-in comparison named `fd23b8d`, together with a separate product pin against
`cb45f9f`.
