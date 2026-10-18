# Changelog

## 0.1.0 (unreleased, for do-it 1.0.1)

- `/init-it`: register a session against `docs/implementations/<name>` (status.json `sessions[]` via build-it's status-write, open ledger card, INDEX row with the new `Impl` column), `--role`, `--none`, `--rename` (hint only), `--allow-done`.
- `ledger.mjs`: tolerant card reader (legacy cards without `implementation` read as unknown), `classifyCard` ("stale open" after 24 h).
- Test contract T-A-01..T-A-20 (T-A-14/15 in conclude-it), plus adversarial suite.

---
_Authored by [DevOtts](https://github.com/DevOtts)._
