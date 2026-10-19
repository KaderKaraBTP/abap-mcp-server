/**
 * `mbt build` without GNU Make: the same steps the generated Makefile runs,
 * one after the other. Output: mta_archives/abap-mcp-server.mtar.
 *
 * Where `make` is installed, `mbt build` does the same.
 */

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const target = join(root, 'mta_archives');
const tmp = join(target, '.abap-mcp-server_mta_build_tmp');

const mbt = (args) => {
  console.log(`[mtar] mbt ${args}`);
  execSync(`mbt ${args}`, { cwd: root, stdio: 'inherit', shell: true });
};

rmSync(target, { recursive: true, force: true });
mbt('validate -r=true -x="paths"');
mbt(`module build -m=abap-mcp-server -p=cf -t="${target}"`);
// gen meta reads resource files (the XSUAA config) from the build folder.
mkdirSync(tmp, { recursive: true });
copyFileSync(join(root, 'xs-security.json'), join(tmp, 'xs-security.json'));
mbt(`gen meta -p=cf -t="${target}"`);
mbt(
  `gen mtar --mtar=abap-mcp-server.mtar --target_provided=true -t="${target}"`,
);
mbt(`clean -t="${target}"`);
console.log(`[mtar] ${join(target, 'abap-mcp-server.mtar')}`);
