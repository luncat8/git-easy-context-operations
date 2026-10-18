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
		{ command: 'geco.squashWithPreviousCommits', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.squashWithPreviousCommits)', group: '4_modify@2' },
		{ command: 'geco.rewordCommit', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.rewordCommit)', group: '4_modify@3' },
		{ command: 'geco.rewordCommitAppend', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.rewordCommitAppend)', group: '4_modify@4' },
		{ command: 'geco.rewordCommitRename', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.rewordCommitRename)', group: '4_modify@5' },
		// The branch group of the built-in graph: "Create Branch..." is git.branch
		// at 2_branch@2, so the branch cleanup lands directly behind it - last in
		// that group, exactly like on the extension's own commit rows.
		{ command: 'geco.removeRedundantBranches', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.removeRedundantBranches)', group: '2_branch@3' },
		{ command: 'geco.fastForwardDefaultBranch', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.fastForwardDefaultBranch)', group: '7_move@1' },
		{ command: 'geco.fastForwardBranch', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.fastForwardBranch)', group: '7_move@2' },
		{ command: 'geco.createBackupBranch', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.createBackupBranch)', group: '7_move@3' },
		{ command: 'geco.forcePush', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.forcePush)', group: '8_remote@1' },
		{ command: 'geco.forcePushHard', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.forcePushHard)', group: '8_remote@2' },
		{ command: 'geco.copyCommitSha', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.copyCommitSha)', group: 'inline@1' },
		{ command: 'geco.enableGraphMenu', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.enableGraphMenu)', group: '9_misc@1' },
		{ command: 'geco.customizeMenus', when: 'scmProvider == git', group: '9_misc@2' },
	],
	// VS Code builds this menu per *ref* and only looks at plain commands
	// (`isIMenuItem`), turning each one into a "Title > <ref>" submenu of the
	// commit row menu. A contributed `submenu` here would be silently dropped -
	// which is why the branch operations are their own entries. Checkout and
	// delete are already git's own items on that row (`1_checkout@1`,
	// `2_branch@2`), and fast-forwarding the ref to the very commit it points at
	// would do nothing, so this build adds **rename** (git has no rename in the
	// graph at all).
	//
	// The branch cleanup is deliberately NOT here: VS Code would expand it into
	// one "Remove Redundant Branches... > <branch>" entry per ref badge, and a
	// sub-item carrying the *selected* branch name reads as "this branch gets
	// deleted" - the exact opposite of what the command does. It is a
	// whole-graph sweep whose target list is only known after the scan, so it
	// lives flat on the commit row menu and on the graph toolbar instead;
	// clicking it opens the checkbox list of what actually goes.
	'scm/historyItemRef/context': [
		{ command: 'geco.renameBranch', when: `${BRANCH_WHEN} && (!geco.menuFilter || geco.menuVisible.geco.renameBranch)`, group: '2_branch@3' },
	],
	// Deliberately NO refresh here: the built-in graph caption already has its
	// own refresh button, and a second one for the same action reads as a bug.
	// (Our own view's toolbar keeps `geco.refresh` - that caption has no
	// built-in equivalent.) Every Git Easy Ops operation also asks the git
	// extension to re-sync its state, so the built-in button is enough.
	'scm/history/title': [
		// The built-in graph already supplies Refresh. Keep the Git Easy Ops
		// toolbar in the same order as the stable view: patch work first, then
		// history rewrites, repository maintenance, and Undo as the last action.
		// A patch comes from a file and lands at the base the search finds, so it
		// is about the whole repository - never about the commit a right-click
		// landed on.
		{ command: 'geco.applyPatchAtProperBase', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.applyPatchAtProperBase)', group: 'navigation@1' },
		{ command: 'geco.applyPatchAutomatically', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.applyPatchAutomatically)', group: 'navigation@2' },
		{ command: 'geco.findProperBase', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.findProperBase)', group: 'navigation@3' },
		// These two commands have useful no-selection fallbacks: they open the
		// commit picker, so the graph header can offer them without pretending
		// that a toolbar has a selected row.
		{ command: 'geco.squashWithPreviousCommits', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.squashWithPreviousCommits)', group: 'navigation@4' },
		{ command: 'geco.rewordCommit', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.rewordCommit)', group: 'navigation@5' },
		// Whole-repository maintenance follows the history actions.
		{ command: 'geco.cleanHistory', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.cleanHistory)', group: 'navigation@6' },
		{ command: 'geco.removeRedundantBranches', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.removeRedundantBranches)', group: 'navigation@7' },
		// Repository-wide, like Clean History: the link to the repo on the web.
		{ command: 'geco.copyRepositoryWebLink', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.copyRepositoryWebLink)', group: 'navigation@8' },
		// Same surface, one more repository-wide answer: "why can I not push or
		// sync?" - the state it explains usually becomes visible in this graph.
		{ command: 'geco.diagnosePushSync', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.diagnosePushSync)', group: 'navigation@9' },
		// Undo opens the same newest-first journal picker as the Command Palette
		// command. It is deliberately the last operation in the toolbar.
		{ command: 'geco.undoLastOperation', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.undoLastOperation)', group: 'navigation@10' },
		{ command: 'geco.explainMenus', when: 'scmProvider == git && (!geco.menuFilter || geco.menuVisible.geco.explainMenus)', group: '9_geco@1' },
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
	console.log(`  code --install-extension dist/${manifest.name}-${manifest.version}.vsix`);
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
