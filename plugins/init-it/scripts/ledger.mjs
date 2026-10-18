// ledger.mjs - session ledger card + INDEX helpers for init-it. Zero dependencies, Node 18+.
// Format: <repo>/.agents/history/INDEX.md + <alias>/YYYY-MM-DD--<session>.md (the /conclude-it Step 2.5 ledger),
// plus the two new header fields `implementation: [..]` and `status: open`.
// Authored by DevOtts (https://github.com/DevOtts).
import fs from 'node:fs';
import path from 'node:path';

export const STALE_OPEN_MS = 24 * 60 * 60 * 1000;
export const INDEX_HEADER_IMPL = '| date | alias | project | impl | session | status | tags | summary |';
export const INDEX_SEP_IMPL = '|---|---|---|---|---|---|---|---|';
const LEGACY_FIELDS = ['session', 'alias', 'session_id', 'project', 'cwd', 'date', 'status'];

// ---------- card parsing (tolerant: legacy cards, stray colons, comments) ----------

function stripComment(v) {
  // A YAML-style trailing comment: whitespace then '#'. Never inside [...] or quotes.
  let depth = 0; let q = null;
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (q) { if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; continue; }
    if (c === '[') depth++;
    else if (c === ']') depth = Math.max(0, depth - 1);
    else if (c === '#' && depth === 0 && i > 0 && /\s/.test(v[i - 1])) return v.slice(0, i).trimEnd();
  }
  return v;
}

export function parseList(v) {
  if (v == null) return null;
  const s = String(v).trim();
  if (s === '' || s === '[]') return [];
  const inner = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s;
  return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

// Returns { fields, order, body, hasFrontmatter }. Key = text before the FIRST colon, so a value with a
// colon in it ("summary: a: b") keeps its colon; a header line with no colon is ignored, never a throw.
export function parseCard(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const lines = src.split(/\r?\n/);
  const fields = {}; const order = [];
  if (lines[0]?.trim() !== '---') return { fields, order, body: src, hasFrontmatter: false };
  let end = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].trim() === '---') { end = i; break; }
  if (end < 0) return { fields, order, body: src, hasFrontmatter: false };
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    const c = line.indexOf(':');
    if (c <= 0) continue;
    const key = line.slice(0, c).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
    const val = stripComment(line.slice(c + 1).trim());
    if (!(key in fields)) order.push(key);
    fields[key] = val;
  }
  return { fields, order, body: lines.slice(end + 1).join('\n'), hasFrontmatter: true };
}

// The reader every consumer can share. implementation: absent -> 'unknown' (legacy card), '[]' -> [].
export function readCard(text) {
  const { fields, body, hasFrontmatter } = parseCard(text);
  const impl = 'implementation' in fields ? parseList(fields.implementation) : 'unknown';
  return {
    hasFrontmatter,
    fields,
    body,
    session: fields.session ?? 'unknown',
    session_id: fields.session_id || 'unknown',
    alias: fields.alias || 'unknown',
    status: fields.status || 'unknown',
    implementation: impl,
    opened_at: fields.opened_at || null,
    date: fields.date || null,
  };
}

// open (fresh) | stale-open (open > 24 h, no conclude) | concluded | <other legacy status as-is> | unknown
export function classifyCard(card, now = Date.now()) {
  const st = String(card.status || 'unknown').toLowerCase();
  if (st !== 'open') return st === '' ? 'unknown' : (st === 'concluded' || st === 'shipped' ? 'concluded' : st);
  let t = card.opened_at ? Date.parse(card.opened_at) : NaN;
  if (Number.isNaN(t) && card.date) t = Date.parse(`${card.date}T00:00:00`);
  if (Number.isNaN(t)) return 'open';
  return now - t > STALE_OPEN_MS ? 'stale-open' : 'open';
}

const yamlList = (xs) => `[${xs.join(', ')}]`;

export function renderOpenCard(c0) {
  // A header value is one line: a newline in a value would forge another header field (INIT-08).
  const one = (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ') : v);
  const c = { ...Object.fromEntries(Object.entries(c0).map(([k, v]) => [k, one(v)])), implementation: c0.implementation.map(one) };
  const head = [
    '---',
    `session: ${c.session}`,
    `alias: ${c.alias}`,
    `session_id: ${c.session_id}`,
    `project: ${c.project}`,
    `cwd: ${c.cwd}`,
    `date: ${c.date}`,
    'status: open',
    `implementation: ${yamlList(c.implementation)}`,
    `opened_at: ${c.opened_at}`,
    `tags: ${yamlList(['init-it', c.role])}`,
    '---',
  ];
  const impl = c.implementation.length ? c.implementation.join(', ') : 'none (registered with --none)';
  const body = [
    `**Objective:** open ${c.role} session, registered by /init-it. /conclude-it Step 2.5 rewrites this card in place.`,
    `**Role:** ${c.role}`,
    `**Implementation:** ${impl}`,
    '**Key results:** not concluded yet.',
  ];
  return head.concat(body).join('\n') + '\n';
}

// ---------- INDEX ----------

const cell = (v) => String(v ?? '').replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').trim();
export function indexRow(r) {
  return `| ${cell(r.date)} | ${cell(r.alias)} | ${cell(r.project)} | ${cell(r.impl)} | [${cell(r.session)}](${r.link}) | ${cell(r.status)} | ${cell(r.tags)} | ${cell(r.summary)} |`;
}

export function splitCells(line) {
  const t = line.trim();
  if (!t.startsWith('|')) return null;
  const cells = []; let cur = '';
  for (let i = 1; i < t.length; i++) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') { cur += '\\|'; i++; continue; }
    if (ch === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim() !== '') cells.push(cur.trim());
  return cells;
}

const isSep = (line) => /^\s*\|(\s*:?-{3,}:?\s*\|)+\s*$/.test(line);
function isHeader(lines, i) {
  const cells = splitCells(lines[i] || '');
  if (!cells || !isSep(lines[i + 1] || '')) return false;
  const low = cells.map((c) => c.toLowerCase());
  return low.includes('date') && low.includes('session');
}

// A row "is" a card's row only when its session cell (the first cell that is exactly one markdown link)
// points at that card, bare or with a path prefix such as `.agents/history/`. A summary cell that merely
// quotes the link of another card never matches (INIT-08).
export function rowLinksTo(line, link) {
  const cells = splitCells(line);
  if (!cells) return false;
  const c = cells.find((x) => /^\[[^\]]*\]\([^()\s]+\)$/.test(x));
  if (!c) return false;
  const target = /\]\(([^()\s]+)\)$/.exec(c)[1];
  return target === link || target.endsWith(`/${link}`);
}

// Inserts or replaces the row whose link points at `link`. Legacy rows are never touched byte for byte.
// When the first table has no Impl column, a new 8-column table block is put above it (newest first),
// so legacy 7-cell rows keep rendering under their own header.
export function upsertIndex(text, { link, row, project }) {
  if (text == null || text.trim() === '') {
    return `# Session history (${project})\n\n${INDEX_HEADER_IMPL}\n${INDEX_SEP_IMPL}\n${row}\n`;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (rowLinksTo(lines[i], link)) {
      lines[i] = row;
      return lines.join(eol);
    }
  }
  // Prefer a table that already has the Impl column anywhere in the file; else the first table.
  let h = -1; let firstAny = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isHeader(lines, i)) continue;
    if (firstAny < 0) firstAny = i;
    if (splitCells(lines[i]).some((c) => c.toLowerCase() === 'impl')) { h = i; break; }
  }
  if (h < 0) h = firstAny;
  if (h < 0) {
    const tail = text.endsWith('\n') ? '' : eol;
    return `${text}${tail}${eol}${INDEX_HEADER_IMPL}${eol}${INDEX_SEP_IMPL}${eol}${row}${eol}`;
  }
  const hasImpl = splitCells(lines[h]).some((c) => c.toLowerCase() === 'impl');
  if (hasImpl) lines.splice(h + 2, 0, row);
  else lines.splice(h, 0, INDEX_HEADER_IMPL, INDEX_SEP_IMPL, row, '');
  return lines.join(eol);
}

// ---------- lock + atomic write (same discipline as status-write) ----------

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
export function withLockSync(lock, fn, { timeoutMs = 8000, staleMs = 30000 } = {}) {
  const start = Date.now(); let delay = 5;
  for (;;) {
    try {
      const fd = fs.openSync(lock, 'wx');
      fs.writeSync(fd, `${process.pid} ${Date.now()}\n`); fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let seen = null; let dead = false; let age = 0;
      try {
        age = Date.now() - fs.statSync(lock).mtimeMs;
        seen = fs.readFileSync(lock, 'utf8');
        const pid = parseInt(seen, 10);
        if (pid > 0 && pid !== process.pid) { try { process.kill(pid, 0); } catch (k) { dead = k.code === 'ESRCH'; } }
      } catch { continue; }
      if (age > staleMs || dead) {
        const grave = `${lock}.${process.pid}.${Date.now()}.stale`;
        try { fs.renameSync(lock, grave); } catch { continue; }
        let moved = null; try { moved = fs.readFileSync(grave, 'utf8'); } catch { /* gone */ }
        if (moved !== seen) { try { fs.linkSync(grave, lock); } catch { /* re-taken */ } }
        try { fs.unlinkSync(grave); } catch { /* gone */ }
        continue;
      }
      if (Date.now() - start > timeoutMs) { const er = new Error(`could not acquire lock ${lock}`); er.code = 'ELOCK'; throw er; }
      sleepSync(delay + Math.floor(Math.random() * delay)); delay = Math.min(delay * 2, 100);
    }
  }
  try { return fn(); } finally { try { fs.unlinkSync(lock); } catch { /* gone */ } }
}

// Removes `<file>.<pid>.tmp` left by a writer that was killed between temp write and rename. Called while
// holding the ledger lock, so a live writer's temp can only belong to a process that is still running.
function sweepDeadTemps(file) {
  const dir = path.dirname(file); const base = path.basename(file);
  let names = []; try { names = fs.readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(`${base}.`) || !n.endsWith('.tmp')) continue;
    const pid = Number(n.slice(base.length + 1, -4));
    if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) continue;
    let dead = false; try { process.kill(pid, 0); } catch (k) { dead = k.code === 'ESRCH'; }
    if (dead) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* gone */ } }
  }
}

export function writeAtomicText(file, text, crashPoint) {
  const tmp = `${file}.${process.pid}.tmp`;
  sweepDeadTemps(file);
  try { fs.unlinkSync(tmp); } catch { /* absent */ }
  const fd = fs.openSync(tmp, 'wx');
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (crashPoint && process.env.INIT_IT_TEST_CRASH === crashPoint) process.exit(137); // test-only hook
  fs.renameSync(tmp, file);
}

// Finds this session's open card anywhere in the ledger (all alias dirs). Unknown ids never match by id;
// they match only an open unknown-id card with the same alias, date and session name.
export function findOpenCard(historyDir, { session_id, alias, date, session }) {
  let dirs = [];
  try { dirs = fs.readdirSync(historyDir, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')); } catch { return null; }
  for (const d of dirs) {
    let files = [];
    try { files = fs.readdirSync(path.join(historyDir, d.name)).filter((f) => f.endsWith('.md')); } catch { continue; }
    for (const f of files) {
      const p = path.join(historyDir, d.name, f);
      let card;
      try { card = readCard(fs.readFileSync(p, 'utf8')); } catch { continue; }
      if (card.status !== 'open') continue;
      if (session_id !== 'unknown') { if (card.session_id === session_id) return { path: p, alias: d.name, file: f, card }; }
      else if (card.session_id === 'unknown' && d.name === alias && card.date === date && card.session === session) return { path: p, alias: d.name, file: f, card };
    }
  }
  return null;
}

export { LEGACY_FIELDS };
