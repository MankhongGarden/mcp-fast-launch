import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseNpx, mask, expander, excludeRegex, forbiddenCheck, claudeJsonPath } from '../onboard-lib.mjs';
import { entryFor } from '../common.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

test('parseNpx accepts npx -y <pkg> and cmd /c npx -y <pkg>@latest', () => {
  assert.deepEqual(parseNpx({ command: 'npx', args: ['-y', 'chrome-devtools-mcp', '--foo'] }), { pkg: 'chrome-devtools-mcp', serverArgs: ['--foo'] });
  assert.deepEqual(parseNpx({ command: 'cmd', args: ['/c', 'npx', '-y', '@scope/server@latest', 'a'] }), { pkg: '@scope/server', serverArgs: ['a'] });
  assert.deepEqual(parseNpx({ command: 'C:\\x\\npx.cmd', args: ['--yes', 'pkg'] }), { pkg: 'pkg', serverArgs: [] });
});

test('parseNpx skips pinned, remote, non-npx and launcher entries', () => {
  assert.match(parseNpx({ command: 'npx', args: ['-y', 'pkg@0.2.0'] }).skip, /pinned/);
  assert.match(parseNpx({ command: 'npx', args: ['-y', 'pkg@^1.2'] }).skip, /pinned/);
  assert.match(parseNpx({ type: 'http', url: 'https://example.com/mcp' }).skip, /remote/);
  assert.match(parseNpx({ command: 'python', args: ['server.py'] }).skip, /not npx/);
  assert.match(parseNpx({ command: 'node', args: ['/opt/mcp-fast-launch/launch.mjs', 'pkg', '--'] }).skip, /on launcher/);
  assert.match(parseNpx({ command: 'npx', args: ['-y', './local-dir'] }).skip, /not a registry package/);
  assert.match(parseNpx({ command: 'npx', args: ['--package', 'x', 'y'] }).skip, /flags/);
});

test('mask hides secret-looking args', () => {
  assert.deepEqual(mask(['--access-token', 'abc', '--port', '1']), ['--access-token', '***', '--port', '1']);
  assert.deepEqual(mask(['--api-key=xyz']), ['--api-key=***']);
  assert.deepEqual(mask(['ghp_123', 'a'.repeat(40), 'plain']), ['***', '***', 'plain']);
});

test('expander fills ${VAR} and ${VAR:-default}, records missing', () => {
  const missing = new Set();
  const ex = expander(missing, { A: '1' });
  assert.equal(ex('x=${A} y=${B:-two} z=${C}'), 'x=1 y=two z=');
  assert.deepEqual([...missing], ['C']);
});

test('excludeRegex and forbiddenCheck', () => {
  const re = excludeRegex(['node_modules', '.git']);
  assert.ok(re.test('C:\\a\\node_modules\\b\\.mcp.json'));
  assert.ok(re.test('/a/.git/x'));
  assert.ok(!re.test('/a/gitx/.mcp.json'));
  const f = forbiddenCheck([join(tmpdir(), 'nope')]);
  assert.ok(f(join(tmpdir(), 'nope', 'x.json')));
  assert.ok(!f(join(tmpdir(), 'nope2', 'x.json')));
});

test('claudeJsonPath respects CLAUDE_CONFIG_DIR', () => {
  assert.equal(claudeJsonPath({ CLAUDE_CONFIG_DIR: join('x', 'cfg') }), join('x', 'cfg', '.claude.json'));
  assert.equal(claudeJsonPath({}), join(homedir(), '.claude.json'));
});

test('entryFor picks the right bin', () => {
  const d = mkdtempSync(join(tmpdir(), 'mfl-'));
  try {
    const mk = (name, bin) => {
      const p = join(d, 'node_modules', ...name.split('/'));
      mkdirSync(p, { recursive: true });
      writeFileSync(join(p, 'package.json'), JSON.stringify({ name, bin }));
      return p;
    };
    const a = mk('one', 'cli.js');
    assert.equal(entryFor(d, 'one', ''), join(a, 'cli.js'));
    const b = mk('@s/two', { two: 'a.js', other: 'b.js' });
    assert.equal(entryFor(d, '@s/two', ''), join(b, 'a.js'));
    assert.equal(entryFor(d, '@s/two', 'other'), join(b, 'b.js'));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('onboard --dry-run on a copied .mcp.json reports and changes nothing', () => {
  const d = mkdtempSync(join(tmpdir(), 'mfl-'));
  try {
    const f = join(d, '.mcp.json');
    const body = JSON.stringify({ mcpServers: {
      a: { command: 'npx', args: ['-y', 'some-mcp@latest', '--x'] },
      b: { command: 'npx', args: ['-y', 'some-mcp@1.0.0'] },
      c: { type: 'http', url: 'https://example.com' },
    } }, null, 2);
    writeFileSync(f, body);
    const r = spawnSync(process.execPath, [join(repo, 'onboard.mjs'), '--dry-run', '--config', f], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CONVERT\s+a /);
    assert.match(r.stdout, /skip\s+b .*pinned 1\.0\.0/);
    assert.match(r.stdout, /skip\s+c .*remote/);
    assert.match(r.stdout, /1 entry would move/);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
