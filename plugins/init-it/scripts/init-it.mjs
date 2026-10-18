#!/usr/bin/env node
// init-it.mjs - register this session against an implementation. Zero dependencies, Node 18+.
// No network calls, no model calls. status.json is written ONLY through build-it's status-write (by path).
// Exit codes: 0 ok | 1 refused by status-write | 2 usage / unknown or done implementation
//             3 status.json invalid JSON or lock failure | 4 status-write not found / too old | 5 card or INDEX not written
// Authored by DevOtts (https://github.com/DevOtts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  readCard, renderOpenCard, indexRow, upsertIndex, withLockSync, writeAtomicText, findOpenCard, parseList,
} from './ledger.mjs';

export const ROLES = ['plan', 'build', 'review', 'conclude', 'other'];
const PARKED = new Set(['0-done', '1-backlog']);
const BOOL = new Set(['rename', 'none', 'allow-done', 'help']);
const USAGE = `usage: init-it <name | @docs/implementations/<name>> [--role plan|build|review|conclude|other] [--rename] [--allow-done]
       init-it --none [--role R]
       options: --repo <root>  --session-id <id>  --alias <alias>  (explicit overrides; otherwise read from the host)`;

export class InitError extends Error { constructor(msg, code) { super(msg); this.exitCode = code; } }

export function parseArgs(argv) {
  const pos = []; const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (BOOL.has(k)) flags[k] = true;
      else { if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new InitError(`flag --${k} needs a value`, 2); flags[k] = argv[++i]; }
    } else pos.push(a);
  }
  return { pos, flags };
}

// ---------- host identity (never invented) ----------

export function hostSessionId(env, flags = {}) {
  const v = flags['session-id'] ?? env.CLAUDE_CODE_SESSION_ID;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
}

// Alias rule: explicit --alias / INIT_IT_ALIAS; else CLAUDE_CONFIG_DIR basename ".claude-anm" -> "claudeanm"
// (the ledger's existing alias dirs); the default config dir (unset or ".claude") only resolves through
// default_alias in the init-it config file. Otherwise null -> "unknown" + warning.
export function hostAlias(env, flags = {}) {
  const explicit = flags.alias ?? env.INIT_IT_ALIAS;
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const cfgDir = env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.trim();
  const base = cfgDir ? path.basename(cfgDir.replace(/\/+$/, '')) : '.claude';
  const m = /^\.?claude-([A-Za-z0-9_]+)$/.exec(base);
  if (m) return `claude${m[1]}`;
  if (base === '.claude' || base === 'claude') {
    const conf = env.INIT_IT_CONFIG || path.join(env.HOME || os.homedir(), '.claude', 'init-it.json');
    try {
      const j = JSON.parse(fs.readFileSync(conf, 'utf8'));
      if (typeof j.default_alias === 'string' && /^[A-Za-z0-9_-]+$/.test(j.default_alias)) return j.default_alias;
    } catch { /* absent or unreadable: unknown */ }
  }
  return null;
}

// ---------- repo + implementation resolution ----------

function implsDirOf(root) {
  for (const d of ['docs/implementations', 'docs/implementation']) {
    const p = path.join(root, d);
    try { if (fs.statSync(p).isDirectory()) return p; } catch { /* next */ }
  }
  return null;
}

export function findRepoRoot(start) {
  let d = path.resolve(start);
  for (;;) {
    if (implsDirOf(d)) return d;
    const up = path.dirname(d);
    if (up === d) return null;
    d = up;
  }
}

export function listImpls(implsDir) {
  try {
    return fs.readdirSync(implsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !PARKED.has(e.name)).map((e) => e.name).sort();
  } catch { return []; }
}

export function resolveImpl(root, target, { allowDone = false } = {}) {
  const implsDir = implsDirOf(root);
  if (!implsDir) throw new InitError(`no docs/implementations folder under ${root}`, 2);
  let t = String(target).trim().replace(/^@/, '').replace(/\/+$/, '');
  t = t.replace(/^\.\//, '').replace(/^docs\/implementations?\//, '');
  const parts = t.split('/').filter(Boolean);
  const valid = listImpls(implsDir);
  const listMsg = () => `valid implementations: ${valid.length ? valid.join(', ') : '(none)'}`;
  const nameOk = (n) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n) && n !== '..';
  let bucket = null; let name;
  if (parts.length === 2 && PARKED.has(parts[0])) { bucket = parts[0]; name = parts[1]; }
  else if (parts.length === 1) name = parts[0];
  else throw new InitError(`unknown implementation "${target}"\n${listMsg()}`, 2);
  if (!nameOk(name) || PARKED.has(name)) throw new InitError(`unknown implementation "${target}"\n${listMsg()}`, 2);
  const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
  if (!bucket && isDir(path.join(implsDir, name))) return { name, dir: path.join(implsDir, name), bucket: null };
  for (const b of bucket ? [bucket] : [...PARKED]) {
    const p = path.join(implsDir, b, name);
    if (isDir(p)) {
      if (!allowDone) throw new InitError(`implementation "${name}" is in ${b}/; refusing without --allow-done\n${listMsg()}`, 2);
      return { name, dir: p, bucket: b };
    }
  }
  throw new InitError(`unknown implementation "${target}"\n${listMsg()}`, 2);
}

// ---------- status-write (the single writer, called by path) ----------

const verNum = (v) => v.split(/[.-]/).map((x) => parseInt(x, 10) || 0);
const cmpVer = (a, b) => { const x = verNum(a); const y = verNum(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };

export function resolveStatusWrite(env = process.env) {
  if (env.DOIT_STATUS_WRITE) {
    if (fs.existsSync(env.DOIT_STATUS_WRITE)) return env.DOIT_STATUS_WRITE;
    throw new InitError(`DOIT_STATUS_WRITE points at a missing file: ${env.DOIT_STATUS_WRITE}`, 4);
  }
  const home = env.HOME || os.homedir();
  const caches = [...new Set([env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')].filter(Boolean).map((d) => path.join(d, 'plugins', 'cache')))];
  const found = [];
  for (const cache of caches) {
    let mkts = []; try { mkts = fs.readdirSync(cache); } catch { continue; }
    for (const m of mkts) {
      const base = path.join(cache, m, 'build-it');
      let vers = []; try { vers = fs.readdirSync(base); } catch { continue; }
      for (const v of vers) { const p = path.join(base, v, 'scripts', 'status', 'status-write.mjs'); if (fs.existsSync(p)) found.push({ v, p }); }
    }
  }
  if (found.length) return found.sort((a, b) => cmpVer(a.v, b.v)).pop().p;
  const dev = path.join(home, 'Workspace', 'Devotts', 'build-it', 'plugins', 'build-it', 'scripts', 'status', 'status-write.mjs');
  if (fs.existsSync(dev)) return dev;
  throw new InitError('status-write.mjs not found (install build-it, or set DOIT_STATUS_WRITE to its path); nothing was written', 4);
}

function runWriter(writer, args, env) {
  return spawnSync(process.execPath, [writer, ...args], { encoding: 'utf8', env });
}

// ---------- the register routine (one function, every caller goes through it) ----------

function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function register(opts) {
  const env = opts.env || process.env;
  const out = []; const warn = [];
  const role = opts.role || 'other';
  if (!ROLES.includes(role)) throw new InitError(`invalid --role "${role}" (allowed: ${ROLES.join(', ')})`, 2);
  if (!opts.none && !opts.target) throw new InitError(USAGE, 2);
  if (opts.none && opts.target) throw new InitError('--none takes no implementation name', 2);
  const cwd = opts.cwd || process.cwd();
  const root = opts.repo ? path.resolve(opts.repo) : findRepoRoot(cwd);
  if (!root) throw new InitError(`no docs/implementations folder found from ${cwd} upward (pass --repo)`, 2);

  const impl = opts.none ? null : resolveImpl(root, opts.target, { allowDone: !!opts.allowDone });

  const sid0 = hostSessionId(env, opts.flags || {});
  const alias0 = hostAlias(env, opts.flags || {});
  if (!sid0) warn.push('warning: session id unknown (CLAUDE_CODE_SESSION_ID not set); writing "unknown"');
  if (!alias0) warn.push('warning: alias unknown (no INIT_IT_ALIAS, no CLAUDE_CONFIG_DIR alias, no default_alias in ~/.claude/init-it.json); writing "unknown"');
  const sid = sid0 || 'unknown';
  const alias = alias0 || 'unknown';
  if (!/^[A-Za-z0-9_-]+$/.test(alias)) throw new InitError(`alias "${alias}" is not a safe folder name`, 2);
  // The id lands in a card header line: whitespace/control chars would forge or split header fields, and
  // " #" would be read back as a comment, so the open card would never be matched again (INIT-08).
  if (/[\s\u0000-\u001f\u007f#]/.test(sid)) throw new InitError(`session id ${JSON.stringify(sid)} contains whitespace, a control character or "#"; refusing`, 2);

  const name = impl ? impl.name : 'none';
  const session = `${name}-${role}`;

  // 1) status.json first, through the single writer.
  if (impl) {
    const file = path.join(impl.dir, 'status.json');
    const exists = fs.existsSync(file);
    if (exists) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new InitError(`cannot read ${file}: ${e.code || e.message}`, 3); }
      try { JSON.parse(text); } catch (e) { throw new InitError(`invalid JSON in ${file}: ${e.message}; file left untouched`, 3); }
    }
    const writer = resolveStatusWrite(env);
    const args = ['session', 'add', '--session-id', sid, '--alias', alias, '--name', session, '--role', role, '--by', 'init-it', '--file', file];
    if (!exists) args.push('--create');
    const r = runWriter(writer, args, env);
    if (r.status !== 0) {
      const msg = (r.stderr || '').trim() || `exit ${r.status ?? r.signal}`;
      if (!exists && /--create needs a value|unknown flag/.test(msg)) {
        throw new InitError(`status-write at ${writer} is too old for --create (needs build-it with init-it support); nothing was written`, 4);
      }
      const code = r.status === 3 ? 3 : 1;
      throw new InitError(`status-write refused or failed (${writer}): ${msg}\nno card written; ${exists ? 'status.json is unchanged' : 'status.json was not created'}`, code);
    }
    if (!exists) out.push(`created ${path.relative(root, file)} (minimal, created_by init-it)`);
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      const s = (doc.sessions || []).find((x) => x.session_id === sid);
      if (s && s.role !== role) warn.push(`warning: role stays "${s.role}" in status.json; status-write at ${writer} does not update roles (needs build-it with init-it support)`);
    } catch { /* read-back is advisory */ }
  }

  // 2) open card + INDEX row, under one ledger lock.
  const histDir = path.join(root, '.agents', 'history');
  const date = opts.date || localDate();
  const openedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const project = path.basename(root);
  let cardPath;
  try {
    fs.mkdirSync(path.join(histDir, alias), { recursive: true });
    withLockSync(path.join(histDir, '.ledger.lock'), () => {
      const hit = findOpenCard(histDir, { session_id: sid, alias, date, session });
      let card; let file; let cardAlias;
      if (hit) {
        const prev = hit.card;
        const prevImpl = Array.isArray(prev.implementation) ? prev.implementation : [];
        const implList = impl ? [...new Set([...prevImpl, impl.name])] : prevImpl;
        card = {
          session: prev.session, alias: prev.alias, session_id: prev.session_id, project: prev.fields.project || project,
          cwd: prev.fields.cwd || cwd, date: prev.date || date, implementation: implList, opened_at: prev.opened_at || openedAt, role,
        };
        file = hit.file; cardAlias = hit.alias;
      } else {
        cardAlias = alias;
        let stem = `${date}--${session}`; file = `${stem}.md`;
        for (let n = 2; fs.existsSync(path.join(histDir, alias, file)); n++) file = `${stem}-${n}.md`;
        card = { session, alias, session_id: sid, project, cwd, date, implementation: impl ? [impl.name] : [], opened_at: openedAt, role };
      }
      cardPath = path.join(histDir, cardAlias, file);
      writeAtomicText(cardPath, renderOpenCard(card), 'after-card-tmp');
      const indexFile = path.join(histDir, 'INDEX.md');
      let text = null; try { text = fs.readFileSync(indexFile, 'utf8'); } catch { /* new */ }
      const link = `${cardAlias}/${file}`;
      const row = indexRow({
        date: card.date, alias: cardAlias, project: card.project, impl: card.implementation.join(', '), session: card.session, link,
        status: 'open', tags: `init-it, ${role}`, summary: `open: ${role} session registered by init-it`,
      });
      writeAtomicText(indexFile, upsertIndex(text, { link, row, project }), 'after-index-tmp');
    });
  } catch (e) {
    if (e instanceof InitError) throw e;
    throw new InitError(`warning: ${impl ? 'status.json is updated, but ' : ''}the open card / INDEX row was not written: ${e.message}`, 5);
  }

  // 3) optional rename. Claude Code exposes no scripted session rename, so the script never fakes one.
  if (opts.rename) out.push(`rename skipped: host (type /rename ${session} to rename this session)`);

  out.push(`registered ${sid} as ${role} on ${name}; open card ${path.relative(root, cardPath)}`);
  return { out, warn, session_id: sid, alias, name, role, cardPath, root };
}

export function main(argv = process.argv.slice(2), env = process.env) {
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) { process.stderr.write(`init-it: ${e.message}\n${USAGE}\n`); return 2; }
  const { pos, flags } = parsed;
  if (flags.help) { process.stdout.write(`${USAGE}\n`); return 0; }
  try {
    const r = register({
      target: pos[0], role: flags.role, none: !!flags.none, rename: !!flags.rename, allowDone: !!flags['allow-done'],
      repo: flags.repo, env, flags, date: env.INIT_IT_TEST_DATE,
    });
    for (const w of r.warn) process.stderr.write(`init-it: ${w}\n`);
    for (const l of r.out) process.stdout.write(`${l}\n`);
    return 0;
  } catch (e) {
    if (e instanceof InitError) { process.stderr.write(`init-it: ${e.message}\n`); return e.exitCode; }
    process.stderr.write(`init-it: error: ${e.stack || e.message}\n`);
    return 1;
  }
}

export { readCard, parseList };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
