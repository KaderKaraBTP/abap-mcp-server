/**
 * Builds the Cloud Foundry module from THIS checkout (run by `mbt build`, or
 * `npm run build` in btp/):
 *
 * 1. compiles the lib (repo root) and the core server (server/);
 * 2. packs both into btp/vendor/ as lib.tgz and core.tgz, which
 *    btp/package.json depends on (`file:vendor/…`) — so CF installs exactly
 *    this code, not whatever is on npm;
 * 3. installs btp's dependencies and compiles btp/src to btp/dist.
 *
 * Cross-platform on purpose: mbt runs custom commands without a shell.
 */

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const btp = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(btp, '..');
const vendor = join(btp, 'vendor');

const run = (command, cwd) => {
  console.log(`[build] (${cwd === root ? '.' : cwd.slice(root.length + 1)}) ${command}`);
  execSync(command, { cwd, stdio: 'inherit', shell: true });
};

if (!existsSync(join(root, 'node_modules'))) {
  run('npm ci --ignore-scripts --no-audit --no-fund', root);
}

for (const dir of ['dist', 'server/dist']) {
  rmSync(join(root, dir), { recursive: true, force: true });
}
run('npx tsc -p tsconfig.json', root);
run('npx tsc -p server/tsconfig.json', root);

rmSync(vendor, { recursive: true, force: true });
mkdirSync(vendor, { recursive: true });
const pack = (cwd, target) => {
  run(`npm pack --ignore-scripts --pack-destination "${vendor}"`, cwd);
  const packed = readdirSync(vendor).find(
    (f) => f.endsWith('.tgz') && !['lib.tgz', 'core.tgz'].includes(f),
  );
  if (!packed) throw new Error(`npm pack produced no tarball in ${cwd}`);
  renameSync(join(vendor, packed), join(vendor, target));
};
pack(root, 'lib.tgz');
pack(join(root, 'server'), 'core.tgz');

rmSync(join(btp, 'node_modules'), { recursive: true, force: true });
rmSync(join(btp, 'package-lock.json'), { force: true });
rmSync(join(btp, 'dist'), { recursive: true, force: true });
run('npm install --no-audit --no-fund', btp);
run('npx tsc -p tsconfig.json', btp);
console.log('[build] btp module ready');
