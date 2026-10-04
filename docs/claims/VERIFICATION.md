# Claims: verification

How the claims feature was tested, what the numbers are, and which of the evidence is in this repository.

## Method

Every behaviour was built test-first in its own loop: a written contract; test rows written by a separate test
author; a RED run of those rows measured on the previous head; the implementation by a third party; a GREEN run;
guard mutants per contract axis against the real implementation, so that each row is shown to catch exactly the
defect it names; a review round; then container runs of the whole suite per commit. One contract and one run
ledger per loop, 26 contracts and 24 ledgers in all. The contracts and ledgers are our working records and are
not part of this repository; the tests are, under `src/test/claim-*.test.ts`.

## Container runs per commit

The test suite ran in a container built from `oven/bun:1.3.14` with a read-only root filesystem, no network, one
CPU, 2 GB of memory and 256 processes, in four modes: the CLI suites, the storage adapter suites with their Git
servers, the configuration suites, and upstream's own CI line. 237 archived container runs over the work, of
which 145 ended with exit code 0 and 91 with a non-zero code (intended RED runs and harness iterations included;
one archive has no exit code).

The published head measures, per commit of the series on top of upstream `69e7b15`:

| commit | CLI suites (pass / fail) | adapter suites (pass / skip / fail) |
| --- | --- | --- |
| upstream test fixes | 509 / 0 | not applicable |
| git-backed storage adapters | 509 / 0 | 163 / 1 / 0 |
| journal, query, rights, execution, config | 654 / 0 | 617 / 1 / 0 |
| claim CLI, surface core, user documents | 962 / 0 | 925 / 1 / 0 |
| claim tools over MCP | 1016 / 0 | 989 / 1 / 0 |
| claim owner in the browser | 1049 / 0 | 1022 / 1 / 0 |
| qualification record | 1049 / 0 | 1022 / 1 / 0 |

Every archive carries the source it tested, compared by Git blob hash against the commit; types and formatting
were clean in every run.

## Upstream's CI line

Upstream's own CI workflow ran unchanged on a private mirror of this branch (ubuntu, macOS and Windows jobs,
compile-and-smoke tests, the nix package). The ubuntu job runs the full profile with two parallel workers in
isolation mode and a 10 s timeout per test.

| run on | ubuntu full profile (pass / skip / fail) | other jobs |
| --- | --- | --- |
| the measured revision | 3578 / 9 / 1 | macOS green, Windows 3 fails identical to upstream's own baseline |
| the qualification record | 3576 / 9 / 3 | same |
| the first fixture commit | 3575 / 9 / 4 | same |
| the evidence commit | 3579 / 9 / 0 | all green, Windows included |
| the published head | 3579 / 9 / 0 | macOS green, Windows 2 fails of upstream's own timeout class |

The failures in the first three ubuntu runs were four tests of the claim test fixtures, none of the product: a
proxy that classified a connection by its first data event although Git writes a packet's length and payload in
two writes, and three rows that cut the connection after the server had already sent its status report. Both
fixtures were corrected in the two test-only commits before the published head; the rows carry positive controls
now, and the storage adapter suite, the mutation resolution suite and the git primitives suite ran green in the
container (132 / 1 / 0, 21 / 0, 25 / 0) and under the CI line's own shape (two CPUs, two workers: 0 failing claim
tests). One ubuntu run also showed a single upstream TUI test fail that the series does not touch.

The same CI line in a two-CPU container without network and without a terminal reproduces the claim results and
leaves 25 upstream tests failing that need what the container withholds (an editor, ssh-keygen, platform launcher
packages, a terminal for init, a writable parent directory); that set is identical across all our runs and is not
part of the claims work.

## Qualification against real Git servers

[QUALIFICATION.md](../../src/claims/QUALIFICATION.md) is the summary with bounds. The method:

- One compose stack per run: a plain Git server (git daemon on `git://`, `git http-backend` behind CGI on
  `http://` and `https://` with a private CA, OpenSSH 10.0p2 on a high port) and Gitea 1.24.7 rootless (HTTP and
  its built-in SSH server), both fronted by toxiproxy 2.11.0 where a case injects network faults; three client
  containers, each running the shipped `backlog` CLI in its own project directory, and for the parity rows
  `backlog mcp start`; a driver that runs the frozen scenario files. libfaketime 0.9.10 shifts single clients.
  Git 2.47.3 on the server and the clients, Bun 1.3.14.
- Six server and transport combinations times three storage formats, 18 combinations. Four stages: K20a with
  124 checks (smoke per combination, acquire races, transfer, formats, preflight), K20b with 115 (lost replies and
  network loss, batch reclaim, CLI and MCP parity, secrets in output), K20c with 87 (clock skew and late writes,
  restore and new epochs, incompatible data, `enabled: false`, sizes up to 100 claims), K20c-size with 13 (1000
  claims, a bandwidth-limited link); 339 checks per full matrix.
- A stage counted only after a guard run, with the harness deliberately broken in one place, turned exactly the
  predicted checks red and nothing else: endpoints split across two repositories (93 checks red), the push gate
  bypassed (54), fault injection switched off (54), the clock shift switched off (9).
- The matrix ran three times: twice on the revision before the history was cleaned up (`k20a-green1`,
  `k20b-green2`, `k20c-final1`, `k20c-size3`; then `k20a-rep2`, `k20b-rep4`, `k20c-rep1`) and once on the
  published revision `cb45f9f` (`k20a-native1`, `k20b-native1`, `k20c-native1`, `k20c-size-native1`). Every
  official run ended green with 0 findings; on the published revision every check kept its status and
  completeness. 14 official runs, 1454 checks; 49 archived qualification runs in all, the rest being dry runs,
  guard runs and harness iterations.
- Evaluation: a frozen evaluator script whose sha256 the driver records in every archive and checks at
  evaluation; ten frozen scenario files identified by hash; the product in every archive compared by blob hash
  against the revision; a leak scan with eight needles over every captured output; coverage of every expected
  check for every combination; harness faults classified as problems, never as findings.

The three per-format reports with every row, combination, injection and measured value are in
[qualification/](qualification/), with a README on the stack and how the archives were evaluated. The archives
themselves (logs, step documents, raw outputs) are not in this repository.

## Measurements beyond tests

- Concurrent claim reads in one checkout: a diagnosis with system-call traces and counter-probes found that a
  sibling read's temporary ref, seen with Git's strict ref checking, failed a claim fetch in 2 to 9 of 1000
  real rows; with the fix 0 of 1000. The fix is in the storage commit.
- The other direction, a user's own Git command in the same checkout during a claim read: measured twice, with
  10 to 5010 refs, loose and packed; the result is in [KNOWN-LIMITS.md](KNOWN-LIMITS.md).

## Calendar

2026-09-24 to 2026-10-03, ten consecutive days with dated ledger entries, 286 archived container runs in all.
