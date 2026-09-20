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
const BRANCH_WHEN = 'scmProvider == git && scmHistoryItemRef =~ /^refs\\/heads\\//';

const GRAPH_MENUS = {
	// Flattened into the groups the built-in git items already use, so nobody has
	// to look for a "Git Easy Ops" submenu and no command is duplicated: the
	// built-in graph already offers checkout / create branch / create tag /
	// cherry pick and (on a ref) checkout + delete branch, so this build adds
	// what it does not have.
	'scm/historyItem/context': [
		{ command: 'geco.squashWithPreviousCommits', when: 'scmProvider == git', group: '4_modify@2' },
		{ command: 'geco.rewordCommit', when: 'scmProvider == git', group: '4_modify@3' },
		{ command: 'geco.rewordCommitAppend', when: 'scmProvider == git', group: '4_modify@4' },
		{ command: 'geco.rewordCommitRename', when: 'scmProvider == git', group: '4_modify@5' },
		{ command: 'geco.applyPatchAtProperBase', when: 'scmProvider == git', group: '6_patch@1' },
		{ command: 'geco.findProperBase', when: 'scmProvider == git', group: '6_patch@2' },
		{ command: 'geco.fastForwardDefaultBranch', when: 'scmProvider == git', group: '7_move@1' },
		{ command: 'geco.fastForwardBranch', when: 'scmProvider == git', group: '7_move@2' },
		{ command: 'geco.createBackupBranch', when: 'scmProvider == git', group: '7_move@3' },
		{ command: 'geco.forcePush', when: 'scmProvider == git', group: '8_remote@1' },
		{ command: 'geco.forcePushHard', when: 'scmProvider == git', group: '8_remote@2' },
		{ command: 'geco.copyCommitSha', when: 'scmProvider == git', group: 'inline@1' },
		{ command: 'geco.enableGraphMenu', when: 'scmProvider == git', group: '9_misc@1' },
	],
	// VS Code builds this menu per *ref* and only looks at plain commands
	// (`isIMenuItem`), turning each one into a "Title > <ref>" submenu of the
	// commit row menu. A contributed `submenu` here would be silently dropped -
	// which is why the branch operation is its own entry. Checkout and delete
	// are already git's own items on that row, and fast-forwarding the ref to
	// the very commit it points at would do nothing, so **rename** is what this
	// build adds here (git has no rename in the graph at all).
	'scm/historyItemRef/context': [
		{ command: 'geco.renameBranch', when: BRANCH_WHEN, group: '2_branch@3' },
	],
	'scm/history/title': [
		{ command: 'geco.refresh', when: 'scmProvider == git', group: 'navigation@90' },
		// The whole-graph operation gets the toolbar of the built-in graph too:
		// it is not about one commit, so it never joins the per-commit menu.
		{ command: 'geco.cleanHistory', when: 'scmProvider == git', group: 'navigation@91' },
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
	console.log('Build and install the graph build, then allow the proposal - no command line needed:');
	console.log('  npm run package');
	console.log(`  code --install-extension ${manifest.name}-${manifest.version}.vsix`);
	console.log('  - or, without touching any command line, inside the editor run');
	console.log('    "Git Easy Ops: Enable Source Control Graph Menu..." and pick product.json.');
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
	console.log('  Allow the proposal for the extension id in either of these:');
	console.log('    product.json -> extensionEnabledApiProposals  (no command line at all)');
	console.log('    argv.json    -> enable-proposed-api           (per user, one restart)');
	console.log('  "Git Easy Ops: Enable Source Control Graph Menu..." writes either entry.');
	console.log('  Stable entry points are always on: the "Git Easy Ops" view in the Source');
	console.log('  Control sidebar (its Graph group), scm/title, scm/sourceControl,');
	console.log('  timeline/item/context and the Command Palette.');
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
