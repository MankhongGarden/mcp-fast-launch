import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, openSync, closeSync, rmSync, readdirSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pkgDir, entryFor, npmArgs } from './common.mjs';

const [pkg, binName, ...pass] = process.argv.slice(2);
const dir = pkgDir(pkg);
const log = (m) => appendFileSync(join(dir, 'update.log'), `${new Date().toISOString()} ${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const STARTUP_DELAY_MS = Number(process.env.MCP_LAUNCH_DELAY_MS ?? 60_000);
const CHECK_EVERY_MS = 6 * 3600_000;
const KEEP_VERSIONS = 3;

function probe(entry) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [entry, ...pass], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    let out = '';
    const done = (ok) => { clearTimeout(t); try { p.kill(); } catch {} resolve(ok); };
    const t = setTimeout(() => done(false), 30_000);
    p.stdout.on('data', (d) => { out += d; if (/"id"\s*:\s*1[,}]/.test(out) && out.includes('"result"')) done(true); });
    p.on('exit', () => done(false));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-launch-probe', version: '1' } } }) + '\n');
  });
}

await sleep(STARTUP_DELAY_MS);

const stamp = join(dir, 'last-check.txt');
if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < CHECK_EVERY_MS) process.exit(0);

const lock = join(dir, 'update.lock');
if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30 * 60_000) rmSync(lock, { force: true });
let fd;
try { fd = openSync(lock, 'wx'); } catch { process.exit(0); }

try {
  writeFileSync(stamp, new Date().toISOString());
  const pointer = join(dir, 'current.txt');
  const current = readFileSync(pointer, 'utf8').trim();
  const latest = spawnSync('npm', ['view', pkg, 'version'], { shell: true, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  if (!latest) { log('check failed: npm view returned nothing'); process.exitCode = 1; }
  else if (latest === current) { /* up to date */ }
  else {
    const target = join(dir, 'versions', latest);
    mkdirSync(target, { recursive: true });
    const r = spawnSync('npm', npmArgs(target, `${pkg}@${latest}`), { shell: true, windowsHide: true, stdio: 'ignore' });
    if (r.status !== 0) { log(`install ${latest} failed (exit ${r.status})`); rmSync(target, { recursive: true, force: true }); }
    else if (!(await probe(entryFor(target, pkg, binName)))) { log(`${latest} failed MCP handshake, staying on ${current}`); rmSync(target, { recursive: true, force: true }); }
    else {
      writeFileSync(pointer + '.tmp', latest); renameSync(pointer + '.tmp', pointer);
      log(`updated ${current} -> ${latest} (used from next start)`);
      const keep = new Set([latest, current]);
      const old = readdirSync(join(dir, 'versions')).filter((v) => !keep.has(v))
        .map((v) => ({ v, t: statSync(join(dir, 'versions', v)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const { v } of old.slice(KEEP_VERSIONS - keep.size)) rmSync(join(dir, 'versions', v), { recursive: true, force: true });
    }
  }
} finally {
  closeSync(fd); rmSync(lock, { force: true });
}
