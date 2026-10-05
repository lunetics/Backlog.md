# Claims: scope

What this fork's claims feature is, what it deliberately is not, and how it relates to upstream Backlog.md.

## In scope

- One valid claim per ticket, recorded in a shared Git coordination area that every participant can push to,
  reached over `git://`, `ssh://`, `http(s)://` or `file://`. Claims never live in the task file: claim commands
  never change a task's status, assignee or content, and never commit.
- Every change is one atomic, conditional write. An acquire lands only if the ticket is still free, a renew only
  if the claim is still yours. The loser ends `rejected`; nothing is overwritten.
- Three lifetime modes (`lease`, `hard`, `none`); reclaim after the lease or hard end plus grace; hand-over to
  another context (transfer) and resume; bound changes over a witnessed time path; ready selection (`claim next`)
  with a dependency policy; batch reclaim with a preview; emergency release; a controlled new-epoch procedure
  after a restore of the coordination area.
- Identity is a private context directory, never a name. `--owner` is a display name for people and reports.
- Three storage formats (`blob`, `tree`, `commit-chain`) behind one contract. The format is a setup choice, not
  a runtime one.
- Machine-readable output for every command: JSON with a schema version, a status, an exit code and, on failure,
  an error code. Agents read the JSON; the text is for people.
- Surfaces: the CLI is canonical. MCP tools are an adapter over the same operations. The browser shows the claim
  owner beside a task. `backlog instructions claims` is the agent-facing reference.
- Claims assume cooperating writers. Anyone with push access to the coordination area can break them, as with any
  shared branch; access control is the host's job.

The worked workflows are in [CLAIMS.md](../../CLAIMS.md). The reference is `backlog instructions claims`.

## Out of scope

[CLAIMS.md](../../CLAIMS.md), section "What claims do not do", is the binding list. Its headings:

- No fencing. A claim is no permission for an external effect.
- No scheduler. No queue, no fairness, no heartbeats on your behalf.
- No worker stopping. A former holder keeps running until its next `renew` or `list`.
- No offline exclusivity. A claim is only as current as the last read of the coordination area.
- No clock check beyond the configured `clock_uncertainty_ms`.
- No protection against direct Git manipulation. Claims assume cooperating writers.
- No automatic reassignment after an emergency release.
- No quiescence proof. Nothing shows that every writer has stopped.
- No task changes.
- No watch engine. `--revision` reports what this working copy holds.
- `enabled: false` only stops new claims.
- No transaction over several tickets.
- No time-box extension outside the time path.

## What was not tested

The feature was tested on Linux containers against a plain Git server and Gitea. Not tested:

- GitHub, GitLab, Forgejo, and other versions of Git, OpenSSH or Gitea than the ones used.
- macOS, Windows and NFS.
- `git://` in production.
- `clock_uncertainty_ms` above 2000.
- A Git credential helper for HTTP authentication.
- Hosts that isolate the write paths for you; replicas and mirrors; older clients; a restore without the
  new-epoch procedure; retention of journal slots; more than 1000 claims.

What was tested, with the bounds and the full reports: the [evidence repository](https://github.com/lunetics/backlog-md-claims-qualification).
A sentence in the documentation that no measurement covers is labelled there, not softened.

## Relation to upstream

- The base is upstream `main` at `69e7b15` (2026-10-03). The claims work sits on top of it as a short series of
  commits, each with its own tests.
- This fork does not replace upstream Backlog.md and is not an upstream pull request. The scope discussion with
  upstream belongs in [upstream issue #937](https://github.com/MrLesk/Backlog.md/issues/937); this fork does not pre-empt it. Whatever upstream adopts later should
  come from here as small, reviewable changes.
- Upstream's conventions are kept: the manifesto's surface hierarchy, the CLI as the canonical surface, the
  instruction files as the public contract for agents, Biome formatting, Bun's test runner, the MIT licence.
