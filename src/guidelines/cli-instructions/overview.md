## Backlog.md Overview (CLI)

Backlog.md tracks committed work: what will be built, fixed, or changed.

### When to Use Backlog

Create a task when work requires planning, decisions, or handoff notes. Search for an existing task first. Skip task creation for questions, exploration, and obvious mechanical edits.

### Find and Read Work

- `backlog search "query" --plain`
- `backlog task list --status "<todo status>" --plain`
- `backlog task list --status "<active status>" --plain`
- `backlog task list --search "login" --labels frontend,bug --limit 20 --plain`
- `backlog task view {{TASK_ID:123}} --plain`

For long lists, use `--max-count` and `--skip`, follow the printed `Next` command, or use `--count` for the total; command help covers the details.

For scripts, `task list`, `task view`, `task <id>`, and `search` accept versioned `--json` output instead of `--plain`. `task list --json --watch` emits complete replacement responses; read successive JSON values, not individual lines. Filters and local scope are unchanged; intermediate edits may be coalesced. Restart for a fresh snapshot. Add `--revision` to `task list --json` (also with `--watch`) to get a `revision` per task: `sha256:` plus the SHA-256 of the task file, or `null` if the file vanished while listing. Compare revisions between reads; never infer fields from them. `--revision` reports what this working copy holds. It is not a watch engine and does not capture every foreign change: edits on other branches or remotes appear only once they reach this working copy, and `--watch` may coalesce intermediate edits.

### Required Guides

Read the matching guide before taking these actions; this overview does not replace it:

- `backlog instructions task-creation` — before creating or splitting tasks
- `backlog instructions task-execution` — before planning, changing status or assignee, adding notes, or implementing
- `backlog instructions task-finalization` — before checking acceptance criteria, writing final summaries, or marking work finished

If the project configures ticket claims (a `claims:` block in its configuration), read `backlog instructions claims` before acquiring, renewing, transferring, or reclaiming a claim. A claim records which agent holds a ticket right now; it is not the assignee and never changes the task.

Use `backlog <command> --help` before unfamiliar operations. Help describes fields, output, and examples.

### Task Lifecycle

Mark finished work Done (or the configured final status). During periodic cleanup, use Complete (`backlog task complete {{TASK_ID:123}}`) to move it off the board while preserving its record and dependency links.

Use Archive (`backlog task archive {{TASK_ID:123}}`) for canceled, duplicate, or invalid work. Archiving removes incoming dependencies and task references.

Use the CLI for Backlog changes. Never edit task, draft, document, decision, or milestone markdown files directly; commands preserve metadata, relationships, and history.
