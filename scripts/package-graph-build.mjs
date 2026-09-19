#!/usr/bin/env node
/**
 * Builds the "graph" flavour of the extension: the one that adds Git Easy Ops to
 * the commit context menu of VS Code's built-in Source Control Graph.
 *
 *   npm run package:graph              # build git-easy-ops-graph-<version>.vsix
 *   npm run package:graph -- --install # ...and install it into VS Code
 *
 * That menu is a *proposed* contribution point, and the Marketplace refuses
 * manifests that declare `enabledApiProposals`, so this flavour is built
 * separately and installed by hand. The script patches package.json, builds,
 * packages and always restores package.json afterwards.
 */
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'package.json');
const PATCHER = path.join(ROOT, 'scripts', 'apply-graph-menu.mjs');

const install = process.argv.includes('--install');
const cli = process.argv.find((arg) => arg.startsWith('--cli='))?.slice('--cli='.length) ?? 'code';

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const extensionId = `${manifest.publisher}.${manifest.name}`;
const outFile = path.join(ROOT, `${manifest.name}-${manifest.version}+graph.vsix`);

function run(command, args, label) {
	console.log(`\n== ${label}`);
	const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
	if (result.status !== 0) {
		throw new Error(`${label} failed (${result.status ?? result.signal})`);
	}
}

let patched = false;
try {
	run(process.execPath, [PATCHER, 'on'], 'Enable the Source Control Graph menus in package.json');
	patched = true;
	run(process.execPath, [path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '--noEmit'], 'Type-check');
	run(process.execPath, [path.join(ROOT, 'esbuild.js'), '--production'], 'Bundle');
	run(process.execPath, [
		path.join(ROOT, 'node_modules', '@vscode', 'vsce', 'vsce'),
		'package',
		'--no-dependencies',
		'--allow-missing-repository',
		'--out',
		outFile,
	], 'Package the graph build');

	if (install) {
		run(cli, ['--install-extension', outFile], `Install into ${cli}`);
	}
} finally {
	if (patched) {
		run(process.execPath, [PATCHER, 'off'], 'Restore package.json (publishable manifest)');
	}
}

const argvDir = {
	code: '~/.vscode',
	'code-insiders': '~/.vscode-insiders',
	codium: '~/.vscode-oss',
	cursor: '~/.cursor',
}[cli] ?? '~/.vscode';

console.log(`
Graph build ready: ${path.relative(ROOT, outFile)}

Two things are needed for the commit context menu to appear in the Source
Control Graph - VS Code only renders that menu for extensions it was explicitly
told to grant the proposed API to:

1) Install this build (not the publishable one):
     ${cli} --install-extension ${path.relative(ROOT, outFile)}

2) Allow the proposal, either persistently - Command Palette:
   "Preferences: Configure Runtime Arguments", then add to ${argvDir}/argv.json:
     {
       "enable-proposed-api": ["${extensionId}"]
     }
   or per launch:
     ${cli} --enable-proposed-api ${extensionId}

   Tip: "Git Easy Ops: Enable Source Control Graph Menu..." writes that line for
   you (with a backup of argv.json).

Then restart VS Code and right-click a commit in Source Control > Graph.

To go back to the publishable build:
     ${cli} --install-extension ${manifest.name}-${manifest.version}.vsix
`);
