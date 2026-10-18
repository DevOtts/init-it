// Binding test contract T-A-01..T-A-20 (CARD-A section 9), init-it side.
// T-A-14 and T-A-15 run in the conclude-it repo (scripts/ledger-card.test.mjs), where that code lives.
// Authored by DevOtts (https://github.com/DevOtts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO, FIXTURE, mkFixture, run, runAsync, statusFile, readStatus, indexText, cardsFor, validate,
} from './helpers.mjs';
import { readCard, classifyCard, splitCells, upsertIndex, indexRow } from '../plugins/init-it/scripts/ledger.mjs';

const LEGACY_ROWS = (text) => text.split('\n').filter((l) => l.includes('legacy-'));
const rowsFor = (text, sid, fx) => {
  const cards = cardsFor(fx, sid).map((p) => path.relative(path.join(fx.root, '.agents', 'history'), p));
  return text.split('\n').filter((l) => cards.some((c) => l.includes(`](${c})`)));
};

test('T-A-01 register on alpha --role build adds one build session with started_at', () => {
  const fx = mkFixture();
  const r = run(fx, ['alpha', '--role', 'build']);
  assert.equal(r.code, 0, r.err);
  const s = readStatus(fx, 'alpha').sessions;
  assert.equal(s.length, 1);
  assert.equal(s[0].role, 'build');
  assert.equal(s[0].session_id, 'sess-0001');
  assert.equal(s[0].alias, 'claudinho');
  assert.match(s[0].started_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
  assert.match(r.out, /^registered sess-0001 as build on alpha; open card \.agents\/history\/claudinho\/2026-10-18--alpha-build\.md$/m);
});

test('T-A-02 running twice keeps one entry, one open card, one INDEX row', () => {
  const fx = mkFixture();
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(cardsFor(fx, 'sess-0001').length, 1);
  assert.equal(rowsFor(indexText(fx), 'sess-0001', fx).length, 1);
});

test('T-A-03 same session re-run with --role review updates the role, no duplicate', () => {
  const fx = mkFixture();
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  const r = run(fx, ['alpha', '--role', 'review']);
  assert.equal(r.code, 0, r.err);
  assert.doesNotMatch(r.err, /role stays/);
  const s = readStatus(fx, 'alpha').sessions;
  assert.equal(s.length, 1);
  assert.equal(s[0].role, 'review');
  const cards = cardsFor(fx, 'sess-0001');
  assert.equal(cards.length, 1);
  assert.match(fs.readFileSync(cards[0], 'utf8'), /^tags: \[init-it, review\]$/m);
  const rows = rowsFor(indexText(fx), 'sess-0001', fx);
  assert.equal(rows.length, 1);
  assert.match(rows[0], /\| init-it, review \|/);
});

test('T-A-04 unknown name exits 2 and lists the valid names on stderr', () => {
  const fx = mkFixture();
  const before = indexText(fx);
  const r = run(fx, ['gamma']);
  assert.equal(r.code, 2);
  assert.match(r.err, /valid implementations: alpha, beta, broken/);
  assert.doesNotMatch(r.err, /old-impl|later/);
  assert.equal(indexText(fx), before);
});

test('T-A-05 a 0-done (or 1-backlog) target exits 2 unless --allow-done', () => {
  const fx = mkFixture();
  const before = fs.readFileSync(statusFile(fx, '0-done/old-impl'));
  for (const t of ['0-done/old-impl', 'old-impl', '@docs/implementations/0-done/old-impl/', '1-backlog/later']) {
    const r = run(fx, [t, '--role', 'build']);
    assert.equal(r.code, 2, t);
    assert.match(r.err, /--allow-done/);
  }
  assert.deepEqual(fs.readFileSync(statusFile(fx, '0-done/old-impl')), before);
  const ok = run(fx, ['0-done/old-impl', '--role', 'conclude', '--allow-done']);
  assert.equal(ok.code, 0, ok.err);
  assert.equal(readStatus(fx, '0-done/old-impl').sessions.length, 1);
});

test('T-A-06 missing session id writes "unknown", warns, exits 0', () => {
  const fx = mkFixture();
  const r = run(fx, ['alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: undefined });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: session id unknown/);
  assert.equal(readStatus(fx, 'alpha').sessions[0].session_id, 'unknown');
  assert.match(fs.readFileSync(cardsFor(fx, 'unknown')[0], 'utf8'), /^session_id: unknown$/m);
});

test('T-A-06b missing alias writes "unknown" and warns; never guesses from the default config dir', () => {
  const fx = mkFixture();
  const r = run(fx, ['alpha', '--role', 'build'], { INIT_IT_ALIAS: undefined, CLAUDE_CONFIG_DIR: undefined });
  assert.equal(r.code, 0, r.err);
  assert.match(r.err, /warning: alias unknown/);
  assert.equal(readStatus(fx, 'alpha').sessions[0].alias, 'unknown');
  assert.ok(fs.existsSync(path.join(fx.root, '.agents/history/unknown/2026-10-18--alpha-build.md')));
  const anm = mkFixture();
  assert.equal(run(anm, ['alpha'], { INIT_IT_ALIAS: undefined, CLAUDE_CONFIG_DIR: '/Users/x/.claude-anm' }).code, 0);
  assert.equal(readStatus(anm, 'alpha').sessions[0].alias, 'claudeanm');
  const dflt = mkFixture();
  fs.mkdirSync(path.join(dflt.home, '.claude'));
  fs.writeFileSync(path.join(dflt.home, '.claude', 'init-it.json'), '{"default_alias":"claudinho"}');
  assert.equal(run(dflt, ['alpha'], { INIT_IT_ALIAS: undefined, CLAUDE_CONFIG_DIR: undefined }).code, 0);
  assert.equal(readStatus(dflt, 'alpha').sessions[0].alias, 'claudinho');
});

test('T-A-07 missing status.json is created minimal (schema 1, no waves, created_by init-it)', () => {
  const fx = mkFixture();
  const r = run(fx, ['beta', '--role', 'plan']);
  assert.equal(r.code, 0, r.err);
  const doc = readStatus(fx, 'beta');
  assert.equal(doc.schema, 1);
  assert.equal(doc.created_by, 'init-it');
  assert.deepEqual(doc.waves, []);
  assert.equal(doc.sessions.length, 1);
  assert.equal(validate(statusFile(fx, 'beta')).status, 0);
  assert.match(r.out, /created docs\/implementations\/beta\/status\.json/);
});

test('T-A-08 invalid JSON exits 3, leaves the file untouched and names it', () => {
  const fx = mkFixture();
  const f = statusFile(fx, 'broken');
  const before = fs.readFileSync(f);
  const r = run(fx, ['broken', '--role', 'build']);
  assert.equal(r.code, 3);
  assert.ok(r.err.includes(f), r.err);
  assert.deepEqual(fs.readFileSync(f), before);
  assert.equal(cardsFor(fx, 'sess-0001').length, 0);
});

test('T-A-09 kill after the temp write, before rename: status.json byte-identical, valid, no card', () => {
  const fx = mkFixture();
  const f = statusFile(fx, 'alpha');
  const before = fs.readFileSync(f);
  const r = run(fx, ['alpha', '--role', 'build'], { STATUS_WRITE_TEST_CRASH: 'after-tmp' });
  assert.notEqual(r.code, 0);
  assert.deepEqual(fs.readFileSync(f), before);
  JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.equal(cardsFor(fx, 'sess-0001').length, 0);
  // recovery is re-running (CARD-A: resume = T-A-02)
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
});

test('T-A-09b kill between card temp write and rename: session list valid, re-run heals card + row', () => {
  const fx = mkFixture();
  const idx = indexText(fx);
  const r = run(fx, ['alpha', '--role', 'build'], { INIT_IT_TEST_CRASH: 'after-card-tmp' });
  assert.equal(r.code, 137);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(cardsFor(fx, 'sess-0001').length, 0);
  assert.equal(indexText(fx), idx);
  const again = run(fx, ['alpha', '--role', 'build']);
  assert.equal(again.code, 0, again.err);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(cardsFor(fx, 'sess-0001').length, 1);
  assert.equal(rowsFor(indexText(fx), 'sess-0001', fx).length, 1);
});

test('T-A-10 parallel calls with different session ids all land; status.json and INDEX stay valid', async () => {
  const fx = mkFixture();
  const N = 6;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => runAsync(fx, ['alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: `par-${i}` })));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const doc = readStatus(fx, 'alpha');
  assert.equal(doc.sessions.length, N);
  assert.deepEqual(doc.sessions.map((s) => s.session_id).sort(), Array.from({ length: N }, (_, i) => `par-${i}`).sort());
  assert.equal(validate(statusFile(fx, 'alpha')).status, 0);
  const text = indexText(fx);
  for (let i = 0; i < N; i++) assert.equal(rowsFor(text, `par-${i}`, fx).length, 1, `par-${i}`);
  assert.equal(text.split('\n').filter((l) => /^\| date \| alias \| project \| impl \|/.test(l)).length, 1);
  assert.equal(fs.readdirSync(path.join(fx.root, '.agents', 'history')).filter((f) => f.includes('.lock') || f.endsWith('.tmp')).length, 0);
});

test('T-A-11 open card header has implementation: [alpha], status: open and every legacy field', () => {
  const fx = mkFixture();
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  const text = fs.readFileSync(cardsFor(fx, 'sess-0001')[0], 'utf8');
  assert.match(text, /^implementation: \[alpha\]$/m);
  assert.match(text, /^status: open$/m);
  const c = readCard(text);
  for (const k of ['session', 'alias', 'session_id', 'project', 'cwd', 'date', 'status', 'tags']) assert.ok(c.fields[k], k);
  assert.equal(c.fields.session, 'alpha-build');
  assert.equal(c.fields.date, '2026-10-18');
  assert.deepEqual(c.implementation, ['alpha']);
  assert.ok(text.split('\n').length <= 40);
});

test('T-A-12 INDEX: new row has the Impl column; the 3 legacy rows are unchanged byte for byte', () => {
  const fx = mkFixture();
  const before = indexText(fx);
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(run(fx, ['beta', '--role', 'plan'], { CLAUDE_CODE_SESSION_ID: 'sess-0002' }).code, 0);
  const after = indexText(fx);
  assert.deepEqual(LEGACY_ROWS(after), LEGACY_ROWS(before));
  assert.ok(after.includes(before.slice(before.indexOf('| date | alias | project | session |'))), 'legacy table kept whole');
  const row = rowsFor(after, 'sess-0001', fx)[0];
  const cells = splitCells(row);
  assert.equal(cells.length, 8);
  assert.equal(cells[3], 'alpha');
  assert.equal(cells[5], 'open');
  const lines = after.split('\n');
  const hdr = lines.findIndex((l) => l.startsWith('| date | alias | project | impl |'));
  const legacyHdr = lines.findIndex((l) => l.startsWith('| date | alias | project | session |'));
  assert.ok(hdr >= 0 && hdr < legacyHdr, 'Impl table sits above the legacy table (newest first)');
  assert.equal(lines.filter((l) => l.startsWith('| date | alias | project | impl |')).length, 1);
});

test('T-A-12b an old-layout INDEX (capitalised header, long separators, .agents/history link prefix) is kept byte for byte', () => {
  const legacy = '# Session History Index — ANM\nOne line per session.\n\n| Date | Alias | Project | Session | Status | Tags | Summary |\n|------|-------|---------|---------|--------|------|---------|\n| 2026-10-16 | claudeanm | ANM | [x](.agents/history/claudeanm/2026-10-16--x.md) | done | a,b | s |\n';
  const row = indexRow({ date: '2026-10-18', alias: 'claudeanm', project: 'ANM', impl: 'alpha', session: 'alpha-build', link: 'claudeanm/2026-10-18--alpha-build.md', status: 'open', tags: 'init-it, build', summary: 'open' });
  const out = upsertIndex(legacy, { link: 'claudeanm/2026-10-18--alpha-build.md', row, project: 'ANM' });
  assert.ok(out.endsWith(legacy.slice(legacy.indexOf('| Date |'))));
  assert.ok(out.startsWith('# Session History Index — ANM\nOne line per session.\n\n| date | alias | project | impl |'));
  // an update of a row linked with the .agents/history prefix replaces that row, not a second one
  const upd = upsertIndex(legacy, { link: 'claudeanm/2026-10-16--x.md', row: '| new |', project: 'ANM' });
  assert.equal(upd.split('\n').filter((l) => l.includes('| new |')).length, 1);
  assert.equal(upd.split('\n').filter((l) => l.includes('2026-10-16--x')).length, 0);
});

test('T-A-13 a legacy card without implementation reads as unknown and never throws', () => {
  const hist = path.join(FIXTURE, '.agents', 'history');
  const one = readCard(fs.readFileSync(path.join(hist, 'claudinho', '2026-09-01--legacy-one.md'), 'utf8'));
  assert.equal(one.implementation, 'unknown');
  assert.equal(one.status, 'concluded');
  const two = readCard(fs.readFileSync(path.join(hist, 'claudinho', '2026-09-02--legacy-two.md'), 'utf8'));
  assert.equal(two.fields.summary, 'deployed: api v2: done');
  assert.equal(two.implementation, 'unknown');
  const three = readCard(fs.readFileSync(path.join(hist, 'claudeanm', '2026-09-03--legacy-three.md'), 'utf8'));
  assert.equal(three.status, 'done-with-residuals');
  for (const junk of ['', 'no frontmatter', '---\nsession: x\n', '---\n: bad\nimplementation: \n---\n', '---\nimplementation: [a, b] # two\n---\n']) {
    assert.doesNotThrow(() => readCard(junk));
  }
  assert.deepEqual(readCard('---\nimplementation: [a, b] # two\n---\n').implementation, ['a', 'b']);
  assert.deepEqual(readCard('---\nimplementation: []\n---\n').implementation, []);
});

test('T-A-16 mod fixture: an open card 30 h old with no conclude reports "stale open"', () => {
  const hist = path.join(FIXTURE, '.agents', 'history', 'claudinho');
  const stale = readCard(fs.readFileSync(path.join(hist, '2026-10-08--beta-build.md'), 'utf8'));
  assert.equal(classifyCard(stale, Date.parse(stale.opened_at) + 30 * 3600e3), 'stale-open');
  const fresh = readCard(fs.readFileSync(path.join(hist, '2026-10-10--alpha-plan.md'), 'utf8'));
  assert.equal(classifyCard(fresh, Date.parse(fresh.opened_at) + 3600e3), 'open');
  assert.equal(classifyCard({ status: 'open', date: '2026-10-01' }, Date.parse('2026-10-03T00:00:00')), 'stale-open');
  assert.equal(classifyCard({ status: 'concluded' }), 'concluded');
  assert.equal(classifyCard({ status: 'shipped' }), 'concluded');
});

test('T-A-17 --none writes no status.json and a card with implementation: []', () => {
  const fx = mkFixture();
  const impls = path.join(fx.root, 'docs', 'implementations');
  const snap = () => ['alpha', 'broken', '0-done/old-impl'].map((n) => fs.readFileSync(path.join(impls, n, 'status.json'), 'utf8'));
  const before = snap();
  const r = run(fx, ['--none', '--role', 'other']);
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(snap(), before);
  assert.equal(fs.existsSync(path.join(impls, 'beta', 'status.json')), false);
  const text = fs.readFileSync(cardsFor(fx, 'sess-0001')[0], 'utf8');
  assert.match(text, /^implementation: \[\]$/m);
  assert.match(r.out, /registered sess-0001 as other on none;/);
});

test('T-A-18 --rename on a host without rename support: exit 0, one "rename skipped: host" line', () => {
  const fx = mkFixture();
  const r = run(fx, ['alpha', '--role', 'build', '--rename']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.trim().split('\n');
  assert.equal(lines.filter((l) => l.startsWith('rename skipped: host')).length, 1);
  assert.equal(lines.length, 2);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
});

test('T-A-19 the init-it repo makes no network and no model calls', () => {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === '.git' || e.name === 'node_modules' || e.name === 'fixtures') continue; const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(m?js|cjs|sh|py)$/.test(e.name) && !p.endsWith('init-it.test.mjs')) files.push(p); } };
  walk(REPO);
  assert.ok(files.some((f) => f.endsWith('init-it.mjs')));
  const bad = [
    /from\s+['"]node:(http|https|net|tls|dgram|dns|http2)['"]/, /require\(['"](node:)?(http|https|net|tls|dgram|dns|http2)['"]\)/,
    /\bfetch\s*\(/, /\bWebSocket\b/, /\bXMLHttpRequest\b/, /\bcurl\b|\bwget\b/, /anthropic|openai|claude\s+-p|api\.\w+\.com/i,
    /https?:\/\/(?!github\.com\/DevOtts)/,
  ];
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    for (const re of bad) assert.doesNotMatch(src, re, `${path.relative(REPO, f)} matches ${re}`);
  }
  const imports = files.flatMap((f) => [...fs.readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]));
  for (const m of imports) assert.ok(m.startsWith('node:') || m.startsWith('.'), `non-builtin import ${m}`);
});

test('T-A-20 sibling diffs: session-init untouched, plan-it changed only in the listed file', () => {
  const ev = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'sibling-changes.json'), 'utf8'));
  const allowed = {
    'plan-it': ['plugins/plan-it/skills/plan-it/SKILL.md', 'SKILL.md'],
    'conclude-it': ['plugins/conclude-it/skills/conclude-it/SKILL.md', 'plugins/conclude-it/skills/conclude-it/scripts/ledger-card.mjs', 'plugins/conclude-it/skills/conclude-it/scripts/ledger-card.test.mjs'],
    'build-it': ['plugins/build-it/skills/build-it/SKILL.md', 'plugins/build-it/scripts/status/status-write.mjs', 'plugins/build-it/scripts/status/README.md', 'tests/status/session-init-it.test.mjs'],
    'review-it': ['plugins/review-it/skills/review-it/SKILL.md', 'SKILL.md'],
  };
  assert.deepEqual(Object.keys(ev.repos).sort(), Object.keys(allowed).sort(), 'only the four listed siblings changed');
  for (const [repo, files] of Object.entries(ev.repos)) {
    for (const f of files) assert.ok(allowed[repo].includes(f), `${repo}: ${f} is outside the listed files`);
  }
  const allFiles = Object.values(ev.repos).flat();
  assert.ok(!allFiles.some((f) => /(^|\/)session-init(\/|$)/.test(f)), 'session-init is never touched');
  assert.ok(!Object.keys(ev.repos).includes('session-init'));
  const src = fs.readFileSync(path.join(REPO, 'plugins', 'init-it', 'scripts', 'init-it.mjs'), 'utf8') + fs.readFileSync(path.join(REPO, 'plugins', 'init-it', 'scripts', 'ledger.mjs'), 'utf8');
  assert.doesNotMatch(src, /session-init/);
});
