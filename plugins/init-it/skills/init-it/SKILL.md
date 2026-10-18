---
name: init-it
description: Register this Claude Code session against an implementation so the harness can show it live — one deterministic script, no context boot. Adds this session to docs/implementations/<name>/status.json sessions[] (through build-it's status-write, never by hand), writes an open ledger card (status open, implementation [name]) and one INDEX row, optionally prints the rename hint. Idempotent, zero network and zero model calls. Use when the user says "/init-it <name>", "register this session on <name>", "I'm working on <name>", "tag this session to the implementation", or at the top of a plan/build/review session on a docs/implementations folder. Not a context bootstrap — that is /session-init.
author: DevOtts
author_url: https://github.com/DevOtts
---

# init-it — tell the harness which implementation this session is about

One verb, one job: registration. It reads nothing for context and decides nothing.
The script does every step; you only pick the arguments and relay its output.

## Command shape

```
/init-it @docs/implementations/<name>        # register, write open card, no rename
/init-it <name> --role build                 # role: plan | build | review | conclude | other (default other)
/init-it <name> --rename                     # also print the rename hint (no scripted rename exists)
/init-it --none                              # explicit: this session is not about an implementation
/init-it 0-done/<name> --allow-done          # a closed/backlog folder needs --allow-done
```

Run it as:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/init-it.mjs" <args>
```

Pass the user's arguments through unchanged. Do not add `--session-id` or `--alias`
yourself: the script reads them from the host (`$CLAUDE_CODE_SESSION_ID`, and
`$CLAUDE_CONFIG_DIR` such as `~/.claude-anm` → `claudeanm`). A missing value is written as
`"unknown"` with a warning; never supply a guessed one.

## What the script does (in this order)

1. Resolves `<repo>/docs/implementations/<name>` (or the singular `docs/implementation/`).
   Unknown name → exit 2 with the valid names. A `0-done/` or `1-backlog/` target → exit 2
   unless `--allow-done`.
2. Writes `status.json` first, through build-it's `status-write session add --by init-it`
   (found via `DOIT_STATUS_WRITE` or the installed build-it). Same session id twice updates the
   role, never duplicates. A missing `status.json` is created minimal (schema 1, no waves,
   `created_by: "init-it"`). Invalid JSON → exit 3, file untouched.
3. Writes the open card `<repo>/.agents/history/<alias>/<date>--<name>-<role>.md`
   (`status: open`, `implementation: [<name>]`, `opened_at`) and one INDEX row in the
   8-column table (`Impl` between Project and Session). Legacy rows are never rewritten.
4. `--rename`: prints `rename skipped: host (type /rename <name>-<role> …)`. Relay it; if the
   user wants the rename, they type `/rename`.
5. Prints `registered <session_id> as <role> on <name>; open card <path>`.

## Exit codes

| Code | Meaning | What you do |
|---|---|---|
| 0 | registered | Relay the one line (and any `warning:` lines). |
| 1 | status-write refused (for example a closed board) | Quote the message. Nothing was written. |
| 2 | usage, unknown name, done/backlog target | Show the valid names; ask which one. |
| 3 | `status.json` invalid JSON, or a lock timeout | Quote it; never repair the file by hand. |
| 4 | status-write not found or too old | Install/upgrade build-it, or set `DOIT_STATUS_WRITE`. |
| 5 | `status.json` updated but the card/INDEX write failed | Re-run the same command; it heals. |

## Rules

- Never edit `status.json`, the card or INDEX.md by hand. Re-running is the recovery.
- `/conclude-it` Step 2.5 later rewrites the same card in place (`concluded`/`shipped`) and
  sets `ended_at`; an open card older than 24 hours without that reads as "stale open".
- The default config dir (`~/.claude`) has no alias of its own: set `default_alias` in
  `~/.claude/init-it.json` (for example `{"default_alias": "claudinho"}`) or the alias stays
  `"unknown"`.

---
_Authored by [DevOtts](https://github.com/DevOtts)._
