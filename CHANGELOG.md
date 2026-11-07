# Changelog

## 0.1.0 (2026-11-06)

First release (do-it 1.1 epic I1, decision D1: public).

- Marketplace renamed `init-it` (was `devotts`, which clashed with the do-it hub); README install section.

- `/init-it`: register a session against `docs/implementations/<name>` (status.json `sessions[]` via build-it's status-write, open ledger card, INDEX row with the new `Impl` column), `--role`, `--none`, `--rename` (hint only), `--allow-done`.
- `ledger.mjs`: tolerant card reader (legacy cards without `implementation` read as unknown), `classifyCard` ("stale open" after 24 h).
- Test contract T-A-01..T-A-20 (T-A-14/15 in conclude-it), plus adversarial suite.

---
_Authored by [DevOtts](https://github.com/DevOtts)._
