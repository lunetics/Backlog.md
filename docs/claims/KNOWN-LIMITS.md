# Claims: known limits

What to do about the limits the claims feature has in everyday use, each with the condition in a few sentences.
The measured values behind them, with their caveats, are in the
[evidence repository](https://github.com/lunetics/backlog-md-claims-qualification): the operational observations
(a host whose hooks hold a ref lock, a restore outside the epoch procedure, OpenSSH's login penalties) and the size
figures in its QUALIFICATION.md, the measurement of the first limit below in its VERIFICATION.md.

## Other Git commands in the same checkout during a claim read

What to do: repeat the command. A script that calls Git often should retry once on exactly the message
`fatal: bad object refs/backlog-md/claim-storage/read/...` (a fetch adds `did not send all necessary objects`).
Keep pollers modest: a tool that fires ref-enumerating Git commands in tight succession is the one that notices
the limit, a person typing commands will rarely meet it.

The condition: when a claim is read, Backlog.md briefly creates a temporary ref in the project's Git repository
and deletes it again a few milliseconds later. A Git command run in the same checkout at exactly that moment that
enumerates every ref (`git fetch`, `git log --all`, `git rev-list --all`, `git gc`) can abort. The repository stays
consistent, a fetch has then updated nothing, and the command succeeds on the next call. `git status`,
`git commit`, `git for-each-ref` and `git push` were not affected. `git gc --prune=now` during a claim read can in
addition fail the claim read itself; the default `gc` does not. Our own concurrent claim reads do not break each
other.

Measured with Git 2.47.3 and five concurrent claim reads: a command that overlapped a live temporary ref failed in
about 0.1 to 1.0 of 100 cases, `git fetch origin` in none of about 1000; a poller at 227 to 1010 refs lost about
1 to 2 of 100 claim reads' loop calls. The full figures and the two caveats of the measurement are in the evidence
repository.

## Many claims

What to do: above about 100 claims, or over a slow link, raise `operation_budget_ms` (default 30000). At 100 claims
`claim list` took about 20 s under the default budget and, with 200 ms of added latency, ran out of it; at 1000
claims no `list` or `reclaim-preview` completes under the defaults at any measured latency. An answer that ran out
of budget says so: every unread claim is reported as `unknown` and the call ends `unknown` with `complete: false`,
never with an unread claim shown as free. The budget is per call, so a `reclaim-batch` of 100 takes minutes. The
measured sizes and latencies are in the evidence repository; raising the budget itself was not tested, and neither
were more than 1000 claims.

## Linux only

Linux containers were tested. macOS, Windows and NFS were not tested at all, and the tests that upstream runs on
Windows show failures unrelated to claims in upstream's own baseline.
