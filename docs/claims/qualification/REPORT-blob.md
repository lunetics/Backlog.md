# Qualification report — storage format `blob`

Reference report of the qualification matrix (`K20` in the archives) of Backlog.md native claims over real
transport, for the storage format
`blob`. The sibling reports `REPORT-blob.md`, `REPORT-tree.md` and `REPORT-commit-chain.md` share this structure;
every row that ran for this format appears here with this format's combinations. The harness is described in
`README.md` in the same directory as the reports. The contract the rows were frozen against and the run ledger are
not part of this repository. The user-facing summary is
`src/claims/QUALIFICATION.md` in Backlog.md. The identifiers in this report (`K20`, the stage names, `K20-ROW`
and its siblings, run names, row IDs) are explained in
[README.md](README.md#identifiers-you-will-meet-in-the-reports-and-archives).

## 1. Header

- **Format:** `blob`.
- **Product under test:** Backlog.md native `fd23b8d` (`K20-RUN.source.rev`
  `fd23b8de496f692099425fa65a4a3c919942aebd`), `backlog --version` 1.52.0. Every archive's `source.tar.gz` carries
  612 product files under `src/`, byte-identical to `fd23b8d` (k20.py "product vs fd23b8d: 612 archived, 0 differ").
- **Date:** 2026-10-02. Run 1 spans 2026-09-30 16:29 to 2026-10-02 01:38 CEST (first step of `k20a-green1`, last step of `k20c-size3`); run 2 spans 2026-10-02 01:39 to 04:30 CEST (first step of `k20a-rep2`, last step of `k20c-rep1`).
- **Run 1 of 2.** The rows, numbers and evidence pointers below name run 1 of each stage. Run 2 of the final matrix
  (contract point 2, addendum 3 point 3) matched run 1 in every verdict, each with k20.py `2a243518`, product 612/0
  vs `fd23b8d`, re-read run by run: `k20a-rep2` GREEN 124/124; `k20b-rep4` GREEN 115/115
  (`k20b-rep3` excluded, harness defect H-12); `k20c-rep1` GREEN 87/87. The size stage has one
  run by decision (n = 1, empty spread list).
- **Run 3.** The same matrix ran once more on the published revision `cb45f9f` (`backlog --version` 1.53.0): `k20a-native1` 124/124, `k20b-native1` 115/115, `k20c-native1` 87/87, `k20c-size-native1` 13/13, every check with the status and completeness of run 1. `src/claims/QUALIFICATION.md` names those runs; the rows below keep their run-1 evidence pointers.

| stage | run | role | evaluator (k20.py sha256) | verdict | cases (`blob` / all) |
| --- | --- | --- | --- | --- | --- |
| A | `k20a-green1` | final GREEN | `1dbc05fa` | GREEN, 124/124 pass, 0 findings, 0 problems | 42/42 |
| A | `k20a-gsplit1` | guard `split-endpoint` | `1dbc05fa` | GUARD as expected | — |
| A | `k20a-ggate3` | guard `gate-bypass` | `1dbc05fa` | GUARD as expected | — |
| B | `k20b-green2` | final GREEN | `6db8e5e6` | GREEN, 115/115 pass, 0 findings, 0 problems | 39/39 |
| B | `k20b-injoff2` | guard `injection-off` | `6db8e5e6` | GUARD as expected | — |
| C | `k20c-final1` | final GREEN (alone on the test machine) | `2a243518` | GREEN, 87/87 pass, 0 findings, 0 problems, clock check 0/759 steps off | 31/31 |
| C | `k20c-gft1` | guard `faketime-off` (alone) | `8b6c534e` | GUARD as expected, clock check off on exactly the 27 skewed steps | — |
| C | `k20c-dry3` | acceptance run, not the final | `8b6c534e` | GREEN, 87/87 | — |
| size run | `k20c-size3` | single size measurement (n = 1, alone) | `2a243518` | GREEN, 13/13 pass, 0 findings, 0 problems, spread list empty | 5/5 |
| size run | `k20c-size1` | stopped, not evidence (harness defect H-9) | — | — | — |
| size run | `k20c-size2` | not evidence (harness defect H-10); cross-check only | `2a243518` | NOT OK, 11 of 13 cases measured, 0 findings, 4 problems (all harness) | — |
| A | `k20a-rep2` | repeat, run 2 | `2a243518` | GREEN, 124/124 pass, 0 findings, 0 problems | 42/42 |
| B | `k20b-rep3` | not evidence (harness defect H-12) | — | — | — |
| B | `k20b-rep4` | repeat, run 2 | `2a243518` | GREEN, 115/115 pass, 0 findings, 0 problems, P2-01q `queried` 6/6, P2-03 `stale` 6/6, 0 penalty lines | 39/39 |
| C | `k20c-rep1` | repeat, run 2 (alone on the test machine) | `2a243518` | GREEN, 87/87 pass, 0 findings, 0 problems, clock check 0/759 steps off | 31/31 |

The "cases" column counts the K20-ROW lines of the final GREEN run whose combination has this format, and how many
passed. P5-05 runs on `raw/https/blob` only and is counted in the blob report; it scans the outputs of every format.
`k20a-gsplit1` also lists 27 SAFETY findings (two `applied` among the racers): the mutant's two-area artifact, a on the original repository and b in the split copy, flagged as designed. All verdicts above were recomputed for this report with the named evaluator on the named archive; they match the
run ledger and the confirmations of the repeat runs.

## 2. Setup measured

**Stack** (`K20-RUN.versions`, identical in every official archive): Git 2.47.3 on the server; OpenSSH_10.0p2
Debian-7+deb13u4 (OpenSSL 3.5.7); Gitea 1.24.7 rootless (`gitea/gitea@sha256:a664a64d…`), its HTTP server and its
built-in SSH server; toxiproxy 2.11.0 (`ghcr.io/shopify/toxiproxy@sha256:cfdb2ca7…`); Bun 1.3.14 (client image FROM
`oven/bun:1.3.14@sha256:e10577f0…`, Debian 13); libfaketime 0.9.10; backlog 1.52.0. Client Git: `K20-RUN.versions.git`
carries the server's value; `git version 2.47.3` was read directly from the client image of `k20c-gft1`
(run ledger). Each run builds its own client image tag, and every build log shows the Git package layer
(`apt-get install … git …`) as CACHED on the same base digest. Linux containers on one test machine (12 vCPU, 31 GB), one
compose project per run, internal network, no host ports, uid 1000, read-only root filesystem, `cpus` 1,
`mem_limit` 1 GiB, `pids_limit` 256 per container. The server's `/tmp`, which holds the bare repositories and their
snapshots, is a 256 MiB tmpfs in every official run except the size stage: `k20c-size3` ran on the H-10 compose
with that tmpfs at 2 GiB and the server's `mem_limit` at 3 GiB (`compose-effective.yaml` of each archive).
`k20c-size3` and every repeat run take the product from a clean detached worktree at `fd23b8d` instead of the
native checkout (H-11); the archived product is byte-identical either way (k20.py: 612 archived, 0 differ).
The raw server's sshd runs with OpenSSH's default `PerSourcePenalties` in every official run of run 1 (0 penalty lines
in the sshd.log of all eight official archives); runs started after the fix, from `k20b-rep4` on, start it with
`-o PerSourcePenalties=no` (H-12).

**Servers × transports for `blob`.** The same bare repositories are served by the raw server over `git://`
(git daemon, control transport only), `http://` and `https://` (git http-backend behind the harness CGI bridge, private
CA via `GIT_SSL_CAINFO`) and `ssh://` (OpenSSH, key auth via `GIT_SSH_COMMAND`, pinned `known_hosts`). Gitea serves
`http://` (authentication through `GIT_ASKPASS` reading the API token; credentials in the URL are refused by the
product under its rule that endpoint URLs carry no credentials) and `ssh://` (the client key registered for the Gitea user).

| set | combinations for `blob` | hop | rows |
| --- | --- | --- | --- |
| SMOKE | raw/git, raw/http, raw/https, raw/ssh, gitea/http, gitea/ssh | direct (no proxy) | S-01 |
| GATED | raw/https, raw/ssh | toxiproxy, latency 0 unless a row shapes it | P1, P2, P4, P5, P7 |
| PRODUCT | gitea/ssh | toxiproxy | P1-01g, P6-04 (and P6-12 on blob) |
| TIME / OPS | raw/ssh | toxiproxy | P3, P6-01…P6-04 |
| SIZES | raw/https (the transport with a wire measure at the front) | toxiproxy, shaped per row | P6-10 (gate matrix), P6-10-N1000 / P6-11 (size stage) |

The SMOKE legs ran direct: in `k20a-green1` the Gitea HTTP proxy accepted no client at all, and the Gitea SSH proxy's
first client came after the last S-01 Gitea case (containers.log, 14:46:29 UTC versus S-01 Gitea cases 14:37–14:40
UTC). The runtime routes every non-SMOKE combination through the proxy (`driver/k20.ts` `isProxiedSpec`).

**Client conditions.** Three executor containers (`client-a`, `-b`, `-c`) spawn the shipped `backlog` CLI, and for the
MCP rows `backlog mcp start` over stdio with `@modelcontextprotocol/sdk` 1.29.0; a driver container without faketime
orders the steps (true clock of the run). Clock skew is libfaketime per spawn in the acting client only; the measured
offset (`clockOffsetMs`) of every step matched the requested skew within 250 ms (`k20c-final1`: 0/759 steps off).
U = `clock_uncertainty_ms` 2000 ms in every P3 row; skews: reclaimer clock ahead S ∈ {0, +1000, +2000, +8000} ms,
holder clock behind S ∈ {0, −2000, −8000} ms (P3-02) and {−2000, −8000} ms (P3-03). Configurations per row are named
in section 3; the size rows run with the defaults `attempt_timeout_ms` 10000 and `operation_budget_ms` 30000.

**Injected failures.** Pre-receive gates and post gates (reference-transaction hook in state `committed`) on a ref, with
"hold the first k, pass the later ones" (raw server only); proxy `refuse` (proxy disabled) and `stall` (timeout toxic
0); latency (toxiproxy `latency`, both directions, 0/200/1000 ms) and bandwidth (`bandwidth` 128 KB/s, size stage);
host policy `reject` (pre-receive refuses every push); broken credentials (`ca-missing`: `GIT_SSL_CAINFO` at a missing
path; `ssh-key-open-perms`: a key copy with mode 0644); server-side snapshot and restore of the bare repository;
descriptor and ticket rewrite to a future schema (`/rewrite`, canonical JSON checked); server maintenance (raw
`git gc --prune=now`, Gitea admin cron `git_gc_repos`). Every injection is recorded with its instant in `K20-ROW`
`injection`.

## 3. Rows by test package

Each entry names the row, its title and requirement ids as frozen in the scenario file, the combinations it ran on for
`blob`, the clock and configuration, the injection, what the row asserted and saw, the row notes (measured values),
the guard prediction met for this format, and where the evidence is. "Observed" restates the row's assertions; a
row passes only when all of them held.

### Matrix smoke (S-01, stage A)

**S-01** — two clients share one coordination area over this server, transport and format. Refs: CLAIM-ACCEPTANCE-001, M-05.

- Combos (raw git/http/https/ssh and Gitea http/ssh, all DIRECT (no proxy hop)): `raw/git/blob`, `raw/http/blob`, `raw/https/blob`, `raw/ssh/blob`, `gitea/http/blob`, `gitea/ssh/blob`; `k20a-green1` 6/6 pass.
- Clock: true clock (no faketime). Injection: none.
- Observed (as asserted): `claim init` of client a `ok` `created` with this format; client b's `claim init` `ok` `exists`; a's acquire `applied`, `sends` 1, ownership `held`, exactly one `push` in its Git census; b's `claim list --ticket` `ok`, `complete` true, entry `active` owned by `agent-a`; b's acquire `rejected`, plan cause `not-free`, `operationId` null, `sends` 0, ownership `foreign`, exit 2; a's renew `applied` `sends` 1; a's release `applied` `sends` 1; b's acquire `applied`, `held`; observer without context: `complete`, `active`, owner `agent-b`; server-side refs exactly `refs/claim-meta/format` and the ticket ref.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 6/6, 6 at `"exists"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 6/6.
- Evidence: `k20a-green1`, `S-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/S-01/`.

### P1 Acquire and transfer (stage A)

**P1-01** — two clients race acquire on one ticket: exactly one applied. Refs: M-01, R-01, Q-01.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate on the ticket ref, hold 2.
- Observed (as asserted): Both racers entered the gate with the same `old` and pairwise distinct `new` before the release; exactly one `applied`; the loser `rejected` at stage `storage`, cause `stale`, `sends` 1; observer `active`, owner = winner, `claimGeneration` 1. k20.py recomputes "exactly one applied among the racers" from the documents.
- Row notes: raw/https/blob: `entrants` 2, `winner` "agent-b"; raw/ssh/blob: `entrants` 2, `winner` "agent-a".
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `Expected: 2` + `Received: 1`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P1-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-01/`.

**P1-01c** — sequential acquire: the second client is refused before sending. Refs: M-01.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: none (positive control of P1-01).
- Observed (as asserted): a `applied` `sends` 1; b `rejected`, plan `not-free`, `operationId` null, `sends` 0, no push; observer `active` `agent-a`.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"cause": "not-free"` + `"outcome": "applied"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P1-01c [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-01c/`.

**P1-01g** — Gitea: two clients start acquire together, repeated: never two applied. Refs: M-01.

- Combos (Gitea/ssh (proxied, latency 0), 3 repetitions): `gitea/ssh/blob` #1, `gitea/ssh/blob` #2, `gitea/ssh/blob` #3; `k20a-green1` 3/3 pass.
- Clock: true clock (no faketime). Injection: none (Gitea has no gates; racers started together).
- Observed (as asserted): Exactly one `applied` per repetition; the loser's cause is `stale` or `not-free`; observer owner = winner. `overlap` true means the loser lost at the storage (the race overlapped).
- Row notes: gitea/ssh/blob #1: `overlap` true; gitea/ssh/blob #2: `overlap` false; gitea/ssh/blob #3: `overlap` true.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 3/3, 3 at `Expected length: 1` + `Received length: 2`; `k20a-ggate3` (gate-bypass): not predicted, measured green 3/3.
- Evidence: `k20a-green1`, `P1-01g [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-01g/`.

**P1-02** — CLI and MCP race acquire over the same endpoint: exactly one applied, same document shapes. Refs: M-02, Q-02.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate, hold 2; client b acquires through `backlog mcp start` over stdio.
- Observed (as asserted): Exactly one `applied`; the loser is a `claim-operation` `rejected` at `storage` `stale`, `command` `acquire`, the same document shape over CLI and MCP; the MCP step has `exit` null; observer owner = winner.
- Row notes: raw/https/blob: `entrants` 2, `winner` "agent-a", `winnerSurface` "cli"; raw/ssh/blob: `entrants` 2, `winner` "agent-b", `winnerSurface` "mcp".
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `Expected: 2` + `Received: 1`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P1-02 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-02/`.

**P1-03** — a claim is not branch-local: another worktree and another clone meet the same claim. Refs: M-03, R-04, Q-02.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: client a works in a `git worktree` on branch `feature`.
- Observed (as asserted): a1 `applied`; a1 again from the worktree `rejected` plan `held` `sends` 0; a2 from the worktree `not-free`; b `not-free`; `claim list` from the worktree `ok` `complete`; observer `active` `agent-a`, generation 1.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"cause": "not-free"` + `"outcome": "applied"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P1-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-03/`.

**P1-04** — lease transfer: one write, receiver holds with a fresh window, the old window no longer bounds it. Refs: M-11, CLAIM-TRANSFER-LEASE-001.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U 2000. Injection: sender and receiver contexts in one client container.
- Observed (as asserted): `claim transfer --ttl-ms 30000` 8 s after the acquire: `applied`, `sends` 1, sender view `foreign`; the receiver's lease end ≥ transfer start + 30000 − U and later than the old one; receiver list `held`, `workRight` `live`; b's reclaim after the OLD boundary + U + 1000 ms `rejected` plan `not-yet`; observer `agent-a2`.
- Row notes: raw/https/blob: `oldBoundary` 1790780291997, `newBoundary` 1790780313319; raw/ssh/blob: `oldBoundary` 1790780461583, `newBoundary` 1790780482224.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"cause": "not-yet"` + `"cause": "absent"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P1-04 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-04/`.

**P1-05** — late ACK at plan time: the old holder lost the claim, its transfer is refused. Refs: M-12, PATTERN-ACK.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000. Injection: none.
- Observed (as asserted): After a's reclaim boundary + U + 500 ms c reclaims (`applied`) and acquires (`applied`); a's late transfer `rejected` plan `not-holder` `sends` 0; observer `agent-c`.
- Guards: `k20a-gsplit1` (split-endpoint): not predicted, measured green 2/2; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P1-05 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-05/`.

**P1-05s** — late ACK at storage time: an emergency release lands while the transfer waits; the transfer never lands. Refs: M-12, M-22.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; lease config of P1-04. Injection: pre-receive gate holds a's transfer (hold 1); operator context listed in `claims.recovery_authorities`.
- Observed (as asserted): While the transfer waits in the gate, the operator's `emergency-release --expect-root` lands `applied` `sends` 1; released, the transfer ends `rejected` at `storage` `stale`; observer `free`.
- Guards: `k20a-gsplit1` (split-endpoint): not predicted, measured green 2/2; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P1-05s [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-05s/`.

**P1-06** — release then three clients race: exactly one applied, no guaranteed successor. Refs: M-13, PATTERN-RELEASE-POOL.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate, hold 3, after a release.
- Observed (as asserted): Three racers entered with the same `old` and three distinct `new`; exactly one `applied`, both others `storage` `stale`; observer owner = winner, generation 2.
- Row notes: raw/https/blob: `entrants` 3, `winner` "agent-a"; raw/ssh/blob: `entrants` 3, `winner` "agent-b".
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `Expected: 3` + `Received: 2`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P1-06 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-06/`.

**P1-07** — coordinator hold, transfer to the worker, release ends the protection. Refs: M-14, PREASSIGN-HOLD-TRANSFER.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; lease config of P1-04. Injection: coordinator and worker contexts in client c.
- Observed (as asserted): Coordinator acquire `applied`; a `not-free`; transfer coordinator → worker `applied` `sends` 1; a still `not-free`; worker release `applied`; a's acquire `applied`; observer `agent-a`.
- Guards: `k20a-gsplit1` (split-endpoint): not predicted, measured green 2/2; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P1-07 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-07/`.

**P1-08** — an old acquire planned on the first free state fails after held and free again. Refs: Q-06, R-08, R-10.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate holds a's acquire (hold 1).
- Observed (as asserted): While a's acquire planned on the first free state waits, b acquires and releases twice; the ticket ref differs from the held `old`; released, a's acquire ends `rejected` `storage` `stale`; observer `free`, generation 2.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"cause": "stale"` + `"outcome": "applied"`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P1-08 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P1-08/`.

### P2 Failure and resumption (stage B)

**P2-01** — lost reply after the effect with the query cut: unknown, pause, resolve stored, retry without a send. Refs: M-21, Q-03, R-10, R-11.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: post gate (reference-transaction `committed`) hold 1; proxy `refuse`, then `up`.
- Observed (as asserted): Acquire `unknown`, `sends` 1, exit 3; the server ref holds the change; a second acquire from the same context sends no push (`secondAcquire` below: `rejected` plan `held`); `resolve` `applied`, no push; `retry` `applied`, `command` `retry`, `action` `acquire`, `sends` 0, same operation ID; ref unchanged; observer `agent-a`, generation 1.
- Row notes: raw/https/blob: `secondAcquire` "rejected"; raw/ssh/blob: `secondAcquire` "rejected".
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20b-green2`, `P2-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-01/`.

**P2-01q** — lost reply after the effect, query reachable: the call proves the effect itself and reports applied. Refs: M-21, Q-03.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: post gate hold 1, held until entry + 4000 ms, then released (proxy up).
- Observed (as asserted): Acquire `applied`, `sends` 1, `storage.kind` `queried` (the call's own query proved the stored change), ownership `held`. Pair: `k20b-green1` read the gate instant in seconds as ms and passed with `applied` unmeasured; only this run is evidence.
- Row notes: raw/https/blob: `storage` {"kind": "queried", "after": "unknown", "query": {"kind": "resolved", "resolution": "stored"}}; raw/ssh/blob: `storage` {"kind": "queried", "after": "unknown", "query": {"kind": "resolved", "resolution": "stored"}}.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20b-green2`, `P2-01q [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-01q/`.

**P2-02r** — endpoint refuses connections: unavailable within the attempt bound, nothing written. Refs: M-05, M-38, Q-18, R-03.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: proxy `refuse` before the acquire.
- Observed (as asserted): Acquire `claim-error` `unavailable` `unreachable`, exit 6, `elapsedMs` below 2 × 3000 + 2000; `claim list` during the cut `unavailable` `unreachable`; server refs unchanged; after `up` the acquire is `applied`.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `unreachable`.
- Evidence: `k20b-green2`, `P2-02r [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-02r/`.

**P2-02s** — endpoint stalls every connection: unavailable within the attempt bound, nothing written. Refs: M-05, M-38, Q-18, R-03.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: proxy `stall` (timeout toxic 0) before the acquire.
- Observed (as asserted): As P2-02r: `unavailable` `unreachable`, exit 6, within the bound, nothing written, `applied` after `up`.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `unreachable`.
- Evidence: `k20b-green2`, `P2-02s [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-02s/`.

**P2-02u** — cut while the push waits before the effect: unknown is not free; the server may still apply it later. Refs: M-21, M-47, Q-25.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: pre-receive gate hold 1; proxy `refuse` while held; release after `up`.
- Observed (as asserted): Acquire `unknown`, `sends` 1; after the release the ref landed within the 3 s poll (`lateLanding`); `resolve` `applied`; b's acquire `rejected` `not-free`; observer `agent-a`.
- Row notes: raw/https/blob: `lateLanding` true; raw/ssh/blob: `lateLanding` true.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P2-02u [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-02u/`.

**P2-03** — two replacements from the same proof race resume: exactly one holds, the other gets no right. Refs: M-18, Q-07, R-09.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate hold 2; two replacement contexts (`--recover-from`) in client a.
- Observed (as asserted): Both resumes entered with the same `old`, distinct `new`; exactly one `applied`; the loser `rejected` at `storage` (`loserCause` below); the loser's second resume `rejected` plan `not-holder` `sends` 0; winner renew `applied`; the old context's renew `not-holder`; observer `agent-a`.
- Row notes: raw/https/blob: `loserCause` "stale"; raw/ssh/blob: `loserCause` "stale".
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P2-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-03/`.

**P2-04** — resume winner loses its reply: the second instance is refused, the winner's retry changes nothing. Refs: M-19, Q-07.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: post gate hold 1; proxy `refuse`, then `up`.
- Observed (as asserted): r1's resume `unknown`; r2's resume `rejected` plan `not-holder` `sends` 0; r1's `retry` `applied`, `action` `resume`, `sends` 0; r2's list shows no `held`.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20b-green2`, `P2-04 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-04/`.

**P2-05** — lost proof under lifetime_mode none: never reclaimable, emergency release at the exact root, new acquire. Refs: M-22, CLAIM-RECOVERY-001.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lifetime_mode: none`. Injection: operator context listed in `claims.recovery_authorities`.
- Observed (as asserted): b's reclaim `rejected` plan `never` `sends` 0; preview `active` `agent-a`, root = server ref; `emergency-release --expect-root` `applied` `sends` 1; again `rejected` plan `stale-root` `sends` 0; b's acquire `applied`; the old holder's release `not-holder`; observer `agent-b`, generation 2.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P2-05 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P2-05/`.

### P3 Time rules (stage C)

**P3-01-A0** — reclaim 5 s before the true boundary, reclaimer clock 0 ms ahead: not yet. Refs: Q-12, O-02, CLAIM-TIME-001, M-15.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: reclaimer clock +0 ms; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000. Injection: none.
- Observed (as asserted): b's reclaim spawned 5 s before the true reclaim boundary R: `rejected` plan `not-yet`, `boundary` = R; `sends` 0 and no push (measured, not pinned by the row).
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-01-A0 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-01-A0/`.

**P3-01-A1000** — reclaim 5 s before the true boundary, reclaimer clock 1000 ms ahead: not yet. Refs: Q-12, O-02, CLAIM-TIME-001, M-15.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: reclaimer clock +1000 ms; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; measured skew steps at +1000 ms. Injection: none.
- Observed (as asserted): b's reclaim spawned 5 s before the true reclaim boundary R: `rejected` plan `not-yet`, `boundary` = R; `sends` 0 and no push (measured, not pinned by the row).
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-01-A1000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-01-A1000/`.

**P3-01-A2000** — reclaim 5 s before the true boundary, reclaimer clock 2000 ms ahead: not yet. Refs: Q-12, O-02, CLAIM-TIME-001, M-15.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: reclaimer clock +2000 ms; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; measured skew steps at +2000 ms. Injection: none.
- Observed (as asserted): b's reclaim spawned 5 s before the true reclaim boundary R: `rejected` plan `not-yet`, `boundary` = R; `sends` 0 and no push (measured, not pinned by the row).
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-01-A2000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-01-A2000/`.

**P3-01-A8000** — reclaim 5 s before the true boundary, reclaimer clock 8000 ms ahead: early takeover by S − U (a documented consequence of the clock bound, not a defect). Refs: Q-12, O-02, CLAIM-TIME-001, M-15.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: reclaimer clock +8000 ms (4U); `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; measured skew steps at +8000 ms. Injection: none.
- Observed (as asserted): documented consequence (a): b's reclaim spawned 5 s before R: `applied`, `sends` 1, and the call ENDED before R (early by up to S − U).
- Guards: `k20c-gft1` (faketime-off): predicted red, measured red 1/1, 1 at `"applied"`.
- Evidence: `k20c-final1`, `P3-01-A8000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-01-A8000/`.

**P3-01c** — reclaim after the boundary plus U with a true clock: applied. Refs: Q-12, M-15.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000. Injection: none (control).
- Observed (as asserted): Reclaim at R + U + 500 ms: `applied`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-01c [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-01c/`.

**P3-02-L0** — 0.5 s after the true hard end, holder clock 0 ms behind: no live work right. Refs: Q-12, O-02, M-16, CLAIM-TIME-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: holder clock −0 ms; `lease_ttl_ms` 60000, hard end H = now + 25 s. Injection: none.
- Observed (as asserted): Acquire `planned.capped` true, `leaseEnd` = `hardEnd` = H; the holder's `claim list --context` 0.5 s after H: no `live` work right. Observer `active` `agent-a`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-02-L0 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-02-L0/`.

**P3-02-L2000** — 0.5 s after the true hard end, holder clock 2000 ms behind: no live work right. Refs: Q-12, O-02, M-16, CLAIM-TIME-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: holder clock −2000 ms; `lease_ttl_ms` 60000, hard end H = now + 25 s; measured skew steps at -2000 ms. Injection: none.
- Observed (as asserted): Acquire `planned.capped` true, `leaseEnd` = `hardEnd` = H; the holder's `claim list --context` 0.5 s after H: no `live` work right. Observer `active` `agent-a`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-02-L2000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-02-L2000/`.

**P3-02-L8000** — 0.5 s after the true hard end, holder clock 8000 ms behind: false live work right (a documented consequence, not a defect). Refs: Q-12, O-02, M-16, CLAIM-TIME-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: holder clock −8000 ms; `lease_ttl_ms` 60000, hard end H = now + 25 s; measured skew steps at -8000 ms. Injection: none.
- Observed (as asserted): Acquire `planned.capped` true, `leaseEnd` = `hardEnd` = H; the holder's `claim list --context` 0.5 s after H: `workRight` `live` (documented consequence (b): false live right). Observer `active` `agent-a`.
- Guards: `k20c-gft1` (faketime-off): predicted red, measured red 1/1, 1 at `"live"`.
- Evidence: `k20c-final1`, `P3-02-L8000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-02-L8000/`.

**P3-03-L2000** — change-bounds to a later hard end 0.2 s after the true hard end, clock 2000 ms behind: hard-expired, nothing sent. Refs: O-02, M-36, Q-24, CLAIM-TIME-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: holder clock −2000 ms; `lifetime_mode: hard`, grace 5000, U 2000; measured skew steps at -2000 ms. Injection: none.
- Observed (as asserted): `change-bounds` to H + 10 s, 0.2 s after H: `rejected` plan `hard-expired`, `boundary` H, `sends` 0.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-03-L2000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-03-L2000/`.

**P3-03-L8000** — change-bounds to a later hard end 0.2 s after the true hard end, clock 8000 ms behind: false witness, confirmed (a documented consequence, not a defect). Refs: O-02, M-36, Q-24, CLAIM-TIME-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: holder clock −8000 ms; `lifetime_mode: hard`, grace 5000, U 2000; measured skew steps at -8000 ms. Injection: none.
- Observed (as asserted): documented consequence (c): `change-bounds` to H + 10 s started after H: `applied`, `transition.phase` `confirmed` (a false witness); a true-clock reclaim by b after the OLD boundary (H + 5000 + U + 500) is `rejected` `not-yet`: the later hard end holds.
- Guards: `k20c-gft1` (faketime-off): predicted red, measured red 1/1, 1 at `"confirmed"`.
- Evidence: `k20c-final1`, `P3-03-L8000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-03-L8000/`.

**P3-03c** — change-bounds to a later hard end well before H with a true clock: witnessed and confirmed. Refs: O-02, M-36.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; hard mode. Injection: none (control).
- Observed (as asserted): `change-bounds` to a later hard end at H − U − 5 s: `applied`, `transition.phase` `confirmed`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-03c [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-03c/`.

**P3-04** — renew sent before the hard end, held until after it: historical applied, capped at H, no live right after H. Refs: M-36, M-47, Q-09, Q-10, ACCEPT-DELAYED-DEADLINE.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; hard end H = now + 15 s. Injection: pre-receive gate holds the renew from H − U − 3.5 s until H + 1 s.
- Observed (as asserted): Renew `applied`, `planned.capped` true, `leaseEnd` = H; the holder's list after H: no `live` right; `resolve` `applied`; b's reclaim at H + grace + U + 500 ms `applied`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-04 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-04/`.

**P3-05** — time-path P held past the hard end: no witness, unknown; others pending-transition until the hull, then reclaim. Refs: Q-24, M-47, O-02.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; hard mode, grace 5000; H = now + 15 s. Injection: pre-receive gate holds the time-path P from before H − U until H + 500 ms.
- Observed (as asserted): `change-bounds` `unknown`, exit 3, `transition.phase` `pending`, `confirmOperationId` null; b's acquire (with `--hard-end`) `rejected` plan `pending-transition`, `boundary` = the hull; after hull + U + 500 ms b's reclaim `applied`; `resolve` of P `unknown-history`, exit 4.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-05 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-05/`.

**P3-06** — grace changed in the configuration during a claim: the stored grace still bounds the reclaim. Refs: M-29, Q-05.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; then config changed to ttl 60000, grace 1000. Injection: none.
- Observed (as asserted): b's reclaim at L + 1000 + U + 500 ms `rejected` `not-yet`, `boundary` = L + 5000 (the stored grace).
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-06 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-06/`.

**P3-07** — renew beyond the hard end with an explicit TTL: overlong at H, timing unchanged. Refs: M-30, Q-13.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 20000, `reclaim_grace_ms` 5000, U = `clock_uncertainty_ms` 2000; hard end now + 30 s. Injection: none.
- Observed (as asserted): `renew --ttl-ms 60000` `rejected` plan `overlong`, `boundary` H, `sends` 0; listed timing equals the acquire's.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-07 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-07/`.

**P3-08** — transfer under a hard end: time-box-required by default, preserve caps the default TTL at H, explicit TTL overlong, restart without hard end refused. Refs: M-37, M-45, M-46, Q-13, CLAIM-TRANSFER-POLICY-001, CLAIM-LEASE-BOUNDARY-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 300000; hard end now + 60 s. Injection: `transfer_time_box` switched restart → preserve in the config.
- Observed (as asserted): Transfer without time-box `rejected` `time-box-required`, `operationId` null, `sends` 0; restart without `--hard-end` `requires-time-path` `sends` 0; preserve with `--ttl-ms 300000` `overlong`, `boundary` H; preserve with the default TTL `applied`, `planned.capped` true, `leaseEnd` = H.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P3-08 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P3-08/`.

### P4 Reclaim (stage B)

**P4-01** — batch: one reclaim ends unknown, the others go on; unknown stays with its ticket. Refs: M-24, Q-19, RECOVERY-UNKNOWN-CONTINUE.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000; client c `attempts` 1 / 3000 ms. Injection: pre-receive gate holds T2's reclaim (hold 1).
- Observed (as asserted): `reclaim-batch --ticket T1,T2,T3`: `unknown`, `complete` true, `stoppedAt` null, exit 3, entries in order, results T1 `applied`, T2 `unknown`, T3 `applied`; after the release T2's `resolve` agrees with the server ref (`lateLanding` below); T1 and T3 `free`.
- Row notes: raw/https/blob: `lateLanding` true; raw/ssh/blob: `lateLanding` true.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P4-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-01/`.

**P4-02** — remote refusal in a batch: entries rejected at the storage, nothing written; next batch pauses until retry. Refs: M-25, Q-20, RECOVERY-SHARED-AUTH-DENIED.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000. Injection: host policy `reject` (pre-receive refuses every push), then `accept`.
- Observed (as asserted): `reclaim-batch --claim-owner agent-a`: `rejected`, `stoppedAt` null, exit 2, three entries each `rejected` at `storage` `remote`; server refs unchanged; after `accept` the next batch is `paused`, exit 7, no push, each entry a `claim-pause` `outstanding` naming its open operation; `claim retry` of each: `applied`, `action` `reclaim`, `sends` 1; every ticket `free`.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `"rejected"`.
- Evidence: `k20b-green2`, `P4-02 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-02/`.

**P4-02k** — credentials broken for every read: the call fails as a whole before any reclaim, nothing sent. Refs: M-25, Q-18, Q-20.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000. Injection: broken credentials: https `ca-missing`, ssh `ssh-key-open-perms`.
- Observed (as asserted): `reclaim-batch` `claim-error` `unavailable` `unreachable`, exit 6, no push; all tickets stay `active` `agent-a`.
- Row notes: raw/https/blob: `kind` "claim-error"; raw/ssh/blob: `kind` "claim-error".
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `unavailable`.
- Evidence: `k20b-green2`, `P4-02k [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-02k/`.

**P4-03** — a claim that becomes reclaimable during the batch waits for the next call. Refs: M-26, RECOVERY-FINITE-RUN.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000; client c `attempt_timeout_ms` 20000. Injection: pre-receive gate holds T1's reclaim.
- Observed (as asserted): A fourth claim becomes reclaimable while the batch waits; the batch is `ok` with T1–T3 `applied` and no entry for T4; T4 stays `active`; a later preview shows T4 `eligible`.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P4-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-03/`.

**P4-04a** — preview shows eligible, the holder renews, the batch leaves the claim alone. Refs: M-27, RECLAIM-PREVIEW-RACE.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000. Injection: none.
- Observed (as asserted): Preview `eligible`, no push; the holder renews (`applied`); `reclaim-batch --ticket T` `ok` with no entry; observer `active` `agent-a`.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P4-04a [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-04a/`.

**P4-04b** — renew between the batch's selection and its reclaim: that entry is rejected not-yet, the batch goes on. Refs: M-23, M-27, Q-11.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000; client c `attempt_timeout_ms` 20000. Injection: pre-receive gate holds T1's reclaim.
- Observed (as asserted): T2 renewed while the batch waits: batch `rejected`, `stoppedAt` null, T1 `applied`, T2 `rejected` plan `not-yet`; T2 stays `active`.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P4-04b [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-04b/`.

**P4-05** — empty or blank scope is refused before any Git process; --all stands alone. Refs: M-28, Q-20.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock (no faketime). Injection: none.
- Observed (as asserted): No scope, `--ticket ""`, `--labels ,` × `reclaim-batch`/`reclaim-preview`: `refused` `scope-required`, exit 5, zero network Git commands; `--all` with `--ticket` `refused` `invalid-option`; `--all` alone `ok` with no entry.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P4-05 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P4-05/`.

### P5 Integration (stage B; P5-05 in every stage)

**P5-01** — CLI and MCP print the same document for the same state over the real endpoint. Refs: M-02, R-26, Q-02.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock (no faketime). Injection: client b uses CLI and `backlog mcp start` over stdio.
- Observed (as asserted): For `list`, `acquire` and `resolve` of an unknown ID, the MCP document equals the CLI document except `observedAt`; acquire `rejected` `not-free`; resolve `refused` `operation-not-found`.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P5-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P5-01/`.

**P5-02** — broken credentials: unavailable, and the path git names stays out of every product output. Refs: Q-23, R-26, R-34.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock (no faketime). Injection: broken credentials: https `ca-missing`, ssh `ssh-key-open-perms`.
- Observed (as asserted): `list --json`, `acquire --json`: `unavailable` `unreachable`, exit 6; `list --plain`: exit 6. The secret paths git prints are leak needles of P5-05.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `unavailable`.
- Evidence: `k20b-green2`, `P5-02 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P5-02/`.

**P5-03** — unreadable remote: list, preview and next report unavailable or unknown, never an empty complete list. Refs: M-38, Q-18, M-05.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock; `attempts` 1, `attempt_timeout_ms` 3000. Injection: proxy `refuse`, then `up`.
- Observed (as asserted): `list`, `list --ticket`, MCP `claim_list`, `reclaim-preview --all`, `next`: every one `claim-error` `unavailable` `unreachable` (none `ok`, none an empty complete list); MCP list document equals the CLI one.
- Guards: `k20b-injoff2` (injection-off): predicted red, measured red 2/2, 2 at `Expected to contain: "ok"`.
- Evidence: `k20b-green2`, `P5-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P5-03/`.

**P5-04** — assignee, status, title and archive never move a claim; release needs no local task file. Refs: M-06, M-07, M-08, Q-21, R-13, R-14.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20b-green2` 2/2 pass.
- Clock: true clock (no faketime). Injection: none.
- Observed (as asserted): `task edit -a -s`, `task edit -t`, `task archive`: each exit 0, no push, the claim ref unchanged, observer `active` `agent-a`; release after the archive `applied` `sends` 1.
- Guards: `k20b-injoff2` (injection-off): not predicted, measured green 2/2.
- Evidence: `k20b-green2`, `P5-04 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P5-04/`.

### P6 Operations (stage C; the size run)

**P6-01** — restore of an older backup + install-epoch: every ticket free in the new epoch, old proofs and histories void. Refs: M-33, Q-16, Q-26, CLAIM-RESTORE-001, O-04, O-05.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock (no faketime). Injection: server-side snapshot, later restore (whole bare repository); operator context.
- Observed (as asserted): After the restore and with the workers idle: `claim init` `exists` epoch 1; `install-epoch 1 → 2 --isolation-confirmed` `applied`, `breached` and `unsettled` empty; both tickets `free` in epoch 2; old proofs of a and b renew `rejected` `sends` 0; `resolve` of the pre-restore operations `unknown-history`; b's new acquire `applied`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-01/`.

**P6-01w** — restore WITHOUT the procedure: the restored proof works again — the product cannot see a restore. Refs: M-33, Q-16, CLAIM-RESTORE-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock (no faketime). Injection: snapshot, emergency release, b acquires, restore WITHOUT install-epoch.
- Observed (as asserted): b's renew `rejected` `not-holder`; a's restored proof renews `applied` (`restoredProofRenews`); observer `active` `agent-a`, generation 1: the product cannot see a restore.
- Row notes: raw/ssh/blob: `restoredProofRenews` "applied".
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-01w [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-01w/`.

**P6-02** — descriptor of a future schema written server-side: every command of every client refuses, nothing reads free. Refs: M-34, Q-18, CLAIM-COMPAT-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock (no faketime). Injection: descriptor rewritten server-side to `schema` 2, later back to 1.
- Observed (as asserted): Acquire, list (with and without context), MCP list, preview, renew from two clients: every one `claim-error` `refused` `schema-unsupported`, no push; refs unchanged; MCP list = CLI list; after the reverse patch the claim reads `active` `agent-a`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-02 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-02/`.

**P6-02s** — one ticket state of a future version: list incomplete, preview names it, acquire and batch refuse it, never free. Refs: M-34, Q-18.

- Combos (raw/ssh/blob only): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock (no faketime). Injection: ticket blob rewritten to `payload.claimState` 2.
- Observed (as asserted): List `unknown`, `complete` false; preview `ok` with verdict `state-unsupported`; acquire `claim-error` `state-unsupported`; batch entry `state-unsupported`; the observer reads `unknown`, never `free`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-02s [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-02s/`.

**P6-03** — enabled: false with live claims: no new claim; renew, release, reclaim after the boundary and plain transfer still work. Refs: M-35, Q-28, CLAIM-DISABLE-001.

- Combos (raw/ssh (proxied, latency 0)): `raw/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, `reclaim_grace_ms` 2000, U 2000. Injection: `enabled: false` written on every client during live claims.
- Observed (as asserted): New acquire `refused` `claims-disabled`; renew `applied`; release `applied`; plain transfer `applied`; a later hard end by `change-bounds` `rejected` `requires-time-path`; list `ok` `complete`; reclaim after the boundary `applied`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-03/`.

**P6-04** — server maintenance (gc) keeps every claim and descriptor ref; claims read and work afterwards. Refs: M-05, Q-18, O-06.

- Combos (raw/ssh (proxied) and Gitea/ssh (proxied)): `raw/ssh/blob`, `gitea/ssh/blob`; `k20c-final1` 2/2 pass.
- Clock: true clock (no faketime). Injection: server maintenance: raw `git gc --prune=now`; Gitea admin cron `git_gc_repos` (synchronous).
- Observed (as asserted): Refs before contain the descriptor and both ticket refs; refs after maintenance equal; observer `active` `agent-a`; b's acquire of the released ticket `applied`.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 2/2.
- Evidence: `k20c-final1`, `P6-04 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-04/`.

**P6-10-N1-L0** — 1 claimed refs at 0 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: no shaping.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "applied", "stop": "claimed", "attempts": 2}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N1-L0 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1-L0/`.

**P6-10-N1-L200** — 1 claimed refs at 200 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 200 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "applied", "stop": "claimed", "attempts": 2}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N1-L200 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1-L200/`.

**P6-10-N1-L1000** — 1 claimed refs at 1000 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 1000 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "applied", "stop": "claimed", "attempts": 2}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N1-L1000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1-L1000/`.

**P6-10-N100-L0** — 100 claimed refs at 0 ms latency: list, list --context, preview, next, batch of 10 and 100. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: no shaping.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N100-L0 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N100-L0/`.

**P6-10-N100-L200** — 100 claimed refs at 200 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 200 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N100-L200 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N100-L200/`.

**P6-10-N100-L1000** — 100 claimed refs at 1000 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-final1` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 1000 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-10-N100-L1000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N100-L1000/`.

**P6-12-N100** — Gitea: 100 claimed refs, list, preview and a batch of 10 (no snapshot on Gitea: seeded in the case). Refs: O-06, M-38.

- Combos (Gitea/ssh/blob only (proxied, latency 0)): `gitea/ssh/blob`; `k20c-final1` 1/1 pass.
- Clock: as P6-10. Injection: none (seeded in the case).
- Observed (as asserted): Same honesty pins for `list` and `preview --all`; batch of 10 status within the documented set. Numbers in section 4.
- Guards: `k20c-gft1` (faketime-off): not predicted, measured green 1/1.
- Evidence: `k20c-final1`, `P6-12-N100 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-12-N100/`.

**P6-10-N1000-L0** — 1000 claimed refs at 0 ms latency: list, list --context, preview, next, batch of 10 and 100. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-size3` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: no shaping.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.3.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}; `batch10` `ok` (10 × `applied`); `batch100` `ok` (90 × `applied`); seed built in 1410025 ms.
- Guards: none by design (stage k20c-size runs no mutant); the shape-profile proof replaces it: every measured call
  ran under no shaping, set before the first call, unchanged inside the window (our `size-evidence.py`).
- Evidence: `k20c-size3`, `P6-10-N1000-L0 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1000-L0/`. Cross-check only: `k20c-size2` (NOT OK, H-10) measured this case too.

**P6-10-N1000-L200** — 1000 claimed refs at 200 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-size3` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 200 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.3.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}; `batch10` `ok` (10 × `applied`); seed restored in 39 ms.
- Guards: none by design (stage k20c-size runs no mutant); the shape-profile proof replaces it: every measured call
  ran under {latencyMs: 200}, set before the first call, unchanged inside the window (our `size-evidence.py`).
- Evidence: `k20c-size3`, `P6-10-N1000-L200 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1000-L200/`. Cross-check only: `k20c-size2` (NOT OK, H-10) measured this case too.

**P6-10-N1000-L1000** — 1000 claimed refs at 1000 ms latency: list, list --context, preview, next, batch of 10. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-size3` 1/1 pass.
- Clock: true clock; `lease_ttl_ms` 6000, grace 2000, U 2000; defaults `attempt_timeout_ms` 10000, `operation_budget_ms` 30000. Injection: toxiproxy latency 1000 ms per direction on every client leg.
- Observed (as asserted): Pins honesty only: an `ok` list/preview is complete with exactly N entries, any other answer says it is incomplete; `next` never returns a seeded ticket; a batch lists only candidates and an `ok` batch reclaims all of them. The numbers are in section 4.3.
- Row notes: raw/https/blob: `next` {"status": "rejected", "stop": "bound", "attempts": 5}; `batch10` `unavailable` (3 × `applied`); seed restored in 36 ms.
- Guards: none by design (stage k20c-size runs no mutant); the shape-profile proof replaces it: every measured call
  ran under {latencyMs: 1000}, set before the first call, unchanged inside the window (our `size-evidence.py`).
- Evidence: `k20c-size3`, `P6-10-N1000-L1000 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-10-N1000-L1000/`. Cross-check only: `k20c-size2` (NOT OK, H-10) measured this case too.

**P6-11-N1000-BW** — 1000 claimed refs over a 128 KB/s leg: list and preview. Refs: O-06, M-38.

- Combos (raw/https (proxied)): `raw/https/blob`; `k20c-size3` 1/1 pass.
- Clock: as P6-10. Injection: toxiproxy bandwidth 128 KB/s on both streams of every client leg.
- Observed (as asserted): Same honesty pins for `list` and `preview --all`. Numbers in section 4.3.
- Row notes: raw/https/blob: seed restored in 38 ms.
- Guards: none by design (stage k20c-size runs no mutant); the shape-profile proof replaces it: both measured calls
  ran under {rateKBps: 128}, set before the first call, unchanged inside the window (our `size-evidence.py`).
- Evidence: `k20c-size3`, `P6-11-N1000-BW [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P6-11-N1000-BW/`. Cross-check only: `k20c-size2` (NOT OK, H-10) measured this case too.

### P7 Storage format and preflight (stage A)

**P7-01** — concurrent init with two formats: exactly one binding format, the loser reports the conflict. Refs: M-39, R-32, Q-14.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate on `refs/claim-meta/format`, hold 2; client b configured with the next format.
- Observed (as asserted): Both inits entered with the same `old` and two distinct `new`; exactly one `created`, with its own client's format; the loser `claim-error` `refused` `format-conflict` naming both formats; server refs = the descriptor only.
- Row notes: raw/https/blob: `bindingFormat` "blob"; raw/ssh/blob: `bindingFormat` "tree".
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `waitEntered`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P7-01 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-01/`.

**P7-01c** — sequential init with two formats: the second is a format conflict. Refs: M-39.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: none (control).
- Observed (as asserted): a's init `created` with this format; b's init `refused` `format-conflict`.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"format-conflict"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P7-01c [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-01c/`.

**P7-02** — local format differs from the shared area: refused before any mutation, nothing sent. Refs: M-41, R-30, R-33, Q-15.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: client b configured with the next format.
- Observed (as asserted): b's acquire `refused` `format-mismatch` naming both formats, no push; b's list `refused` `format-mismatch`; server refs unchanged; a's acquire `applied` `sends` 1.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `"code": "format-mismatch"` + `"outcome": "applied"`; `k20a-ggate3` (gate-bypass): not predicted, measured green 2/2.
- Evidence: `k20a-green1`, `P7-02 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-02/`.

**P7-03** — stale preflight: a claims while b's planned write waits; b never overwrites a. Refs: M-40, R-01, R-31.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock (no faketime). Injection: pre-receive gate holds b's acquire (hold 1).
- Observed (as asserted): a's acquire `applied` while b waits; released, b `rejected` `storage` `stale`; the ticket ref is not b's `new`; observer `agent-a`, generation 1.
- Guards: `k20a-gsplit1` (split-endpoint): predicted red, measured red 2/2, 2 at `waitEntered`; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P7-03 [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-03/`.

**P7-04a** — old-epoch renew released after install-epoch: rejected at the moved root, the new epoch holds. Refs: M-42, R-33, O-05, M-33, Q-15, Q-26.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; `attempt_timeout_ms` 20000, `operation_budget_ms` 60000. Injection: pre-receive gate hold 2: a's old-epoch renew, then install-epoch's push; `--isolation-confirmed` deliberately false.
- Observed (as asserted): install-epoch released first: `claim-epoch` `applied` 1 → 2, `breached` and `unsettled` empty, ticket rewritten; the renew released after it: `rejected` `storage` `stale`; observer `free`, epoch 2.
- Guards: `k20a-gsplit1` (split-endpoint): not predicted, measured green 2/2; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P7-04a [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-04a/`.

**P7-04b** — old-epoch renew lands between the swap and the rewrite: install-epoch ends unknown, the write stays unreadable, a rerun settles. Refs: M-42, R-33, O-05, Q-15, Q-26.

- Combos (raw/https, raw/ssh (proxied, latency 0)): `raw/https/blob`, `raw/ssh/blob`; `k20a-green1` 2/2 pass.
- Clock: true clock; `attempt_timeout_ms` 20000, `operation_budget_ms` 60000. Injection: as P7-04a, but the renew released first.
- Observed (as asserted): The old-epoch renew lands (`oldEpochWrite` below); install-epoch ends `unknown`, epoch 2, the ticket in `breached` or `unsettled`; the observer reads it incomplete, neither `free` nor `active`; a's list shows no `held`; the rerun 2 → 3 `applied`, both lists empty; observer `free`, epoch 3; `resolve` of the old renew `unknown-history`, exit 4.
- Row notes: raw/https/blob: `oldEpochWrite` "applied"; raw/ssh/blob: `oldEpochWrite` "applied".
- Guards: `k20a-gsplit1` (split-endpoint): not predicted, measured green 2/2; `k20a-ggate3` (gate-bypass): predicted red, measured red 2/2, 2 at `waitEntered`.
- Evidence: `k20a-green1`, `P7-04b [<combo>] #<rep>` in tests.log (K20 steps, K20-ROW), documents in docs.jsonl, raw outputs under `outputs/P7-04b/`.

### P5-05 leak scan (last phase of every stage)

**P5-05** — no key, token, CA or context material in any captured output of the run; the canary is found. Refs: Q-23, R-26, R-34. Runs once per stage on `raw/https/blob`, scanning the whole run, so it covers this format's outputs too.

- `k20a-green1`: no K20-LEAK line (not required by the stage A evaluator); P5-05 passed, scanned {'files': 1013, 'bytes': 1630687}.
- `k20b-green2`: 8 needles (ssh-private-key, ssh-private-key-fragment, ssh-key-path, ca-cert-path, ca-key-path, gitea-token, gitea-token-fragment, gitea-admin-password), 1109 files, 1912345 bytes, canary true, hits [].
- `k20c-final1`: 8 needles (ssh-private-key, ssh-private-key-fragment, ssh-key-path, ca-cert-path, ca-key-path, gitea-token, gitea-token-fragment, gitea-admin-password), 1523 files, 4146439 bytes, canary true, hits [].
- `k20c-size3`: 8 needles (ssh-private-key, ssh-private-key-fragment, ssh-key-path, ca-cert-path, ca-key-path, gitea-token, gitea-token-fragment, gitea-admin-password), 6113 files, 11432366 bytes, canary true, hits [].


## 4. Measured limits and bounds

### 4.1 Clock: U = 2000 ms is the measured bound

With U = 2000 ms every skew S ≤ U behaved like a true clock: the fast-clock reclaims at +1000 and +2000 ms were
`not-yet` with the true boundary, and the slow-clock holders at −2000 ms had no live work right after the hard end and
could not record a witness (`hard-expired`, nothing sent). At S = 8000 ms (4U) the three documented consequences of
CLAIM-TIME-001 appeared (documented consequences of the bound, not defects). Edges for `blob` (`k20c-final1`, raw/ssh/blob; R = reclaim boundary, H = hard
end; start/end are the call's own instants on the true clock; the clock read lies between them):

| row | skew ms | status | detail | start | end | measured offset ms |
| --- | --- | --- | --- | --- | --- | --- |
| P3-01-A0 | +0 | `rejected` | cause `not-yet` | R-4997 | R-3413 | +0 |
| P3-01-A1000 | +1000 | `rejected` | cause `not-yet` | R-4998 | R-3784 | +1001 |
| P3-01-A2000 | +2000 | `rejected` | cause `not-yet` | R-4998 | R-3700 | +2001 |
| P3-01-A8000 | +8000 | `applied` | `sends` 1 | R-4999 | R-2715 | +8001 |
| P3-02-L0 | +0 | `ok` | `workRight` `none` | H+503 | H+1640 | +0 |
| P3-02-L2000 | -2000 | `ok` | `workRight` `none` | H+502 | H+1771 | -1999 |
| P3-02-L8000 | -8000 | `ok` | `workRight` `live` | H+502 | H+1717 | -7999 |
| P3-03-L2000 | -2000 | `rejected` | cause `hard-expired` | H+202 | H+1346 | -1999 |
| P3-03-L8000 | -8000 | `applied` | `sends` 2 | H+201 | H+3399 | -7999 |

The early reclaim at +8000 ms started 5 s before R and ended before R. The guard run `k20c-gft1` drops libfaketime on
the 27 skewed steps; exactly the three S > U rows then failed (P3-01-A8000 at `"applied"`, P3-02-L8000 at `"live"`,
P3-03-L8000 at `"confirmed"`), 3/3 each, and every S ≤ U row stayed green. A skew of 2U (4000 ms) was not usable as the
positive edge: the product reads its clock after its store and ticket reads, and a 2 s window is shorter than one call
(row disposition below). No row saw a command take a claim over by itself: `claim next` acquired free tickets only
(P6-10 `next` notes, run on the true clock), and every early takeover under skew was an explicit `claim reclaim`.

### 4.2 Sizes and latency, gate matrix (`k20c-final1`, alone on the test machine)

Per measured call: elapsed ms (the call's own wall-clock), top-level Git processes, network Git commands
(ls-remote/fetch/push), wire requests / response body bytes at the https front, document status, `complete`. From
k20.py `2a243518`'s size table. The last block is P6-12-N100 on Gitea/ssh/blob (no wire measure on ssh).

| row | server/transport | call | elapsed ms | git top | ls-remote/fetch/push | wire req / bytes | status | complete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P6-10-N1-L0 | raw/https | `list` | 1031 | 16 | 3/2/0 | 6 / 2228 | `ok` | true |
| P6-10-N1-L0 | raw/https | `list --context` | 1422 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L0 | raw/https | `preview --all` | 1143 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L0 | raw/https | `next` | 3763 | 65 | 10/8/1 | 20 / 7058 | `applied` |  |
| P6-10-N1-L0 | raw/https | `batch 1` | 3254 | 56 | 7/7/1 | 16 / 6326 | `ok` | true |
| P6-10-N1-L200 | raw/https | `list` | 5098 | 16 | 3/2/0 | 6 / 2228 | `ok` | true |
| P6-10-N1-L200 | raw/https | `list --context` | 5156 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L200 | raw/https | `preview --all` | 5021 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L200 | raw/https | `next` | 17768 | 65 | 10/8/1 | 20 / 7058 | `applied` |  |
| P6-10-N1-L200 | raw/https | `batch 1` | 14692 | 56 | 7/7/1 | 16 / 6326 | `ok` | true |
| P6-10-N1-L1000 | raw/https | `list` | 22852 | 16 | 3/2/0 | 6 / 2228 | `ok` | true |
| P6-10-N1-L1000 | raw/https | `list --context` | 21097 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L1000 | raw/https | `preview --all` | 21290 | 16 | 3/2/0 | 5 / 1795 | `ok` | true |
| P6-10-N1-L1000 | raw/https | `next` | 67594 | 53 | 9/6/1 | 16 / 5366 | `applied` |  |
| P6-10-N1-L1000 | raw/https | `batch 1` | 47990 | 43 | 5/5/1 | 12 / 4634 | `ok` | true |
| P6-10-N100-L0 | raw/https | `list` | 19648 | 709 | 102/101/0 | 270 / 1406811 | `ok` | true |
| P6-10-N100-L0 | raw/https | `list --context` | 15813 | 709 | 102/101/0 | 203 / 1377761 | `ok` | true |
| P6-10-N100-L0 | raw/https | `preview --all` | 15437 | 709 | 102/101/0 | 203 / 1377761 | `ok` | true |
| P6-10-N100-L0 | raw/https | `next` | 4079 | 119 | 17/16/0 | 33 / 223971 | `rejected` |  |
| P6-10-N100-L0 | raw/https | `batch 10` | 19213 | 488 | 61/61/10 | 142 / 895695 | `ok` | true |
| P6-10-N100-L0 | raw/https | `batch 100` | 172362 | 4398 | 551/551/90 | 1282 / 8088485 | `ok` | true |
| P6-10-N100-L200 | raw/https | `list` | 32734 | 107 | 16/15/0 | 45 / 216465 | `unknown` | false |
| P6-10-N100-L200 | raw/https | `list --context` | 30930 | 121 | 18/17/0 | 37 / 238413 | `unknown` | false |
| P6-10-N100-L200 | raw/https | `preview --all` | 31700 | 114 | 17/16/0 | 40 / 227006 | `unknown` | false |
| P6-10-N100-L200 | raw/https | `next` | 28947 | 119 | 17/16/0 | 33 / 223971 | `rejected` |  |
| P6-10-N100-L200 | raw/https | `batch 10` | 121974 | 488 | 61/61/10 | 142 / 895695 | `ok` | true |
| P6-10-N100-L1000 | raw/https | `list` | 33361 | 23 | 4/3/0 | 9 / 48374 | `unknown` | false |
| P6-10-N100-L1000 | raw/https | `list --context` | 39292 | 30 | 5/4/0 | 10 / 61515 | `unknown` | false |
| P6-10-N100-L1000 | raw/https | `preview --all` | 31072 | 23 | 4/3/0 | 8 / 47943 | `unknown` | false |
| P6-10-N100-L1000 | raw/https | `next` | 141140 | 119 | 17/16/0 | 36 / 225270 | `rejected` |  |
| P6-10-N100-L1000 | raw/https | `batch 10` | 126213 | 116 | 16/13/3 | 32 / 196766 | `unavailable` | false |
| P6-12-N100 | gitea/ssh | `list` | 30606 | 681 | 98/97/0 | – | `unknown` | false |
| P6-12-N100 | gitea/ssh | `preview --all` | 30593 | 688 | 99/98/0 | – | `unknown` | false |
| P6-12-N100 | gitea/ssh | `batch 10` | 24411 | 488 | 61/61/10 | – | `ok` | true |

Every size case ran under exactly the profile its id names, set 1–68 ms before the first measured call, with no change
inside the measured window; wire coverage 5/5 or 6/6 on every https case (our `size-evidence.py` on
`k20c-final1`). The spread list between formats at equal (N, L) is empty (no pair over 30 %). In the repeat run
`k20c-rep1` the informational spread list holds two pairs, both at N = 1 and 0 ms: `list` 1058–1406 ms and
`list --context` 966–1478 ms (k20.py `2a243518`); the kill condition binds only the size stage (SCENARIO-FORMAT
§9). Single-claim calls at N = 1 and 0 ms latency vary by up to ≈ 0.5 s between runs; the format that is slowest changes from run to run while the Git process count per format stays the same, so spreads over 30 % there are wall-clock jitter, not a cost of the storage format (dry3, final1, k20c-rep1).

What the table shows, stated as measured in `k20c-final1`:

- **Per call, never per batch.** `operation_budget_ms` 30000 bounds each call; a batch reclaims its candidates one
  after another, each with its own budget. The batch of 100 at N = 100 and 0 ms took 165.8–172.4 s across the three
  formats and reclaimed all 90 remaining candidates (`ok`). No list-type call ran longer than 39.3 s, below
  `operation_budget_ms` + `attempt_timeout_ms` (40 s), the overrun the guide names for one in-flight Git command.
- **Honestly incomplete under the budget.** At N = 100 and 200 ms, `list`, `list --context` and `reclaim-preview
  --all` end `unknown` with `complete` false after 30.9–33.1 s; the raw/https/blob list read 14 claims and reported 86
  as `unknown`. At 1000 ms the same calls end `unknown` after 30.9–39.3 s with 2 claims read and 98 `unknown`. None
  reports an unread claim as free.
- **Batch at the budget edge.** At N = 100 and 1000 ms the batch of 10 ends `unavailable`, `complete` false, after
  126.0–126.3 s: three candidates `applied`, the other seven listed in `unreadable` and not tried. At 200 ms the batch
  of 10 is `ok` in 122.0–123.5 s.
- **`claim next` time per call.** At N = 100 the five candidates are all taken; `next` ends `rejected` with stop
  `bound` after five `not-free` attempts: 4.0–4.2 s at 0 ms, 28.8–28.9 s at 200 ms, 141.0–141.1 s at 1000 ms. The
  guide's bound for this call is `--max-candidates` × (`operation_budget_ms` + `attempt_timeout_ms`) = 200 s.
- **Gitea at N = 100 (blob only).** Over Gitea/ssh at 0 ms, `list` and `preview --all` already end `unknown`,
  `complete` false, at 30.6 s (96 resp. 97 of 100 read); the batch of 10 is `ok` in 24.4 s.
- **N = 1.** Every call is `ok`/`applied`; at 1000 ms `list`, `list --context` and `preview --all` take 20.7–23.3 s, `next` 67.0–67.6 s, the batch of
  one 48.0–48.6 s.

### 4.3 Sizes and latency, size stage (`k20c-size3`, alone on the test machine)

Same columns as section 4.2, from k20.py `2a243518`'s size table of `k20c-size3` (n = 1 by decision, contract
addendum 3; server `/tmp` tmpfs 2 GiB, section 2). P6-11 runs over a 128 KB/s leg instead of a latency.

| row | server/transport | call | elapsed ms | git top | ls-remote/fetch/push | wire req / bytes | status | complete |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| P6-10-N1000-L0 | raw/https | `list` | 31008 | 891 | 128/127/0 | 340 / 16914927 | `unknown` | false |
| P6-10-N1000-L0 | raw/https | `list --context` | 30808 | 1087 | 156/155/0 | 331 / 20593158 | `unknown` | false |
| P6-10-N1000-L0 | raw/https | `preview --all` | 30590 | 968 | 139/138/0 | 331 / 18357556 | `unknown` | false |
| P6-10-N1000-L0 | raw/https | `next` | 7742 | 119 | 17/16/0 | 33 / 2184204 | `rejected` |  |
| P6-10-N1000-L0 | raw/https | `batch 10` | 18492 | 488 | 61/61/10 | 142 / 8736627 | `ok` | true |
| P6-10-N1000-L0 | raw/https | `batch 100` | 153767 | 4398 | 551/551/90 | 1282 / 78894477 | `ok` | true |
| P6-10-N1000-L200 | raw/https | `list` | 31561 | 100 | 15/14/0 | 42 / 1925107 | `unknown` | false |
| P6-10-N1000-L200 | raw/https | `list --context` | 32150 | 121 | 18/17/0 | 38 / 2317887 | `unknown` | false |
| P6-10-N1000-L200 | raw/https | `preview --all` | 32298 | 107 | 16/15/0 | 42 / 2056606 | `unknown` | false |
| P6-10-N1000-L200 | raw/https | `next` | 32940 | 119 | 17/16/0 | 33 / 2184204 | `rejected` |  |
| P6-10-N1000-L200 | raw/https | `batch 10` | 123592 | 488 | 61/61/10 | 142 / 8736627 | `ok` | true |
| P6-10-N1000-L1000 | raw/https | `list` | 32908 | 23 | 4/3/0 | 9 / 464180 | `unknown` | false |
| P6-10-N1000-L1000 | raw/https | `list --context` | 39016 | 30 | 5/4/0 | 10 / 596127 | `unknown` | false |
| P6-10-N1000-L1000 | raw/https | `preview --all` | 30855 | 23 | 4/3/0 | 8 / 463751 | `unknown` | false |
| P6-10-N1000-L1000 | raw/https | `next` | 145600 | 119 | 17/16/0 | 36 / 2185508 | `rejected` |  |
| P6-10-N1000-L1000 | raw/https | `batch 10` | 126535 | 115 | 15/13/3 | 32 / 1919395 | `unavailable` | false |
| P6-11-N1000-BW | raw/https | `list` | 30976 | 163 | 24/23/0 | 69 / 3120410 | `unknown` | false |
| P6-11-N1000-BW | raw/https | `preview --all` | 32292 | 170 | 25/24/0 | 69 / 3251901 | `unknown` | false |

Every size case ran under exactly the profile its id names, set 1–2 ms before the first measured call, with no change
inside the measured window; wire coverage 6/6 at 0 ms, 5/5 at 200 and 1000 ms, 2/2 on P6-11 (our
`size-evidence.py` on `k20c-size3`). The seed of 1000 claims was built once per format in the 0 ms case (1410025 / 1492338 / 1473749 ms
for blob / tree / commit-chain) and restored in 36–109 ms for every later case. The spread list between formats at
equal (N, L) is empty (no pair over 30 %), so no second size run was made.

What the table shows, stated as measured in `k20c-size3` across the three formats:

- **Every list-type read at N = 1000 is honestly incomplete.** `list`, `list --context` and `reclaim-preview --all`
  end `unknown` with `complete` false at every latency: after 30.5–31.0 s at 0 ms with 119–154 of 1000 claims read,
  31.2–32.3 s at 200 ms with 13–16 read, 30.9–39.5 s at 1000 ms with 2–3 read, and 31.0–32.3 s over the 128 KB/s leg
  with 22–23 read (docs.jsonl) and 3.1–3.3 MB on the wire. A call ran 121–156 `ls-remote` at 0 ms, 15–18 at 200 ms
  and 4–5 at 1000 ms. Every unread claim is listed `unknown`, and the preview gives it the verdict
  `unknown`; none reports an unread claim as free.
- **Per call, never per batch.** At 0 ms the batch of 100 reclaimed all 90 remaining candidates (`ok`) in
  153.8–188.7 s; the batch of 10 is `ok` in 18.5–20.9 s at 0 ms and in 123.6–125.7 s at 200 ms. No list-type call ran
  longer than 39.5 s, below `operation_budget_ms` + `attempt_timeout_ms` (40 s).
- **Batch at the budget edge.** At 1000 ms the batch of 10 ends `unavailable`, `complete` false, after 126.5–126.8 s:
  three candidates `applied`, the other seven listed in `unreadable` and not tried, as at N = 100.
- **`claim next` time per call.** The five candidates are all taken; `next` ends `rejected` with stop `bound` after
  five `not-free` attempts without a send: 7.7–7.9 s at 0 ms, 32.6–33.0 s at 200 ms, 144.8–145.6 s at 1000 ms, within
  the guide's bound of 200 s for this call.
- **Format difference.** At 0 ms the calls take the same time in all three formats; the Git processes per call grow
  blob < tree ≈ commit-chain (`list` 891 / 1717 / 1794), and the batch of 100 takes 23 % longer on commit-chain than
  on blob (153.8 / 171.8 / 188.7 s for blob / tree / commit-chain), under the 30 % threshold.
- **Cross-check, not evidence.** `k20c-size2` (NOT OK, H-10) measured eleven of these twelve size cases. Across the
  52 calls both runs share, the largest runtime deviation is 8.7 % (P6-10-N1000-L0 [blob] `batch 10`: 20.2 s in
  `k20c-size2`, 18.5 s in `k20c-size3`), no call deviates by more than 10 %, and status and `complete` agree in all
  52 (our cross-check, recomputed with k20.py `2a243518` on both archives).

### 4.4 Late landing after a client abort (Q-25, F9)

Whether receive-pack completes a push after the client is gone depends on the transport front. The rows pin only that
`resolve` agrees with the server ref; `lateLanding` records what happened (`k20b-green2`):

| row | combo | lateLanding | landedDuringResolve |
| --- | --- | --- | --- |
| P2-02u | raw/https/blob | true | – |
| P2-02u | raw/ssh/blob | true | – |
| P4-01 | raw/https/blob | true | – |
| P4-01 | raw/ssh/blob | true | – |

### 4.5 Timings not used as bounds

Stage A ran in three lanes in parallel and the stage B finals shared the test machine with each other and, for about 20 minutes, with
a stage C dry run. No stage A or stage B timing is quoted in this report as a single-run value; only the stage C gate matrix (`k20c-final1`) and
the size stage (`k20c-size3`) ran alone.

## 5. Findings and dispositions during the qualification

No product finding. Every red row during the qualification was a harness defect or a row defect, dispositioned and
recorded in the run ledger.

**Harness defects** (each fixed before the official run it would have affected; recorded in the run ledger, which is not
part of this repository):

- **H-1** — the executor spawned the MCP server without the transport environment (MCP `unreachable` while the CLI
  reached the server); fix: one `productEnv()` for CLI and MCP spawns.
- **H-2** — `where: "worktree"` used a worktree of an unborn HEAD (`project-not-found`); fix: commit the project before
  `git worktree add -b`.
- **H-3** — the server container exhausted `pids_limit` 256 (python3 as PID 1 never reaped orphaned grandchildren);
  fix: `dumb-init` as PID 1; `serverPids` flat at 5–6 over every official run.
- **H-4** — toxiproxy state leaked across cases (a row that failed after `network("refuse")` left the proxy disabled);
  fix: reset the proxy to `up` at both ends of every proxied row.
- **H-5** — the runtime parsed every CLI output as JSON (`backlog task edit` prints text); fix: tolerant parsing.
- **H-6** — post gates in post-receive could not hold the reply (receive-pack sends the status report before
  post-receive); fix: post gates hold in the reference-transaction hook, state `committed`.
- **H-6a** — the H-6 shim started python also in state `prepared`, where git holds the ref lock, so a winner's lock
  outlasted `core.filesRefLockTimeout` and a CAS loser re-read too early (P2-03 `remote`); fix: the shim exits for every
  state but `committed`.
- **H-7** — the gate record's `entered` was not filled when a row never waited; fix: read from `/gate/status` at row
  end.
- **H-8** — sshd did not pass the daemon environment to hook processes, so `gate-bypass` held over ssh (`k20a-ggate1`);
  fix: the mutant name is written to a file at server start (`k20a-ggate2` then exposed an over-strict init check,
  narrowed; `k20a-ggate3` is the guard of record).
- **H-9** — Bun's fetch carries a built-in 300 s idle timeout up to the response head; `driver/k20.ts` called `/project` without a timeout, and the executor answers only after the 1000-ticket template build (≈ 17 min for 1010 tasks). `k20c-size1` was stopped by fail-fast after two cases (P6-10-N1000-L0 [blob] and [tree], bare `TimeoutError` at 300 007 / 299 999 ms, no `harnessError` note, which k20.py `2a243518` would have counted as findings); it is not evidence. Fix `4345da1` in the harness (scenarios and evaluator untouched): one `harnessFetch` wrapper with `timeout: false` (the row's timeoutMs caps the case), transport errors re-thrown with the K20-HARNESS prefix. The size measurement reran as `k20c-size2` and, after H-10, as `k20c-size3`. Harness defect, no product point.
- **H-10** — the server keeps `REPOS_ROOT` and the snapshots under its `/tmp`, a 256 MiB tmpfs. In `k20c-size2` eleven N1000 repositories and their snapshots filled it: the twelfth case (P6-11-N1000-BW [commit-chain]) died in the control API's `restore` (`cp -a` rc 1, containers.log `No space left on device`), the following `init` for P5-05 the same way, so P5-05 and the K20-LEAK line are missing. Both errors carry the K20-HARNESS prefix: NOT OK with 0 findings and 4 problems, all harness. `k20c-size2` is not evidence; its eleven measured rows are a cross-check only. Fix `133143f` in the harness (compose.yaml only; scenarios, evaluator and `entry.py` untouched): server `/tmp` tmpfs 256 MiB → 2 GiB, server `mem_limit` 1 GiB → 3 GiB (tmpfs pages are charged to the container's memory cgroup). In `k20c-size3` the server tmpfs held 186 MB of 2 GB after case 7. Harness defect, no product point.
- **H-11** — the harness run script archives the native checkout's working tree (`tar … -C "$checkout" .`). After the documentation edits of the qualification were applied to that tree (uncommitted), `k20a-rep1` archived 613 product files, 6 of them differing from `fd23b8d` (CLAIMS.md, the guide, the storage/rights/config/pause READMEs) plus the new src/claims/QUALIFICATION.md, so its product pin failed although Bun passed 124/0 with 0 findings; every earlier official archive had 612/0 because the tree was clean then. Remedy without a harness change: a clean detached `git worktree` of Backlog.md at `fd23b8d`, passed as `CHECKOUT` to `k20c-size3` and every repeat run. `k20a-rep1`, `k20b-rep1` and `k20b-rep2` are not evidence; `k20b-rep1` also carried one harness problem of its own (P5-02 raw/ssh/commit-chain: `K20-HARNESS project init failed: unavailable/unreachable` in the executor's own `claim init`, stderr not captured; harness commit `607a82b` now returns it; cause: H-12). Harness defect, no product point.
- **H-12** — OpenSSH ≥ 9.8 applies `PerSourcePenalties` by default. P5-02 fails three publickey logins per combo on purpose, and since the stage-3 template cache made `project()` fast, the three ssh combos follow each other inside the penalty window, so the third combo's `claim init` from the same client was refused: `k20b-rep1` and `k20b-rep3` failed P5-02 [raw/ssh/commit-chain] in client a's project init with `unavailable/unreachable` (`k20b-rep3`, with the init stderr of `607a82b`: exit 6, stderr empty). The cause stands in `k20b-rep3` sshd.log :480–481: `drop connection #0 from [172.22.0.2]:53756 on [172.22.0.4]:2222 penalty: failed authentication`; `k20b-rep1`'s sshd.log carries the same two lines at :480–481. `k20b-green2` ran before the cache and spaced the failures wider (0 penalty lines in its sshd.log, same combo order). Fix `cf916ee` in the harness (entry.py only): the harness sshd starts with `-o PerSourcePenalties=no`, so rows stay isolated; `k20b-rep4` runs on it. `k20b-rep1` and `k20b-rep3` are not evidence. Harness defect, no product point; the daemon's behaviour is listed below as an operational observation.
- **E1** (evaluator) — Bun 1.3.14's JUnit reporter writes empty `<failure>` elements; k20.py reads the failure text
  from tests.log.

**Row dispositions** (all rows, no product point):

- **P1/P7/P2 race rows** (`gsplit2`) — a racer's own retry after `attempt_timeout_ms` re-enters a gate with the same
  `old` and `new`; race rows now require pairwise distinct `new` among the entrants; guard needles are tuples.
- **P2-03** — the CAS loser read `remote` under H-6 (winner held the ref lock in its hook); the row accepts `stale` or
  `remote` and notes `loserCause`; after H-6a it reads `stale` 6/6 (`k20b-green1`, `k20b-green2`).
- **P2-02u, P4-01** — a released gate returns before receive-pack moves the ref; the rows poll the server ref
  (`landedWithin`) and note `lateLanding`.
- **P4-02** — after a host rejection the context's next batch is `paused` (the rejected reclaims stay outstanding):
  documented batch behaviour; the row continues with `claim retry`. M-25's stop on a shared permission fault is not
  offered in V1 (decision 2026-09-29, option A; F7).
- **P2-01q** — the row read the gate instant (epoch seconds) as milliseconds and passed with `applied` unmeasured in
  `k20b-green1`; fix ×1000 and pin `storage.kind` `queried`; pair: `k20b-green2` shows `queried` 6/6.
- **P3 time edges** — the product reads its clock after its store and ticket reads, so at S = 2U no spawn instant is
  both entitled and before R; the positive clock-skew rows use S = 4U = 8000 ms (ids A8000/L8000 replace A4000/L4000).
- **P3-05** — an acquire under lifetime `hard` needs `--hard-end` (`hard-end-required` otherwise); the row passes it.
- **P6-01w** — a's own earlier release stays outstanding after a restore (pause rule) and pauses a's context; the row
  frees the ticket by emergency release instead.
- **P6-10** — C's own live claims are no candidates of a later batch (`taken` set); per-(N, L) timeouts; `claim next`
  is noted, not pinned.

**Operational observations for the user docs:**

- `claim next` stops at `rejected` with `storage` `remote` instead of moving to the next candidate when a host holds the
  claim ref lock during a race longer than the loser's lock wait. Seen with the harness shim H-6 (`k20b-injoff1`, P2-03
  `remote` 6/6); after H-6a the same row reads `stale` 6/6. This is the documented classification (guide "Ready
  selection and order": `remote` "when it still does or the re-read fails").
- A restore without the install-epoch procedure pauses every context whose own operation the restore turned back
  (documented pause rule: ticket, endpoint, format, epoch and `expectedRoot` equal); `claim retry` would send that
  intent again onto the restored area. The pause was observed only in the dry run `k20c-dry1` (superseded p6, not
  evidence): in all three formats a's landed `claim release` was turned back by the restore, and a's next `renew` ended
  `paused`, kind `outstanding`, naming exactly that operation. The official row P6-01w (`k20c-final1`) was changed to
  avoid the pause (it frees the ticket by emergency release, row dispositions above) and shows only that the restored
  proof renews `applied`. The way out of that pause was not measured. The observation supports step 2 of CLAIMS.md
  "Install a new epoch after a restore".
- After failed publickey logins, OpenSSH ≥ 9.8 refuses further connections from the same client address for a while
  (`PerSourcePenalties`, on by default), so a later claim call with working credentials ends `unavailable` /
  `unreachable` with an empty stderr; only the server log names the cause. Measured: `k20b-rep3` sshd.log :480–481
  and the product's `unavailable/unreachable` (exit 6, stderr empty) in P5-02 (H-12). Not measured against Gitea.

## 6. Not measured / unqualified

- Write-path isolation on any host: no host was shown to cut off the write paths for `install-epoch`.
- Pushes that passed a new gate being stopped or awaited (other than the harness's own gates).
- Replicas and mirrors; clients older than this version.
- GitHub, GitLab, Forgejo and every Git or Gitea version other than the ones named (only those were measured; the report does not extrapolate).
- macOS, win32, NFS and every non-Linux platform (Linux containers only).
- `git://` as a production transport: control transport only, unauthenticated.
- A Git credential helper: HTTP authentication ran through `GIT_ASKPASS`.
- The honesty pins of the size rows are guard-proven in no stage: no harness defect makes the product lie (our
  limit statement, run ledger).
- stage A and stage B timing values (shared test machine, section 4.5).
- The size stage is n = 1 by decision; its spread list is empty, so no second size run was made (`k20c-size3`).
  The two spread pairs of the gate-matrix repeat `k20c-rep1` (N = 1, 0 ms: `list` 1058–1406 ms, `list --context`
  966–1478 ms) decide nothing. Single-claim calls at N = 1 and 0 ms latency vary by up to ≈ 0.5 s between runs; the format that is slowest changes from run to run while the Git process count per format stays the same, so spreads over 30 % there are wall-clock jitter, not a cost of the storage format (dry3, final1, k20c-rep1).
- Not exercised by any official row: a `witnessed` time-path phase and `claim retry` of a confirmation; a transfer
  restart with a later hard end over the time path; `change-bounds` to an earlier hard end and `mode-change`;
  `install-epoch` causes `epoch-changed` and `writes-observed`; a send stopped by the budget (`stoppedBy: "budget"`; 0
  documents in the four final archives); status `internal`; MCP tools other than `claim_acquire` and `claim_list`
  and `claim_resolve`.

## 7. Reproduction

The archives (`artifacts/<runid>/`), the harness and the evaluators are not part of this repository, and neither are
the two helper scripts that computed the clock-skew edges and the size evidence from the
archives. The evaluator's sha256 is recorded in every archive and checked at evaluation. The frozen hashes below
identify the scenario files and the evaluators used.

Frozen scenario hashes (sha256, `K20-RUN.scenarios`, checked by every
evaluator): k20a-smoke `0e10dc95…`, p1 `6f6b302b…`, p7 `0d7be160…`, z-leak `4dfc5ed0…`, p2 `f2a06c30…`, p4
`01a4aef6…`, p5 `674c50d9…`, p3 `ca8c43ef…`, p6 `172d9588…`, p6-size `a0d3fbe1…`; evaluators `1dbc05fa…` (stage A),
`6db8e5e6…` (stage B), `8b6c534e…` (stage C acceptance), `2a243518…` (stage C finals and repeats); full hashes available on request.
