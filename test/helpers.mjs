// Test helpers for init-it. Authored by DevOtts (https://github.com/DevOtts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveStatusWrite } from '../plugins/init-it/scripts/init-it.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..');
export const SCRIPT = path.join(REPO, 'plugins', 'init-it', 'scripts', 'init-it.mjs');
export const FIXTURE = path.join(HERE, 'fixtures', 'repo');
// The single writer. Point DOIT_STATUS_WRITE at a build-it checkout that has `session add --create`.
export const WRITER = resolveStatusWrite(process.env);
export const DATE = '2026-10-18';

export function mkFixture() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'init-it-')));
  const root = path.join(base, 'repo');
  fs.cpSync(FIXTURE, root, { recursive: true });
  fs.mkdirSync(path.join(root, '.git'));
  const home = path.join(base, 'home');
  fs.mkdirSync(home);
  return { base, root, home };
}

export function envFor(fx, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: fx.home, DOIT_STATUS_WRITE: WRITER, INIT_IT_TEST_DATE: DATE,
    CLAUDE_CODE_SESSION_ID: 'sess-0001', INIT_IT_ALIAS: 'claudinho', ...extra,
  };
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete env[k];
  return env;
}

export function run(fx, args, extra = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: fx.root, encoding: 'utf8', env: envFor(fx, extra) });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function runAsync(fx, args, extra = {}) {
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [SCRIPT, ...args], { cwd: fx.root, env: envFor(fx, extra) });
    let out = ''; let err = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => resolve({ code, out, err }));
  });
}

export const statusFile = (fx, name) => path.join(fx.root, 'docs', 'implementations', name, 'status.json');
export const readStatus = (fx, name) => JSON.parse(fs.readFileSync(statusFile(fx, name), 'utf8'));
export const indexText = (fx) => fs.readFileSync(path.join(fx.root, '.agents', 'history', 'INDEX.md'), 'utf8');
export function cardsFor(fx, sid) {
  const hist = path.join(fx.root, '.agents', 'history');
  const outp = [];
  for (const d of fs.readdirSync(hist, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    for (const f of fs.readdirSync(path.join(hist, d.name))) {
      if (!f.endsWith('.md')) continue;
      const p = path.join(hist, d.name, f);
      if (fs.readFileSync(p, 'utf8').includes(`session_id: ${sid}\n`)) outp.push(p);
    }
  }
  return outp;
}
export const validate = (file) => spawnSync(process.execPath, [WRITER, 'validate', '--file', file], { encoding: 'utf8' });
