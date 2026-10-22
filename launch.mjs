import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { root, pkgDir, entryFor, npmArgs } from './common.mjs';

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const own = sep === -1 ? argv : argv.slice(0, sep);
const pass = sep === -1 ? [] : argv.slice(sep + 1);
const pkg = own[0];
const binName = own.includes('--bin') ? own[own.indexOf('--bin') + 1] : '';
if (!pkg) { console.error('usage: launch.mjs <npm-package> [--bin <name>] -- <server args>'); process.exit(2); }

const dir = pkgDir(pkg);
mkdirSync(join(dir, 'versions'), { recursive: true });
const pointer = join(dir, 'current.txt');

if (!existsSync(pointer)) {
  const ver = spawnSync('npm', ['view', pkg, 'version'], { shell: true, windowsHide: true, encoding: 'utf8' }).stdout.trim();
  const r = spawnSync('npm', npmArgs(join(dir, 'versions', ver), `${pkg}@${ver}`),
    { shell: true, windowsHide: true, stdio: ['ignore', 'ignore', 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
  writeFileSync(pointer + '.tmp', ver); renameSync(pointer + '.tmp', pointer);
}

const ver = readFileSync(pointer, 'utf8').trim();
const child = spawn(process.execPath, [entryFor(join(dir, 'versions', ver), pkg, binName), ...pass], { stdio: 'inherit', windowsHide: true });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => child.kill(s));

const stampDir = process.env.MCP_LAUNCH_STAMP_DIR;
if (stampDir && process.env.CLAUDE_PID) {
  try {
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(join(stampDir, `${process.env.CLAUDE_PID}-${pkg.replace(/[^\w.-]/g, '_')}.txt`), `${child.pid} ${Date.now()}`);
  } catch {}
}

spawn(process.execPath, [join(root, 'update.mjs'), pkg, binName, ...pass], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
if (existsSync(join(root, 'onboard.enabled'))) spawn(process.execPath, [join(root, 'onboard.mjs'), '--from-launch'], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
