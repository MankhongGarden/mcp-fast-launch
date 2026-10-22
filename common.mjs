import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const root = dirname(fileURLToPath(import.meta.url));

export const pkgDir = (pkg) => join(root, 'pkgs', pkg.replace(/[\/@]/g, '_'));

export function entryFor(versionDir, name, wanted) {
  const dir = join(versionDir, 'node_modules', ...name.split('/'));
  const bin = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).bin;
  if (typeof bin === 'string') return join(dir, bin);
  const base = name.split('/').pop();
  const key = wanted || (bin[base] ? base : Object.keys(bin)[0]);
  return join(dir, bin[key]);
}

export const npmArgs = (target, spec) =>
  ['install', '--prefix', `"${target}"`, spec, '--save-exact', '--no-fund', '--no-audit', '--loglevel', 'error'];
