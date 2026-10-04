# Qualification evidence

The three reports in this directory back [QUALIFICATION.md](../../../src/claims/QUALIFICATION.md), one per storage
format: [REPORT-blob.md](REPORT-blob.md), [REPORT-tree.md](REPORT-tree.md),
[REPORT-commit-chain.md](REPORT-commit-chain.md). Each lists every check that ran for its format with its
combinations, what was injected, what was observed, and where in the archived run the evidence lies. This file
explains the stack the checks ran on and how a run was evaluated, so the reports can be read without the harness.

## What ran

One compose stack per run, on one Linux test machine, with an internal network and no published ports:

- **server**: a plain Git server as one container. git daemon on `git://`; `git http-backend` behind a CGI bridge
  on `http://` and, with a private CA, on `https://`; OpenSSH on a high port with key authentication; everything
  as an unprivileged user. The same container exposes a control API that the driver uses to arm push gates
  (server hooks that hold the first pushes to a ref until released), to take and restore snapshots of a bare
  repository, to rewrite a stored document, to run maintenance, and to count its own processes.
- **gitea**: Gitea 1.24.7 rootless, digest-pinned per run, with its HTTP server and its built-in SSH server. One
  organisation, one repository per check. No gates: Gitea has no hook the harness could hold, so the checks that
  need a held push run on the plain server only; the reports say which.
- **proxy**: toxiproxy 2.11.0, one proxy per server and transport that a check fronts. The driver cuts the
  connection, stalls it with the data held, or adds latency and a bandwidth limit on both streams.
- **client-a, client-b, client-c**: each a small HTTP executor that spawns the shipped `backlog` CLI, and for the
  parity checks `backlog mcp start`, in its own project directory. The executors never interpret a claim
  document; they run the product and report what happened. libfaketime shifts the clock of a single client where
  a check asks for it. Credentials never sit in a URL: SSH keys and a Git askpass script that reads a token at
  call time, so no secret appears in captured output.
- **driver**: runs the frozen scenario files with Bun's test runner and drives the executors over HTTP.

Versions, identical in every official archive: Git 2.47.3 on the server and the clients, OpenSSH 10.0p2,
Gitea 1.24.7, toxiproxy 2.11.0, Bun 1.3.14, libfaketime 0.9.10. Per container: one CPU, 1 GiB of memory, 256
processes, read-only root filesystem.

## How a run was evaluated

Every run leaves an archive with the test log, one JSON line per run and per check (`K20-RUN`, `K20-ROW`), one
document per step, the raw outputs of every product call, the effective compose file and the product source as a
tarball. An evaluator script, frozen by sha256 and recorded by the driver in every archive, recomputes the
verdict from that archive:

- every expected check for every combination and repetition is present and passed;
- the scenario files match ten frozen hashes;
- the product in the archive is byte-equal to the named revision, compared by Git blob hash;
- a leak scan with eight needles over every captured output finds nothing;
- clock checks, where the check shifted a client, are off on exactly the shifted steps and nowhere else;
- harness faults (lines starting with `K20-HARNESS`) count as problems of the run, never as findings about the
  product.

A stage counted only after a guard run, with the harness deliberately broken in one place, turned exactly the
predicted checks red and nothing else. The reports list those guard runs beside the official ones.

## Identifiers you will meet in the reports and archives

| identifier | meaning |
| --- | --- |
| `K20` | The project-internal name of this qualification matrix. It has no further meaning. The text calls it the qualification matrix; the archives, run names and log markers keep the letters. |
| `K20a`, `K20b`, `K20c`, `K20c-size` | The four stages as the archives and run names spell them: stage A (smoke per combination, acquire races, transfer, formats, preflight), stage B (lost replies and network loss, batch reclaim, CLI and MCP parity, secrets in output), stage C (clock skew and late writes, restore and new epochs, incompatible data, `enabled: false`, sizes up to 100 claims) and the size run (1000 claims, a bandwidth-limited link). |
| `k20a-native2`, `k20b-green2`, `k20c-final1`, `k20c-size3`, … | Run names: the stage, then a label of the run. The reports say which runs are official and which were guard runs, repeats or stopped runs. |
| `K20`, `K20-ROW`, `K20-RUN`, `K20-HARNESS`, `K20-LEAK` | The first word of the JSON lines in a run's `tests.log`: one `K20` line per step, one `K20-ROW` per check, one `K20-RUN` per run, `K20-HARNESS` for a harness fault, `K20-LEAK` for the leak scan. "`K20` steps" in an evidence pointer means the step lines of that check. |
| `k20.py` | The evaluator script. Each report's last section names it by sha256. |
| `S-01`, `P1-01` … `P7-04b` | Row identifiers: `S-01` is the matrix smoke row, `P1` to `P7` are the seven test packages, each row frozen with the scenario files. `S1` to `S15`, without a hyphen, are the scenarios of [CLAIMS.md](../../../CLAIMS.md). |
| `H-9`, `H-10`, `H-12` | Harness defects met during the qualification, numbered in the order found; section 5 of each report describes them. |
| `Q-12`, `O-02`, `F9`, `CLAIM-…` | References into the contract the rows were frozen against. The contract is not part of this repository. |

## What is here and what is not

The reports are here. The archives (logs, step documents, raw outputs), the harness (compose files, server image,
executor, driver, scenario files) and the evaluator are not part of this repository. The hashes that identify the
evaluator and the scenario files are recorded in each report's last section, so an archive can be checked against
them if it is shared.
