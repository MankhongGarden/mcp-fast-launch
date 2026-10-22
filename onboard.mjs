// onboard.mjs: moves npx-started MCP servers in your Claude Code configs onto launch.mjs. See README "Auto-onboard".
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, openSync, closeSync, rmSync, appendFileSync, mkdirSync, realpathSync, readdirSync } from 'node:fs';
import { join, dirname, basename, resolve, normalize, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { root, pkgDir, entryFor, npmArgs } from './common.mjs';
import { loadConfig, claudeJsonPath, excludeRegex, forbiddenCheck, mask, parseNpx, expander } from './onboard-lib.mjs';

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i === -1 ? null : argv[i + 1]; };
const dry = has('--dry-run');
const configs = argv.flatMap((a, i) => (a === '--config' && argv[i + 1] ? [resolve(argv[i + 1])] : []));
const testDir = opt('--claude-dir') ? resolve(opt('--claude-dir')) : null;
const test = configs.length > 0 || !!testDir;
const FLAG = join(root, 'onboard.enabled');
if (!dry && !test && !existsSync(FLAG)) process.exit(0);

const cfg = loadConfig(join(root, 'onboard.config.json'));
const EXCLUDE = excludeRegex(cfg.exclude);
const forbidden = forbiddenCheck(cfg.forbiddenPaths);
const LAUNCH = join(root, 'launch.mjs');
const THROTTLE_MS = 3600_000;
const RETRY_FAILED_MS = 24 * 3600_000;

const claudeJson = claudeJsonPath(process.env, testDir);
const stateDir = test ? opt('--state-dir') || dirname(configs[0] || claudeJson) : root;
const backupRoot = opt('--backup-root') || (test ? join(stateDir, 'backups') : cfg.backupDir || join(root, 'backups'));
const out = (m) => console.log(m);
const log = (m) => appendFileSync(join(stateDir, 'onboard.log'), `${new Date().toISOString()} ${dry ? '[dry] ' : ''}${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => { const raw = readFileSync(f, 'utf8'); return { raw, j: JSON.parse(raw.replace(/^﻿/, '')) }; };

if (forbidden(claudeJson) || configs.some(forbidden)) { console.error('refusing: path is listed in forbiddenPaths'); process.exit(2); }

const stamp = join(stateDir, 'last-onboard.txt');
if (!dry && !test && !has('--now')) {
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < THROTTLE_MS) process.exit(0);
  if (has('--from-launch')) {
    await sleep(Number(process.env.MCP_ONBOARD_DELAY_MS ?? 90_000));
    if (!existsSync(FLAG)) process.exit(0);
  }
}

function findMcpJson(dir) {
  if (cfg.everythingPath) {
    const tmp = join(tmpdir(), `onboard-es-${process.pid}.txt`);
    const r = spawnSync(cfg.everythingPath, ['-n', '500', '-path', dir, '/a-d', '.mcp.json', '-export-txt', tmp], { windowsHide: true, timeout: 20_000 });
    if (r.status !== 0 || !existsSync(tmp)) { log(`es search failed for ${dir} (exit ${r.status})`); return []; }
    const lines = readFileSync(tmp, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
    rmSync(tmp, { force: true });
    return lines.filter((p) => basename(p).toLowerCase() === '.mcp.json' && !EXCLUDE.test(p) && !forbidden(p));
  }
  if (!existsSync(dir)) { log(`scan dir not found: ${dir}`); return []; }
  const found = [];
  const walk = (d) => {
    if (found.length >= 500) return;
    let ents;
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { if (!EXCLUDE.test(p + sep) && !forbidden(p)) walk(p); }
      else if (e.isFile() && e.name.toLowerCase() === '.mcp.json') found.push(p);
    }
  };
  walk(resolve(dir));
  return found.filter((p) => !EXCLUDE.test(p) && !forbidden(p));
}

function collect() {
  const items = [];
  if (!test || testDir) {
    const file = claudeJson;
    const { j } = readJson(file);
    for (const [name, entry] of Object.entries(j.mcpServers || {})) items.push({ kind: 'cli', scope: 'user', cwd: root, file, src: 'user', name, entry });
    for (const [p, v] of Object.entries(j.projects || {}))
      for (const [name, entry] of Object.entries(v?.mcpServers || {})) items.push({ kind: 'cli', scope: 'local', pkey: p, cwd: normalize(p), file, src: `local:${p}`, name, entry });
  }
  const files = test ? configs : cfg.scanDirs.flatMap(findMcpJson);
  for (const f of files) {
    try {
      const { j } = readJson(f);
      for (const [name, entry] of Object.entries(j.mcpServers || {})) items.push({ kind: 'file', cwd: dirname(f), file: f, src: f, name, entry });
    } catch (e) { log(`cannot read ${f}: ${e.message}`); }
  }
  return items;
}

function ensureInstalled(pkg) {
  const dir = pkgDir(pkg), pointer = join(dir, 'current.txt');
  if (existsSync(pointer)) {
    const ver = readFileSync(pointer, 'utf8').trim();
    if (existsSync(join(dir, 'versions', ver, 'node_modules', ...pkg.split('/'), 'package.json'))) return { dir, ver, fresh: false };
  }
  const fresh = !existsSync(dir);
  const ver = spawnSync('npm', ['view', pkg, 'version'], { shell: true, windowsHide: true, encoding: 'utf8', timeout: 60_000 }).stdout?.trim();
  if (!ver || !/^\d/.test(ver)) throw new Error('npm view found no version');
  const target = join(dir, 'versions', ver);
  mkdirSync(target, { recursive: true });
  const r = spawnSync('npm', npmArgs(target, `${pkg}@${ver}`), { shell: true, windowsHide: true, stdio: 'ignore', timeout: 600_000 });
  if (r.status !== 0) { rmSync(fresh ? dir : target, { recursive: true, force: true }); throw new Error(`npm install failed (exit ${r.status})`); }
  return { dir, ver, fresh };
}

function pickBin(versionDir, pkg) {
  const bin = JSON.parse(readFileSync(join(versionDir, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).bin;
  if (!bin) throw new Error('package has no bin');
  if (typeof bin === 'string') return '';
  const keys = Object.keys(bin), base = pkg.split('/').pop();
  const npxPick = bin[base] ? base : keys.length === 1 ? keys[0] : null;
  if (!npxPick) throw new Error(`several bins (${keys.join(', ')}), npx cannot choose`);
  return npxPick === (bin[base] ? base : keys[0]) ? '' : npxPick;
}

function probe(entry, args, env, cwd) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env, cwd: existsSync(cwd) ? cwd : root });
    let buf = '';
    const finish = (ok) => { clearTimeout(t); try { p.kill(); } catch {} done(ok); };
    const t = setTimeout(() => finish(false), 45_000);
    p.stdout.on('data', (d) => { buf += d; if (/"id"\s*:\s*1[,}]/.test(buf) && buf.includes('"result"')) finish(true); });
    p.on('exit', () => finish(false));
    p.on('error', () => finish(false));
    p.stdin.on('error', () => {});
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-onboard-probe', version: '1' } } }) + '\n');
  });
}

let backupDir = '';
function backup() {
  if (!backupDir) {
    const d = new Date(), z = (n) => String(n).padStart(2, '0');
    backupDir = join(backupRoot, `mcp-onboard-${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`);
    mkdirSync(backupDir, { recursive: true });
  }
  return backupDir;
}
const safeName = (s) => s.replace(/[:\\/\s]+/g, '_').replace(/^_+/, '');

let claudeExe = null;
function findClaude() {
  if (claudeExe !== null) return claudeExe;
  if (cfg.claudePath) return (claudeExe = cfg.claudePath);
  const win = process.platform === 'win32';
  const r = spawnSync(win ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
  const hits = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (!win) return (claudeExe = hits[0] || '');
  const exe = hits.find((h) => /\.exe$/i.test(h));
  if (exe) return (claudeExe = exe);
  const shim = hits.find((h) => /\.cmd$/i.test(h));
  const native = shim ? join(dirname(shim), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe') : '';
  return (claudeExe = native && existsSync(native) ? native : '');
}

function claude(args, cwd) {
  const exe = findClaude();
  if (!exe || !existsSync(exe)) throw new Error('claude executable not found, set claudePath in onboard.config.json');
  if (/\.exe$/i.test(exe) && statSync(exe).size < 1_000_000) throw new Error('claude.exe is under 1 MB (a broken update stub?), reinstall Claude Code');
  const env = testDir ? { ...process.env, CLAUDE_CONFIG_DIR: testDir } : process.env;
  return spawnSync(exe, args, { cwd, windowsHide: true, encoding: 'utf8', timeout: 60_000, env });
}

function applyCli(it, newEntry) {
  if (!existsSync(it.cwd)) throw new Error(`project folder gone: ${it.cwd}`);
  if (it.scope === 'local' && realpathSync.native(it.cwd).replace(/\\/g, '/') !== it.pkey) throw new Error('legacy or mismatched project key, Claude does not load it from this folder');
  const b = backup(), tag = `${it.scope}-${safeName(it.scope === 'local' ? it.cwd : '')}-${it.name}`.replace(/--/g, '-');
  const got = claude(['mcp', 'get', it.name], it.cwd);
  writeFileSync(join(b, `${tag}.get.txt`), `${got.stdout || ''}${got.stderr || ''}`);
  writeFileSync(join(b, `${tag}.json`), JSON.stringify(it.entry, null, 2));
  appendFileSync(join(b, 'RESTORE.txt'), `${it.name} (${it.scope}${it.scope === 'local' ? ` · cd "${it.cwd}"` : ''}): claude mcp remove ${it.name} -s ${it.scope}; claude mcp add-json ${it.name} (Get-Content -Raw "${join(b, `${tag}.json`)}") -s ${it.scope}\n`);
  const rm = claude(['mcp', 'remove', it.name, '-s', it.scope], it.cwd);
  if (rm.status !== 0) throw new Error(`claude mcp remove failed: ${(rm.stderr || rm.stdout || '').trim().split('\n')[0]}`);
  const add = claude(['mcp', 'add-json', it.name, JSON.stringify(newEntry), '-s', it.scope], it.cwd);
  if (add.status !== 0) {
    const back = claude(['mcp', 'add-json', it.name, JSON.stringify(it.entry), '-s', it.scope], it.cwd);
    throw new Error(`claude mcp add-json failed (${(add.stderr || add.stdout || '').trim().split('\n')[0]}); restore ${back.status === 0 ? 'ok' : 'FAILED, see backup'}`);
  }
  const { j } = readJson(it.file);
  const now = it.scope === 'user' ? j.mcpServers?.[it.name] : j.projects?.[it.pkey]?.mcpServers?.[it.name];
  if (!now || now.command !== 'node' || now.args?.[0] !== LAUNCH) throw new Error('entry not found on launcher after add-json');
}

function applyFile(file, raw, j, changes) {
  const b = backup();
  writeFileSync(join(b, `${safeName(file)}`), raw);
  appendFileSync(join(b, 'RESTORE.txt'), `copy "${join(b, safeName(file))}" back to "${file}"\n`);
  for (const { name, newEntry } of changes) Object.assign(j.mcpServers[name], { command: newEntry.command, args: newEntry.args });
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const indent = (raw.match(/\n([ \t]+)"/) || [])[1] || '  ';
  let txt = JSON.stringify(j, null, indent).replace(/\n/g, eol);
  if (/\n$/.test(raw)) txt += eol;
  if (readFileSync(file, 'utf8') !== raw) throw new Error('file changed during run, not written');
  writeFileSync(`${file}.onboard-tmp`, txt, 'utf8');
  renameSync(`${file}.onboard-tmp`, file);
}

function notify(text) {
  if (dry || (test && !has('--notify')) || !Array.isArray(cfg.notifyCommand) || !cfg.notifyCommand.length) { out(`[notify] ${text}`); return; }
  const [cmd, ...rest] = cfg.notifyCommand;
  const viaNode = /\.(mjs|cjs|js)$/i.test(cmd);
  const shell = !viaNode && process.platform === 'win32' && !/\.(exe|com)$/i.test(cmd);
  const t = shell ? `"${text.replace(/["%^&|<>]/g, '')}"` : text;
  const args = rest.map((a) => (a === '{text}' ? t : a));
  const o = { windowsHide: true, encoding: 'utf8', timeout: 30_000 };
  const r = viaNode ? spawnSync(process.execPath, [cmd, ...args], o) : spawnSync(cmd, args, { ...o, shell });
  if (r.status !== 0) log(`notify command failed: ${(r.stderr || r.error?.message || '').trim()}`);
}

const lock = join(stateDir, 'onboard.lock');
let fd;
if (!dry) {
  if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 60 * 60_000) rmSync(lock, { force: true });
  try { fd = openSync(lock, 'wx'); } catch { process.exit(0); }
}

const statePath = join(stateDir, 'onboard-state.json');
const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : { failures: {} };
const converted = [], failed = [];

try {
  if (!dry && !test) writeFileSync(stamp, new Date().toISOString());
  const items = collect();
  const cands = [];
  for (const it of items) {
    const r = it.pkey?.includes('\\') ? { skip: 'legacy project key, not loaded by Claude' } : parseNpx(it.entry);
    if (r.skip) { if (dry || test) out(`skip     ${it.name} [${it.src}]: ${r.skip}`); continue; }
    const key = `${it.src}|${it.name}|${r.pkg}`;
    const prev = state.failures[key];
    if (!dry && !has('--now') && !test && prev && Date.now() - Date.parse(prev.at) < RETRY_FAILED_MS) continue;
    cands.push({ ...it, ...r, key });
  }
  if (dry) {
    for (const c of cands) out(`CONVERT  ${c.name} [${c.src}]: npx ${[c.pkg, ...mask(c.serverArgs)].join(' ')} -> node launch.mjs ${c.pkg} -- ...`);
    out(cands.length ? `dry-run: ${cands.length} entr${cands.length === 1 ? 'y' : 'ies'} would move to the launcher` : 'dry-run: nothing to change');
    log(`scanned ${items.length} entries, ${cands.length} would convert`);
    process.exit(0);
  }

  log(`scanned ${items.length} entries, ${cands.length} to convert`);
  const fileChanges = new Map();
  for (const c of cands) {
    const desc = `${c.name} [${c.src}] (${[c.pkg, ...mask(c.serverArgs)].join(' ')})`;
    let inst;
    try {
      inst = ensureInstalled(c.pkg);
      const vdir = join(inst.dir, 'versions', inst.ver);
      const bin = pickBin(vdir, c.pkg);
      const missing = new Set(), ex = expander(missing);
      const env = { ...process.env };
      for (const [k, v] of Object.entries(c.entry.env || {})) env[k] = ex(v);
      const pargs = c.serverArgs.map(ex);
      if (!(await probe(entryFor(vdir, c.pkg, bin), pargs, env, c.cwd)))
        throw new Error(`no MCP initialize reply${missing.size ? ` (unset env: ${[...missing].join(', ')})` : ''}`);
      const pointer = join(inst.dir, 'current.txt');
      if (!existsSync(pointer)) { writeFileSync(pointer + '.tmp', inst.ver); renameSync(pointer + '.tmp', pointer); }
      const newEntry = { ...c.entry, command: 'node', args: [LAUNCH, c.pkg, ...(bin ? ['--bin', bin] : []), '--', ...c.serverArgs] };
      if (c.kind === 'cli') { applyCli(c, newEntry); converted.push(c.name); log(`converted ${desc} v${inst.ver}`); delete state.failures[c.key]; }
      else {
        if (!fileChanges.has(c.file)) fileChanges.set(c.file, []);
        fileChanges.get(c.file).push({ name: c.name, newEntry, desc, ver: inst.ver, key: c.key });
      }
    } catch (e) {
      if (inst?.fresh && !existsSync(join(inst.dir, 'current.txt'))) rmSync(inst.dir, { recursive: true, force: true });
      log(`FAILED ${desc}: ${e.message}`);
      const first = !state.failures[c.key]?.notified;
      state.failures[c.key] = { at: new Date().toISOString(), reason: e.message, notified: true };
      if (first) failed.push(`${c.name} (${e.message})`);
    }
  }
  for (const [file, changes] of fileChanges) {
    try {
      const { raw, j } = readJson(file);
      const live = changes.filter((ch) => JSON.stringify(j.mcpServers?.[ch.name]) === JSON.stringify(cands.find((c) => c.file === file && c.name === ch.name).entry));
      if (live.length) applyFile(file, raw, j, live);
      for (const ch of live) { converted.push(ch.name); log(`converted ${ch.desc} in ${file} v${ch.ver}`); delete state.failures[ch.key]; }
      if (live.length < changes.length) log(`${file}: ${changes.length - live.length} entr(ies) changed during run, left as is`);
    } catch (e) {
      log(`FAILED writing ${file}: ${e.message}`);
      failed.push(`${basename(dirname(file))}/.mcp.json (${e.message})`);
    }
  }
  if (converted.length || failed.length) {
    const parts = [];
    if (converted.length) parts.push(`moved ${converted.join(', ')} onto the launcher`);
    if (failed.length) parts.push(`could not move ${failed.join('; ')}`);
    notify(`MCP auto-onboard: ${parts.join(' · ')} · ${backupDir ? `backup ${backupDir}` : 'nothing edited'} · log ${join(stateDir, 'onboard.log')}`);
  }
  writeFileSync(statePath, JSON.stringify(state, null, 2));
  if (test || has('--now')) out(`done: converted ${converted.length}, failed ${failed.length}${backupDir ? `, backup ${backupDir}` : ''}`);
} finally {
  if (fd !== undefined) { closeSync(fd); rmSync(lock, { force: true }); }
}
