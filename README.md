# init-it

Tell the harness which implementation this Claude Code session is about. One deterministic script, no context boot (that is `/session-init`), no network, no model calls, zero dependencies (Node 18+).

```
/init-it @docs/implementations/<name>        # register, open card, INDEX row
/init-it <name> --role build                 # plan | build | review | conclude | other
/init-it <name> --rename                     # prints the /rename hint (no scripted rename exists)
/init-it --none                              # this session is not about an implementation
```

What one run writes:

1. `docs/implementations/<name>/status.json` `sessions[]`: one entry, through build-it's single writer (`status-write session add --by init-it`). Idempotent per `session_id`; a second run with another role updates the role.
2. `.agents/history/<alias>/<date>--<name>-<role>.md`: an open ledger card with `status: open`, `implementation: [<name>]`, `opened_at`.
3. `.agents/history/INDEX.md`: one row in the 8-column table (`Impl` between Project and Session). Legacy rows are never rewritten; see `DECISIONS.md` D-02.

`/conclude-it` Step 2.5 later rewrites that same card in place and sets `ended_at` (conclude-it's `scripts/ledger-card.mjs`). build-it (run start) and review-it (preflight) call this script by path with `--role build` / `--role review`. plan-it prints `run /init-it <name> --role build` in its hand-off.

## Layout

| Path | What |
|---|---|
| `plugins/init-it/scripts/init-it.mjs` | CLI and the exported `register()` routine |
| `plugins/init-it/scripts/ledger.mjs` | card reader (`readCard`, `classifyCard` for "stale open"), INDEX upsert, lock, atomic write |
| `plugins/init-it/skills/init-it/SKILL.md` | the skill |
| `test/` | `node --test` suites; `test/fixtures/repo` is the fixture ledger (3 legacy cards, 1 open, 1 stale open) |
| `DECISIONS.md` | defaults taken where the spec was silent or in conflict |

## Environment

| Variable | Use |
|---|---|
| `CLAUDE_CODE_SESSION_ID` | session id (missing → `"unknown"` + warning) |
| `CLAUDE_CONFIG_DIR` | alias: `~/.claude-anm` → `claudeanm` |
| `INIT_IT_ALIAS` | explicit alias override |
| `~/.claude/init-it.json` | `{"default_alias": "claudinho"}` for the default config dir |
| `DOIT_STATUS_WRITE` | path to build-it's `status-write.mjs` (else the newest installed build-it) |

## Tests

```
DOIT_STATUS_WRITE=<build-it>/plugins/build-it/scripts/status/status-write.mjs npm test
```

Needs a build-it with init-it support in status-write (`session add --create`, role update): build-it PR "init-it support".

---
_Authored by [DevOtts](https://github.com/DevOtts)._
