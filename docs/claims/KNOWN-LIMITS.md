# Claims: known limits

Measured limits of the claims feature, with the conditions under which they were measured. The operational
observations of the qualification (a host whose hooks hold a ref lock, a restore outside the epoch procedure,
OpenSSH's login penalties) and the size limits under the default budgets are in
[QUALIFICATION.md](../../src/claims/QUALIFICATION.md) and are not repeated here.

## Other Git commands in the same checkout during a claim read

When a claim is read, Backlog.md briefly creates a temporary ref in the project's Git repository and deletes it
again a few milliseconds later. A Git command run in the same checkout at exactly that moment that enumerates
every ref (`git fetch`, `git log --all`, `git rev-list --all`, `git gc`) can abort with
`fatal: bad object refs/backlog-md/claim-storage/read/...`; a fetch adds `did not send all necessary objects`.
The repository stays consistent, a fetch has then updated nothing, and the command succeeds on the next call.

Measured with Git 2.47.3 in a container with one CPU, with 10 to 5010 refs in the checkout, packed
(`git pack-refs --all`) and loose, and five concurrent claim reads. A command that overlapped a live temporary
ref failed in about 0.1 to 1.0 of 100 cases (`git log --all`, `git rev-list --all`); `git fetch origin` in none
of about 1000 overlapping cases (upper bound below 0.4 %). The rate shows no dependence on the number of refs
and tends to be lower with loose refs. Only tools that fire ref-enumerating commands in tight succession
(pollers) are affected noticeably: at 227 to 1010 refs about 1.1 to 1.7 % of the claim reads broke one call of
the loop (1.6 % at 1010 packed refs, 0.7 % at 5010 packed, 0.3 % and 0 % at 1010 and 5010 loose).

What to do: repeat the command. Scripts that call Git often should retry once on exactly that message.
`git status`, `git commit`, `git for-each-ref` and `git push` were not affected in the first measurement and
were not re-checked in the second. `git gc --prune=now` during a claim read can in addition fail the claim read
itself; the default `gc` does not.

Two caveats on the measurement: the fixture of the second measurement had 10 standard refs beside the bulk refs,
not 14 as the first report said; and at 5010 loose refs the temporary ref's lifetime grows to about 63 ms, where
the everyday rate of a randomly started command was not measured. The thresholds were set on the conditional rate
and the poller rate, and both fell with more refs.

Our own concurrent claim reads do not break each other: the claim fetch tolerates a sibling read's temporary ref
(`GIT_REF_PARANOIA=0` on that fetch only), measured at 0 of 1000 after the change against 2 to 9 of 1000 before.

## A timed-out Git call hides Git's own message

When a Git call exceeds its attempt timeout while a helper process it started still holds the error stream, the
reported reason says `timed out` and omits what Git itself wrote. The status and exit code are right; only the
text is poorer. Open; the fix is a follow-up.

## Linux only

Linux containers were qualified. macOS, Windows and NFS were not measured at all, and the tests that upstream runs
on Windows show failures unrelated to claims in upstream's own baseline.
