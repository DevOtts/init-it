// INIT-08 adversarial review of init-it (INIT-01, INIT-02): concurrency, crash, legacy formats, traversal.
// Run: DOIT_STATUS_WRITE=<build-it>/plugins/build-it/scripts/status/status-write.mjs node --test test/adversarial.test.mjs
// The init-it vs ledger-card race needs DOIT_LEDGER_CARD=<conclude-it>/.../scripts/ledger-card.mjs (skipped when absent).
// Authored by DevOtts (https://github.com/DevOtts).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkFixture, run, runAsync, envFor, statusFile, readStatus, indexText, validate, WRITER,
} from './helpers.mjs';
import { readCard, upsertIndex, indexRow, splitCells } from '../plugins/init-it/scripts/ledger.mjs';

const HIST = (fx) => path.join(fx.root, '.agents', 'history');
const LEGACY = (t) => t.split(/\r?\n/).filter((l) => l.includes('legacy-'));
const allCards = (fx) => {
  const out = [];
  for (const d of fs.readdirSync(HIST(fx), { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(HIST(fx), d.name))) if (f.endsWith('.md') && fs.statSync(path.join(HIST(fx), d.name, f)).isFile()) out.push(`${d.name}/${f}`);
  }
  return out.sort();
};
// like helpers.cardsFor, but tolerant of directories named *.md and of CRLF headers
const cardsFor = (fx, sid) => allCards(fx).map((c) => path.join(HIST(fx), c)).filter((p) => readCard(fs.readFileSync(p, 'utf8')).fields.session_id === sid);
const linkCell = (line) => { const c = (splitCells(line) || []).find((x) => /^\[[^\]]*\]\([^)]*\)$/.test(x)); return c ? /\]\(([^)]*)\)$/.exec(c)[1].replace(/^\.agents\/history\//, '') : null; };
const rowsByLink = (text) => {
  const m = new Map();
  for (const l of text.split(/\r?\n/)) { const k = linkCell(l); if (k) m.set(k, (m.get(k) || 0) + 1); }
  return m;
};
// The fixture ships two open cards with no INDEX row (mod fixtures); every other card has exactly one row,
// and every row points at an existing card.
const FIXTURE_ROWLESS = new Set(['claudinho/2026-10-08--beta-build.md', 'claudinho/2026-10-10--alpha-plan.md']);
function assertLedgerConsistent(fx) {
  const cards = allCards(fx);
  const rows = rowsByLink(indexText(fx));
  for (const c of cards) assert.equal(rows.get(c) || 0, FIXTURE_ROWLESS.has(c) ? 0 : 1, `card ${c} has ${rows.get(c) || 0} INDEX rows`);
  for (const [k, n] of rows) { assert.equal(n, 1, `row ${k} x${n}`); assert.ok(cards.includes(k), `row ${k} points at a missing card`); }
  assert.ok(indexText(fx).split(/\r?\n/).filter((l) => /^\| date \| alias \| project \| impl \|/.test(l)).length <= 1, 'one Impl header');
}
function residue(dir) {
  const bad = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.lock$|\.tmp$|\.stale$/.test(e.name)) bad.push(p); } };
  walk(dir);
  return bad;
}
const noResidue = (fx) => assert.deepEqual([...residue(HIST(fx)), ...residue(path.join(fx.root, 'docs'))], []);

const LEDGER_CARD = process.env.DOIT_LEDGER_CARD
  || path.join(os.homedir(), 'Workspace', 'Devotts', 'conclude-it', 'plugins', 'conclude-it', 'skills', 'conclude-it', 'scripts', 'ledger-card.mjs');
const hasLedgerCard = fs.existsSync(LEDGER_CARD);
function lcAsync(fx, args) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [LEDGER_CARD, ...args], { cwd: fx.root, env: envFor(fx) });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

// ---------- 1. concurrent writers ----------

test('ADV-01a 12 parallel init-its, different ids, two impls (one needs --create): nothing lost, no residue', async () => {
  const fx = mkFixture();
  const legacyBefore = LEGACY(indexText(fx));
  const N = 12;
  const rs = await Promise.all(Array.from({ length: N }, (_, i) => runAsync(fx, [i % 2 ? 'beta' : 'alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: `p-${i}` })));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  for (const [name, par] of [['alpha', 0], ['beta', 1]]) {
    const ids = readStatus(fx, name).sessions.map((s) => s.session_id).sort();
    assert.deepEqual(ids, Array.from({ length: N }, (_, i) => i).filter((i) => i % 2 === par).map((i) => `p-${i}`).sort());
    assert.equal(validate(statusFile(fx, name)).status, 0, name);
  }
  for (let i = 0; i < N; i++) assert.equal(cardsFor(fx, `p-${i}`).length, 1, `p-${i}`);
  assertLedgerConsistent(fx);
  assert.deepEqual(LEGACY(indexText(fx)), legacyBefore);
  noResidue(fx);
});

test('ADV-01b the same session id racing itself (8 procs, mixed roles): one entry, one card, one row', async () => {
  const fx = mkFixture();
  const roles = ['build', 'review', 'plan', 'build', 'review', 'other', 'build', 'review'];
  const rs = await Promise.all(roles.map((role) => runAsync(fx, ['alpha', '--role', role], { CLAUDE_CODE_SESSION_ID: 'same-1' })));
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const s = readStatus(fx, 'alpha').sessions;
  assert.equal(s.length, 1);
  assert.ok(roles.includes(s[0].role));
  assert.equal(validate(statusFile(fx, 'alpha')).status, 0);
  assert.equal(cardsFor(fx, 'same-1').length, 1);
  assertLedgerConsistent(fx);
  noResidue(fx);
});

test('ADV-01c init-it racing ledger-card upgrade: every card keeps exactly one row, status.json valid', { skip: !hasLedgerCard && `ledger-card not found at ${LEDGER_CARD}` }, async () => {
  const fx = mkFixture();
  const M = 5;
  for (let i = 0; i < M; i++) assert.equal(run(fx, ['alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: `u-${i}` }).code, 0);
  const body = path.join(fx.base, 'body.md');
  fs.writeFileSync(body, '**Objective:** built alpha.\n');
  const jobs = [];
  for (let i = 0; i < M; i++) {
    jobs.push(lcAsync(fx, ['upgrade', '--repo', fx.root, '--session-id', `u-${i}`, '--status', 'concluded', '--body-file', body, '--alias', 'claudinho', '--session', `alpha-build-u${i}`, '--date', '2026-10-18']));
    jobs.push(runAsync(fx, ['alpha', '--role', 'review'], { CLAUDE_CODE_SESSION_ID: `n-${i}` }));
    if (i === 0) jobs.push(runAsync(fx, ['alpha', '--role', 'review'], { CLAUDE_CODE_SESSION_ID: 'u-0' })); // re-init racing its own conclude
  }
  const rs = await Promise.all(jobs);
  for (const r of rs) assert.equal(r.code, 0, r.err);
  const doc = readStatus(fx, 'alpha');
  assert.equal(validate(statusFile(fx, 'alpha')).status, 0);
  assert.equal(doc.sessions.length, 2 * M);
  for (let i = 0; i < M; i++) {
    assert.ok(doc.sessions.find((s) => s.session_id === `u-${i}`).ended_at, `u-${i} ended`);
    const concluded = cardsFor(fx, `u-${i}`).filter((p) => /^status: concluded$/m.test(fs.readFileSync(p, 'utf8')));
    assert.equal(concluded.length, 1, `u-${i} has one concluded card`);
    assert.equal(cardsFor(fx, `n-${i}`).length, 1);
  }
  assert.ok(cardsFor(fx, 'u-0').length <= 2);
  assertLedgerConsistent(fx);
  noResidue(fx);
});

// ---------- 2. kill between temp write and rename ----------

test('ADV-02a status-write killed after tmp: status.json intact, its lock does not wedge, re-run heals with no residue', () => {
  const fx = mkFixture();
  const f = statusFile(fx, 'alpha');
  const before = fs.readFileSync(f);
  const idx = indexText(fx);
  assert.notEqual(run(fx, ['alpha', '--role', 'build'], { STATUS_WRITE_TEST_CRASH: 'after-tmp' }).code, 0);
  assert.deepEqual(fs.readFileSync(f), before);
  assert.equal(indexText(fx), idx);
  const r = run(fx, ['alpha', '--role', 'build']);
  assert.equal(r.code, 0, r.err);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(validate(f).status, 0);
  assertLedgerConsistent(fx);
  noResidue(fx);
});

for (const point of ['after-card-tmp', 'after-index-tmp']) {
  test(`ADV-02b init-it killed at ${point}: old card/INDEX intact, dead-holder lock reclaimed, re-run heals, no tmp left`, () => {
    const fx = mkFixture();
    assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0); // an existing open card that the crash must not corrupt
    const card = cardsFor(fx, 'sess-0001')[0];
    const cardBefore = fs.readFileSync(card, 'utf8');
    const idxBefore = indexText(fx);
    const r = run(fx, ['alpha', '--role', 'review'], { INIT_IT_TEST_CRASH: point });
    assert.equal(r.code, 137);
    assert.ok(fs.existsSync(path.join(HIST(fx), '.ledger.lock')), 'the killed process left its lock');
    if (point === 'after-card-tmp') assert.equal(fs.readFileSync(card, 'utf8'), cardBefore);
    assert.equal(indexText(fx), idxBefore);
    assert.equal(readCard(fs.readFileSync(card, 'utf8')).status, 'open');
    const t0 = Date.now();
    const again = run(fx, ['alpha', '--role', 'review']);
    assert.equal(again.code, 0, again.err);
    assert.ok(Date.now() - t0 < 5000, 'a dead holder lock is reclaimed at once');
    assert.equal(cardsFor(fx, 'sess-0001').length, 1);
    assert.match(fs.readFileSync(card, 'utf8'), /^tags: \[init-it, review\]$/m);
    assertLedgerConsistent(fx);
    noResidue(fx);
  });
}

test('ADV-02c a crash on a fresh session at after-index-tmp: card exists without a row; the re-run adds exactly one row', () => {
  const fx = mkFixture();
  assert.equal(run(fx, ['alpha', '--role', 'build'], { INIT_IT_TEST_CRASH: 'after-index-tmp' }).code, 137);
  assert.equal(cardsFor(fx, 'sess-0001').length, 1);
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(cardsFor(fx, 'sess-0001').length, 1);
  assertLedgerConsistent(fx);
  noResidue(fx);
});

test('ADV-02d stale ledger locks: an old lock held by a live unrelated pid, and an empty old lock, are both reclaimed', () => {
  for (const content of [`${process.pid} 1\n`, '']) {
    const fx = mkFixture();
    const lock = path.join(HIST(fx), '.ledger.lock');
    fs.writeFileSync(lock, content);
    const old = new Date(Date.now() - 120000); fs.utimesSync(lock, old, old);
    const r = run(fx, ['alpha', '--role', 'build']);
    assert.equal(r.code, 0, r.err);
    assert.equal(cardsFor(fx, 'sess-0001').length, 1);
    noResidue(fx);
  }
});

// ---------- 3. legacy cards without implementation ----------

test('ADV-03 legacy cards without implementation (open and closed, no frontmatter, junk) are scanned without error', () => {
  const fx = mkFixture();
  const d = path.join(HIST(fx), 'claudeanm');
  fs.writeFileSync(path.join(d, '2026-09-04--no-front.md'), 'just a note, no frontmatter\n');
  fs.writeFileSync(path.join(d, '2026-09-05--half.md'), '---\nsession: half\n');
  fs.mkdirSync(path.join(d, 'nested.md')); // a directory named like a card
  fs.writeFileSync(path.join(d, '2026-09-06--legacy-open.md'), '---\nsession: legacy-open\nalias: claudeanm\nsession_id: leg-1\nproject: repo\ncwd: /w\ndate: 2026-09-06\nstatus: open\ntags: [x]\n---\nhand-written open card\n');
  const r = run(fx, ['alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: 'leg-1' });
  assert.equal(r.code, 0, r.err);
  const cards = cardsFor(fx, 'leg-1');
  assert.equal(cards.length, 1, 'the legacy open card for this id is reused, not duplicated');
  assert.deepEqual(readCard(fs.readFileSync(cards[0], 'utf8')).implementation, ['alpha']);
  assert.equal(readCard('---\nsession: x\nstatus: open\n---\n').implementation, 'unknown');
});

// ---------- 4. stray colons, malformed lines, CRLF, BOM ----------

test('ADV-04a a BOM + CRLF open card with stray colons and malformed lines is found and rewritten in place', () => {
  const fx = mkFixture();
  const p = path.join(HIST(fx), 'claudinho', '2026-10-17--alpha-build.md');
  const src = ['---', 'session: alpha-build', 'alias: claudinho', 'session_id: crlf:1', 'project: repo', 'cwd: C:\\work\\repo', 'date: 2026-10-17',
    'status: open', 'this line has no key', ': empty key', 'odd key!: x', 'implementation: [alpha] # note', 'opened_at: 2026-10-17T08:00:00Z', 'tags: [init-it, build]', '---', 'body', ''].join('\r\n');
  fs.writeFileSync(p, `\uFEFF${src}`);
  const c = readCard(fs.readFileSync(p, 'utf8'));
  assert.equal(c.session_id, 'crlf:1');
  assert.equal(c.fields.cwd, 'C:\\work\\repo');
  assert.deepEqual(c.implementation, ['alpha']);
  const r = run(fx, ['alpha', '--role', 'review'], { CLAUDE_CODE_SESSION_ID: 'crlf:1' });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(cardsFor(fx, 'crlf:1'), [p]);
  const after = readCard(fs.readFileSync(p, 'utf8'));
  assert.equal(after.date, '2026-10-17');
  assert.equal(after.opened_at, '2026-10-17T08:00:00Z');
  assertLedgerConsistent(fx);
});

test('ADV-04b a session id that would forge header lines or be cut as a comment is refused, nothing written', () => {
  for (const sid of ['x\nstatus: shipped', 'abc #1', 'a\rb', ' ', 'tab\there']) {
    const fx = mkFixture();
    const before = fs.readFileSync(statusFile(fx, 'alpha'));
    const r = run(fx, ['alpha', '--session-id', sid]);
    if (sid.trim() === '') { assert.equal(r.code, 0); continue; } // blank = unknown, by contract
    assert.equal(r.code, 2, JSON.stringify(sid));
    assert.deepEqual(fs.readFileSync(statusFile(fx, 'alpha')), before);
    assert.equal(allCards(fx).length, 3 + 2);
  }
});

// ---------- 5. old INDEX layouts ----------

const OLD = (eol, trailing) => ['# Session History Index — ANM', '', '| Date | Alias | Project | Session | Status | Tags | Summary |', '|------|-------|---------|---------|--------|------|---------|',
  '| 2026-10-16 | claudeanm | ANM | [x](.agents/history/claudeanm/2026-10-16--x.md) | done | a,b | piped \\| summary |',
  '| 2026-10-15 | claudeanm | ANM | [y](claudeanm/2026-10-15--y.md) | done | a | follow-up of [z](claudinho/2026-10-18--alpha-build.md) |'].join(eol) + (trailing ? eol : '');
const ROW = (link, s = 'open') => indexRow({ date: '2026-10-18', alias: 'claudinho', project: 'ANM', impl: 'alpha', session: 'alpha-build', link, status: s, tags: 't', summary: 's' });

test('ADV-05a old layout (caps, long separators, prefixed links, CRLF, no trailing newline): legacy lines kept, one new table', () => {
  for (const eol of ['\n', '\r\n']) for (const trailing of [true, false]) {
    const legacy = OLD(eol, trailing);
    const link = 'claudinho/2026-10-18--alpha-build.md';
    const out = upsertIndex(legacy, { link, row: ROW(link), project: 'ANM' });
    assert.ok(out.endsWith(legacy.slice(legacy.indexOf('| Date |'))), 'legacy table byte for byte');
    if (eol === '\r\n') assert.equal(out.split('\r\n').join('').includes('\n'), false, 'no mixed line endings');
    assert.equal(out.split(/\r?\n/).filter((l) => l.includes('| impl |')).length, 1);
    // second upsert of the same link replaces, does not add
    const out2 = upsertIndex(out, { link, row: ROW(link, 'concluded'), project: 'ANM' });
    assert.equal(rowsByLink(out2).get(link), 1);
    assert.ok(out2.includes('| concluded |'));
    // a prefixed legacy link is updated in place
    const out3 = upsertIndex(out2, { link: 'claudeanm/2026-10-16--x.md', row: '| NEW |', project: 'ANM' });
    assert.equal(out3.split(/\r?\n/).filter((l) => l === '| NEW |').length, 1);
    assert.equal(out3.includes('2026-10-16--x.md'), false);
  }
});

test('ADV-05b a summary that quotes another card link never makes the upsert hit that row', () => {
  const legacy = OLD('\n', true);
  const link = 'claudinho/2026-10-18--alpha-build.md';
  const out = upsertIndex(legacy, { link, row: ROW(link), project: 'ANM' });
  assert.ok(out.includes('follow-up of [z](claudinho/2026-10-18--alpha-build.md)'), 'the legacy row that only quotes the link survives');
  assert.deepEqual(LEGACY(out), LEGACY(legacy));
  assert.equal(rowsByLink(out).get(link), 1);
});

test('ADV-05c no table at all, and an Impl table below a legacy table: no second Impl header', () => {
  const plain = '# notes\nfree text only';
  const link = 'claudinho/2026-10-18--alpha-build.md';
  const a = upsertIndex(plain, { link, row: ROW(link), project: 'ANM' });
  assert.ok(a.startsWith('# notes\nfree text only\n\n| date | alias | project | impl |'));
  const mixed = `${OLD('\n', true)}\n| date | alias | project | impl | session | status | tags | summary |\n|---|---|---|---|---|---|---|---|\n${ROW('claudinho/old.md')}\n`;
  const b = upsertIndex(mixed, { link, row: ROW(link), project: 'ANM' });
  assert.equal(b.split('\n').filter((l) => l.startsWith('| date | alias | project | impl |')).length, 1);
  assert.equal(rowsByLink(b).get(link), 1);
});

test('ADV-05d end to end on a CRLF INDEX with no trailing newline: legacy rows byte for byte, CRLF kept', () => {
  const fx = mkFixture();
  const f = path.join(HIST(fx), 'INDEX.md');
  const crlf = fs.readFileSync(f, 'utf8').replace(/\n/g, '\r\n').replace(/\r\n$/, '');
  fs.writeFileSync(f, crlf);
  assert.equal(run(fx, ['alpha', '--role', 'build']).code, 0);
  assert.equal(run(fx, ['alpha', '--role', 'review']).code, 0);
  const out = fs.readFileSync(f, 'utf8');
  assert.ok(out.endsWith(crlf.slice(crlf.indexOf('| date | alias | project | session |'))));
  assert.equal(out.replace(/\r\n/g, '').includes('\n'), false);
  assertLedgerConsistent(fx);
});

// ---------- probes ----------

test('ADV-06 path traversal in names and aliases is refused; nothing is written outside the repo', () => {
  const fx = mkFixture();
  const snapshot = () => JSON.stringify(allCards(fx)) + indexText(fx);
  const before = snapshot();
  for (const t of ['../x', 'alpha/../../etc', '..', '.', '0-done/..', '0-done/../alpha', '@docs/implementations/../../x', '/etc', 'alpha/', 'docs/implementations/../alpha']) {
    const r = run(fx, [t]);
    if (t === 'alpha/') { assert.equal(r.code, 0, r.err); continue; }
    assert.equal(r.code, 2, `${t}: ${r.err}`);
  }
  const fx2 = mkFixture();
  for (const a of ['../x', 'alpha/../../etc', 'a b', '.']) {
    const r = run(fx2, ['alpha', '--alias', a]);
    assert.equal(r.code, 2, a);
  }
  assert.equal(fs.existsSync(path.join(fx2.root, '.agents', 'x')), false);
  assert.equal(fs.existsSync(path.join(fx.base, 'x')), false);
  assert.ok(before.length > 0);
});

test('ADV-07 --none with a name is refused; --none twice is idempotent; unknown id twice is idempotent', () => {
  const fx = mkFixture();
  const r = run(fx, ['alpha', '--none']);
  assert.equal(r.code, 2);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 0);
  assert.equal(run(fx, ['--none']).code, 0);
  assert.equal(run(fx, ['--none']).code, 0);
  assert.equal(cardsFor(fx, 'sess-0001').length, 1);
  const u = mkFixture();
  for (let i = 0; i < 2; i++) assert.equal(run(u, ['alpha', '--role', 'build'], { CLAUDE_CODE_SESSION_ID: undefined }).code, 0);
  assert.equal(readStatus(u, 'alpha').sessions.length, 1);
  assert.equal(cardsFor(u, 'unknown').length, 1);
  assertLedgerConsistent(u);
});

test('ADV-08 a closed (frozen) status.json is refused by the writer: file byte-identical, no card, no row', () => {
  const fx = mkFixture();
  const f = statusFile(fx, 'alpha');
  const c = spawnSync(process.execPath, [WRITER, 'close', '--by', 'conclude-it', '--owner-note', 'frozen for the test', '--file', f], { encoding: 'utf8' });
  assert.equal(c.status, 0, c.stderr);
  const before = fs.readFileSync(f);
  const idx = indexText(fx);
  const r = run(fx, ['alpha', '--role', 'build']);
  assert.equal(r.code, 1, r.err);
  assert.match(r.err, /closed/);
  assert.deepEqual(fs.readFileSync(f), before);
  assert.equal(indexText(fx), idx);
  assert.equal(cardsFor(fx, 'sess-0001').length, 0);
});

test('ADV-09 an empty 0-done bucket and a 0-done folder named like a live one: live wins, parked needs --allow-done', () => {
  const fx = mkFixture();
  fs.mkdirSync(path.join(fx.root, 'docs', 'implementations', '0-done', 'alpha'));
  const r = run(fx, ['alpha']);
  assert.equal(r.code, 0, r.err);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(run(fx, ['0-done/alpha']).code, 2);
  const e = mkFixture();
  fs.rmSync(path.join(e.root, 'docs', 'implementations', '0-done'), { recursive: true });
  assert.equal(run(e, ['old-impl']).code, 2);
});

test('ADV-10 very long values: a 5000-char id is idempotent; a too-long card name fails loud with status.json still valid', () => {
  const fx = mkFixture();
  const sid = 'L'.repeat(5000);
  assert.equal(run(fx, ['alpha'], { CLAUDE_CODE_SESSION_ID: sid }).code, 0);
  assert.equal(run(fx, ['alpha'], { CLAUDE_CODE_SESSION_ID: sid }).code, 0);
  assert.equal(readStatus(fx, 'alpha').sessions.length, 1);
  assert.equal(cardsFor(fx, sid).length, 1);
  const name = 'n'.repeat(240);
  fs.mkdirSync(path.join(fx.root, 'docs', 'implementations', name));
  const r = run(fx, [name]);
  assert.equal(r.code, 5, r.err);
  assert.match(r.err, /status\.json is updated, but the open card/);
  assert.equal(validate(statusFile(fx, name)).status, 0);
  assert.equal(fs.existsSync(path.join(HIST(fx), '.ledger.lock')), false, 'lock released on failure');
  noResidue(fx);
});
