#!/usr/bin/env node
/**
 * Opt in / out of the Source Control *Graph* context menu.
 *
 * That menu is a **proposed** VS Code API
 * (`contribSourceControlHistoryItemMenu` / `contribSourceControlHistoryTitleMenu`).
 * Contributing those keys is harmless - VS Code logs a warning and skips them -
 * but listing `enabledApiProposals` in a shipped manifest *blocks activation*
 * unless VS Code is started with `--enable-proposed-api <publisher>.<name>`.
 * So the default manifest stays clean and this script patches it on demand:
 *
 *   node scripts/apply-graph-menu.mjs on      # for a local, proposed-api-enabled build
 *   node scripts/apply-graph-menu.mjs off     # back to a publishable manifest
 *   node scripts/apply-graph-menu.mjs status
 *
 * The script is idempotent and keeps the rest of package.json untouched.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MANIFEST = path.join(ROOT, 'package.json');

const PROPOSALS = ['contribSourceControlHistoryItemMenu', 'contribSourceControlHistoryTitleMenu'];

/** Menu entries that only render when the proposals above are allowed. */
const GRAPH_MENUS = {
	'scm/historyItem/context': [
		{ submenu: 'geco.commitSubmenu', when: 'scmProvider == git', group: '9_geco@1' },
		{ command: 'geco.copyCommitSha', when: 'scmProvider == git', group: 'inline@1' },
	],
	'scm/historyItemRef/context': [{ submenu: 'geco.branchSubmenu', when: 'scmProvider == git', group: '9_geco@1' }],
	'scm/history/title': [
		{ command: 'geco.refresh', when: 'scmProvider == git', group: 'navigation@90' },
		{ command: 'geco.explainMenus', when: 'scmProvider == git', group: '9_geco@1' },
	],
};

const action = process.argv[2] ?? 'status';

function read() {
	return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

function write(manifest) {
	fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

function isEnabled(manifest) {
	const proposals = manifest.enabledApiProposals ?? [];
	const hasProposals = PROPOSALS.every((p) => proposals.includes(p));
	const hasMenus = Object.keys(GRAPH_MENUS).every((key) => Array.isArray(manifest.contributes?.menus?.[key]));
	return hasProposals && hasMenus;
}

function turnOn() {
	const manifest = read();
	manifest.enabledApiProposals = [...new Set([...(manifest.enabledApiProposals ?? []), ...PROPOSALS])];
	manifest.contributes.menus = { ...manifest.contributes.menus, ...structuredClone(GRAPH_MENUS) };
	write(manifest);
	console.log(`Graph menu enabled in ${path.relative(ROOT, MANIFEST)}.`);
	console.log('Build and install with the proposal allowed:');
	console.log('  npm run package');
	console.log(`  code --install-extension ${manifest.name}-${manifest.version}.vsix`);
	console.log(`  code --enable-proposed-api ${manifest.publisher}.${manifest.name}`);
	console.log('Run "npm run graph-menu:off" before publishing - VS Code rejects a');
	console.log('published manifest that asks for proposed APIs.');
}

function turnOff() {
	const manifest = read();
	if (Array.isArray(manifest.enabledApiProposals)) {
		const remaining = manifest.enabledApiProposals.filter((p) => !PROPOSALS.includes(p));
		if (remaining.length === 0) {
			delete manifest.enabledApiProposals;
		} else {
			manifest.enabledApiProposals = remaining;
		}
	}
	for (const key of Object.keys(GRAPH_MENUS)) {
		delete manifest.contributes.menus[key];
	}
	write(manifest);
	console.log(`Graph menu disabled; ${path.relative(ROOT, MANIFEST)} is publishable again.`);
}

function status() {
	const manifest = read();
	const enabled = isEnabled(manifest);
	console.log(`Source Control Graph menu: ${enabled ? 'ON' : 'OFF'}`);
	console.log(`  enabledApiProposals: ${JSON.stringify(manifest.enabledApiProposals ?? [])}`);
	console.log(`  proposed menu keys: ${Object.keys(GRAPH_MENUS).filter((k) => manifest.contributes?.menus?.[k]).join(', ') || '(none)'}`);
	console.log('  Stable entry points are always on: the "Git Easy Ops" view in the Source');
	console.log('  Control sidebar, scm/title, scm/sourceControl, timeline/item/context and');
	console.log('  the Command Palette.');
	process.exitCode = enabled ? 0 : 0;
}

switch (action) {
	case 'on':
		turnOn();
		break;
	case 'off':
		turnOff();
		break;
	case 'status':
		status();
		break;
	default:
		console.error(`usage: node scripts/apply-graph-menu.mjs on|off|status (got "${action}")`);
		process.exitCode = 2;
}
