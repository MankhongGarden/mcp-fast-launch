import { readFileSync, existsSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { homedir } from 'node:os';

export const DEFAULT_CONFIG = {
  scanDirs: [],
  exclude: ['_archive', 'node_modules', 'plugin', '.git'],
  forbiddenPaths: [],
  backupDir: null,
  claudePath: null,
  everythingPath: null,
  notifyCommand: null,
};

export function loadConfig(file) {
  if (!existsSync(file)) return { ...DEFAULT_CONFIG };
  return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, '')) };
}

export function claudeJsonPath(env = process.env, override = null) {
  if (override) return join(override, '.claude.json');
  if (env.CLAUDE_CONFIG_DIR) return join(env.CLAUDE_CONFIG_DIR, '.claude.json');
  return join(homedir(), '.claude.json');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const excludeRegex = (names) =>
  names.length ? new RegExp(`[\\\\/](${names.map(escapeRe).join('|')})[\\\\/]`, 'i') : /$^/;

export function forbiddenCheck(prefixes) {
  const norm = (p) => resolve(p).replace(/[\\/]+$/, '').toLowerCase();
  const list = prefixes.map(norm);
  return (p) => {
    const x = norm(p);
    return list.some((f) => x === f || x.startsWith(f + '\\') || x.startsWith(f + '/'));
  };
}

const SECRET = /token|key|secret|password|passwd/i;
export function mask(args) {
  return args.map((a, i) => {
    const s = String(a), prev = String(args[i - 1] ?? '');
    if (prev.startsWith('-') && SECRET.test(prev) && !s.startsWith('-')) return '***';
    const eq = s.match(/^(-{0,2}[^=\s]+)=(.*)$/);
    if (eq && SECRET.test(eq[1])) return `${eq[1]}=***`;
    if (/^(sbp_|ghp_|gho_|github_pat_|sk-|xox)/.test(s) || /^[A-Za-z0-9_\-]{32,}$/.test(s)) return '***';
    return s;
  });
}

export function parseNpx(e) {
  if (!e || typeof e !== 'object') return { skip: 'invalid' };
  if (e.url || (e.type && e.type !== 'stdio')) return { skip: `remote (${e.type || 'url'})` };
  const cmd = basename(String(e.command || '')).toLowerCase();
  let a = (e.args || []).map(String);
  if (cmd === 'node' && a.some((x) => /[\\/]launch\.mjs$/i.test(x))) return { skip: 'on launcher' };
  if (cmd === 'cmd' || cmd === 'cmd.exe') {
    if (!/^\/c$/i.test(a[0] || '') || !/^npx(\.cmd)?$/i.test(a[1] || '')) return { skip: `not npx (${cmd})` };
    a = a.slice(2);
  } else if (!/^npx(\.cmd|\.exe)?$/.test(cmd)) return { skip: `not npx (${cmd || 'no command'})` };
  while (a[0] === '-y' || a[0] === '--yes') a.shift();
  const spec = a.shift();
  if (!spec || spec.startsWith('-')) return { skip: 'npx flags not supported' };
  const m = spec.match(/^(@[^/@\s]+\/[^@\s]+|[^@\s]+)(?:@(.*))?$/);
  if (!m || (/[:\\/]/.test(m[1]) && !m[1].startsWith('@'))) return { skip: `not a registry package (${spec})` };
  if (m[2] !== undefined && m[2] !== 'latest') return { skip: `pinned ${m[2]}` };
  return { pkg: m[1], serverArgs: a };
}

export function expander(missing, env = process.env) {
  return (s) => String(s).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n, d) => {
    if (env[n] !== undefined) return env[n];
    if (d === undefined) missing.add(n);
    return d ?? '';
  });
}
