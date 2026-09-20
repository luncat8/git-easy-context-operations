/**
 * The manifest is part of the product: a command that is registered but not
 * contributed does nothing, a menu entry pointing at a missing command shows a
 * dead item, and a proposed-API key without `enabledApiProposals` blocks
 * activation entirely. These tests keep `package.json` and the code in sync.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_KEYS, DEFAULT_SETTINGS, type Settings } from '../../core/config';

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
	name: string;
	version: string;
	publisher: string;
	license: string;
	main: string;
	engines: { vscode: string };
	activationEvents: string[];
	extensionDependencies: string[];
	enabledApiProposals?: string[];
	contributes: {
		commands: { command: string; title: string; category?: string; icon?: string }[];
		submenus: { id: string; label: string }[];
		menus: Record<string, { command?: string; submenu?: string; when?: string; group?: string }[]>;
		views: Record<string, { id: string; name: string; visibility?: string }[]>;
		viewsWelcome: { view: string; contents: string }[];
		configuration: { title: string; properties: Record<string, { type: string; default?: unknown; enum?: unknown[]; items?: { type: string } }> };
	};
	scripts: Record<string, string>;
};

const sourceOf = (relative: string) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/** Menu keys VS Code renders without a proposed API. */
const STABLE_MENU_KEYS = new Set([
	'commandPalette',
	'view/title',
	'view/item/context',
	'scm/title',
	'scm/sourceControl',
	'scm/resourceGroup/context',
	'scm/resourceState/context',
	'scm/repository',
	'timeline/item/context',
	'editor/context',
	'editor/title',
	'explorer/context',
]);
const PROPOSED_MENU_KEYS = ['scm/historyItem/context', 'scm/historyItemRef/context', 'scm/history/title'];

describe('manifest - commands', () => {
	const declared = manifest.contributes.commands.map((c) => c.command);

	it('declares every command the extension registers, and registers every command it declares', () => {
		const extensionSource = sourceOf('src/extension.ts');
		// Only the command table and the registerCommand() calls, not context keys
		// such as 'geco.repositoryOpen' or state keys such as 'geco.graphMenuHintShown'.
		const registered = [
			...new Set([
				...extensionSource.matchAll(/\['(geco\.[A-Za-z]+)'/g),
				...extensionSource.matchAll(/registerCommand\('(geco\.[A-Za-z]+)'/g),
			].map((m) => m[1]!)),
		];
		assert.ok(registered.length >= 14, `expected the command table, found ${registered.length}`);

		for (const id of registered) {
			assert.ok(declared.includes(id), `${id} is registered in src/extension.ts but missing from package.json`);
		}
		for (const id of declared) {
			assert.ok(registered.includes(id), `${id} is contributed but never registered`);
		}
	});

	it('gives every command a title, the Git Easy Ops category and an icon', () => {
		for (const command of manifest.contributes.commands) {
			assert.ok(command.title && command.title.length > 0, `${command.command} has no title`);
			assert.equal(command.category, 'Git Easy Ops', `${command.command} is not categorised`);
			assert.match(command.icon ?? '', /^\$\([a-z0-9-]+\)$/, `${command.command} has no codicon`);
		}
	});

	it('has unique command ids and no duplicate titles', () => {
		assert.equal(new Set(declared).size, declared.length);
		const titles = manifest.contributes.commands.map((c) => c.title);
		assert.equal(new Set(titles).size, titles.length);
	});

	it('keeps the five requested operations in the palette', () => {
		for (const id of [
			'geco.rewordCommit',
			'geco.rewordCommitAppend',
			'geco.fastForwardDefaultBranch',
			'geco.fastForwardBranch',
			'geco.forcePush',
			'geco.applyPatchAtProperBase',
			'geco.findProperBase',
			'geco.undoLastOperation',
			'geco.createBackupBranch',
			'geco.showBackups',
			'geco.createBranch',
			'geco.renameBranch',
			'geco.deleteBranch',
			'geco.checkoutBranch',
		]) {
			const hidden = (manifest.contributes.menus.commandPalette ?? []).some((e) => e.command === id && e.when === 'false');
			assert.equal(hidden, false, `${id} is hidden from the command palette`);
		}
	});
});

describe('manifest - menus', () => {
	const declared = new Set(manifest.contributes.commands.map((c) => c.command));
	const submenus = new Set(manifest.contributes.submenus.map((s) => s.id));

	it('only references commands and submenus that exist', () => {
		for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
			for (const entry of entries) {
				if (entry.command) {
					assert.ok(declared.has(entry.command), `${menu} references unknown command ${entry.command}`);
				}
				if (entry.submenu) {
					assert.ok(submenus.has(entry.submenu), `${menu} references unknown submenu ${entry.submenu}`);
				}
				assert.ok(entry.command || entry.submenu, `${menu} has an empty entry`);
			}
		}
	});

	it('fills every declared submenu', () => {
		for (const id of submenus) {
			const entries = manifest.contributes.menus[id] ?? [];
			assert.ok(entries.length >= 3, `submenu ${id} has only ${entries.length} entries`);
		}
	});

	it('stays on stable menu keys so it works in VS Code and VSCodium alike', () => {
		for (const menu of Object.keys(manifest.contributes.menus)) {
			assert.ok(
				STABLE_MENU_KEYS.has(menu) || submenus.has(menu),
				`menu "${menu}" needs a proposed API - keep it out of the default manifest (npm run graph-menu:on)`,
			);
		}
	});

	it('ships without proposed APIs enabled, so a normal install can activate', () => {
		assert.equal(manifest.enabledApiProposals, undefined);
		for (const key of PROPOSED_MENU_KEYS) {
			assert.equal(key in manifest.contributes.menus, false, `${key} requires enabledApiProposals`);
		}
	});

	it('points the commit and branch submenus at the tree view items', () => {
		const itemContext = manifest.contributes.menus['view/item/context'] ?? [];
		const when = itemContext.map((e) => e.when ?? '');
		assert.ok(when.some((w) => /viewItem =~ \/\^geco\\\.commit/.test(w)), 'no commit item menu');
		assert.ok(when.some((w) => /viewItem =~ \/\^geco\\\.branch/.test(w)), 'no branch item menu');
		for (const entry of itemContext) {
			assert.match(entry.when ?? '', /^view == geco\.history && /, 'item menus must be scoped to our view');
		}
	});

	it('makes our own view the graph: lanes first, expanded, with branch badges', () => {
		const treeSource = sourceOf('src/vscode/treeView.ts');
		assert.match(treeSource, /export const GROUP_GRAPH = 'Graph'/);
		// The graph group comes first and opens itself, so the panel looks like
		// the built-in graph instead of a collapsed list of groups.
		assert.match(treeSource, /new GecoTreeItem\(repoPath, 'group', GROUP_GRAPH, \{[^}]*collapsible: 'expanded'/, 'the graph group is not expanded');
		assert.match(treeSource, /GEcoTreeItem\(repoPath, 'branch', ref\.name|GecoTreeItem\(repoPath, 'branch', ref\.name/, 'ref badges are not rendered as branch nodes');
		assert.match(treeSource, /controller\(\)\.graphRows\(repoPath\)/, 'the graph group does not ask for graph rows');
	});

	it('matches the contextValue strings the tree view actually produces', () => {
		const treeSource = sourceOf('src/vscode/treeView.ts');
		const produced = [...new Set([...treeSource.matchAll(/contextValue: '(geco\.[a-z.]+)'/g)].map((m) => m[1]!))];
		assert.deepEqual(produced.sort(), ['geco.backup', 'geco.branch', 'geco.commit', 'geco.empty', 'geco.group', 'geco.group.graph']);

		const itemContext = manifest.contributes.menus['view/item/context'] ?? [];
		const patterns = itemContext
			.map((e) => /viewItem =~ \/(.*)\//.exec(e.when ?? '')?.[1])
			.filter((p): p is string => Boolean(p))
			.map((p) => new RegExp(p));
		// Exact `viewItem ==` matches count too: the Graph group row carries the
		// whole-graph operation as an inline button.
		const exact = itemContext
			.map((e) => /viewItem == ([\w.]+)$/.exec(e.when ?? '')?.[1])
			.filter((p): p is string => Boolean(p));
		const matched = produced.filter((value) => patterns.some((pattern) => pattern.test(value)) || exact.includes(value));
		assert.deepEqual(matched.sort(), ['geco.backup', 'geco.branch', 'geco.commit', 'geco.group.graph'], 'every actionable node has a menu');
	});

	it('gives the whole graph a clean-history button and keeps it below every per-commit item', () => {
		// The operation is repository-wide, so it belongs to the graph as a
		// whole: a toolbar button of the view, the inline (trash) button of the
		// "Graph" group row, that row's context menu, and - because a commit row
		// is where everybody right-clicks first - the *bottom* of the commit
		// menu and of the "Git Easy Ops" submenu. It must never sit in one of
		// the per-commit groups (message / commit / branch / move / remote / patch).
		const title = manifest.contributes.menus['view/title'] ?? [];
		const toolbar = title.find((e) => e.command === 'geco.cleanHistory');
		assert.ok(toolbar, 'no clean-history button in the view toolbar');
		assert.equal(toolbar!.group, 'navigation@2', 'the toolbar button does not sit next to Refresh');
		assert.match(toolbar!.when ?? '', /geco\.repositoryOpen/, 'the toolbar button shows without a repository');

		const itemContext = manifest.contributes.menus['view/item/context'] ?? [];
		const graphRow = itemContext.filter((e) => e.command === 'geco.cleanHistory' && (e.when ?? '').includes('geco.group.graph'));
		assert.ok(graphRow.some((e) => e.group === 'inline@1'), 'the Graph group row has no inline clean button');
		assert.ok(graphRow.some((e) => (e.group ?? '').startsWith('9_clean@')), 'the Graph group row has no context-menu entry');

		const commitEntry = itemContext.find((e) => e.command === 'geco.cleanHistory' && /viewItem =~ \/\^geco\\\.commit/.test(e.when ?? ''));
		assert.ok(commitEntry, 'the commit rows have no clean-history fallback');
		assert.match(commitEntry!.group ?? '', /^8_clean@/, 'the whole-graph item is not in its own below-all group');
		// Every other commit-row item lives in one of the per-commit groups;
		// the repository-wide operation must not pretend to be one of them.
		const perCommitGroups = new Set(
			itemContext
				.filter((e) => /viewItem =~ \/\^geco\\\.commit/.test(e.when ?? '') && e.command !== 'geco.cleanHistory')
				.map((e) => (e.group ?? '').split('@')[0]!),
		);
		assert.equal(perCommitGroups.has('8_clean'), false, '8_clean is shared with a per-commit item');
		for (const group of ['1_message', '2_commit', '3_branch', '4_move', '5_remote', '6_patch']) {
			assert.ok(perCommitGroups.has(group), `the ${group} group disappeared`);
		}

		const submenu = (manifest.contributes.menus['geco.commitSubmenu'] ?? []).map((e) => e.command);
		// The required "Customize Context Menus..." entry comes after it, but
		// among the toggleable entries the whole-graph operation is last.
		const toggleable = submenu.filter((id) => id !== 'geco.customizeMenus');
		assert.equal(toggleable[toggleable.length - 1], 'geco.cleanHistory', 'the submenu does not end with the whole-graph operation');
		assert.equal(submenu[submenu.length - 1], 'geco.customizeMenus', 'the required way back is the last entry');
	});

	it('scopes title menus to our own views', () => {
		for (const entry of manifest.contributes.menus['view/title'] ?? []) {
			// The toolbar buttons may additionally require an open repository -
			// but never another view. The menu editor contributes its own view
			// (its reset button lives on the editor's toolbar).
			assert.match(
				entry.when ?? '',
				/^view == geco\.(history|menuEditor)( && geco\.repositoryOpen)?( && \(!geco\.menuFilter.*)?$/,
				entry.command,
			);
		}
	});

	it('puts our own view items straight into categories instead of a submenu', () => {
		// A submenu one extension deep is a puzzle ("which extension owns this?")
		// - in our own view every entry is a first-class citizen, grouped the way
		// the built-in menus group theirs.
		const itemContext = manifest.contributes.menus['view/item/context'] ?? [];
		assert.equal(itemContext.some((entry) => entry.submenu), false, 'our own view still nests a submenu');
		const commitGroups = itemContext
			.filter((entry) => /viewItem =~ \/\^geco\\.commit/.test(entry.when ?? ''))
			.map((entry) => entry.group ?? '');
		assert.ok(commitGroups.some((group) => group.startsWith('1_message@')), 'messages are not grouped first');
		assert.ok(commitGroups.some((group) => group.startsWith('2_commit@')), 'the squash items are not in their own group');
		assert.ok(commitGroups.every((group) => group !== '1_geco@1'), 'an old catch-all group survived');
	});

	it('offers squash for one selection and for N previous commits', () => {
		const itemContext = manifest.contributes.menus['view/item/context'] ?? [];
		const commitItems = itemContext.filter((entry) => /viewItem =~ \/\^geco\\.commit/.test(entry.when ?? '')).map((entry) => entry.command);
		assert.ok(commitItems.includes('geco.squashSelectedCommits'), 'no multi-select squash on a commit row');
		assert.ok(commitItems.includes('geco.squashWithPreviousCommits'), 'no "squash with previous" on a commit row');

		// The Source Control title / repository row / Timeline menus have no
		// multi-select, so only the "N previous commits" variant is offered there.
		const submenu = (manifest.contributes.menus['geco.commitSubmenu'] ?? []).map((entry) => entry.command);
		assert.ok(submenu.includes('geco.squashWithPreviousCommits'), 'the submenu has no squash item');
		assert.equal(submenu.includes('geco.squashSelectedCommits'), false, 'multi-select squash does not belong in a single-commit menu');
	});

	it('keeps the proposed graph build flat and free of duplicates', () => {
		const script = sourceOf('scripts/apply-graph-menu.mjs');
		const graphMenus = script.slice(script.indexOf('const GRAPH_MENUS'), script.indexOf('const action ='));
		assert.equal(graphMenus.includes('submenu:'), false, 'the graph build still nests a submenu');
		// Git's own graph menu already has checkout / create branch / create tag /
		// cherry pick, and delete branch on a ref - repeating them would give the
		// user two entries with the same title.
		for (const duplicate of ['geco.checkoutBranch', 'geco.createBranch', 'geco.deleteBranch']) {
			assert.equal(graphMenus.includes(duplicate), false, `${duplicate} duplicates a built-in graph item`);
		}
		assert.ok(graphMenus.includes('geco.renameBranch'), 'the graph build has no rename-branch item');
		assert.ok(graphMenus.includes('geco.squashWithPreviousCommits'), 'the graph build has no squash item');
		assert.match(graphMenus, /'scm\/historyItem\/context': \[/, 'the graph build is missing the commit menu');
	});

	it('offers create / rename / delete / check out in the branch submenu', () => {
		// The branch submenu is what the Source Control Graph shows on a *ref* row
		// (scm/historyItemRef/context) and what our own view shows on a branch node.
		const commands = (manifest.contributes.menus['geco.branchSubmenu'] ?? []).map((e) => e.command);
		for (const id of ['geco.createBranch', 'geco.renameBranch', 'geco.checkoutBranch', 'geco.deleteBranch']) {
			assert.ok(commands.includes(id), `${id} is missing from geco.branchSubmenu`);
		}
		assert.ok(commands.indexOf('geco.renameBranch') > commands.indexOf('geco.createBranch'), 'rename comes after create');
		assert.ok(commands.indexOf('geco.deleteBranch') > commands.indexOf('geco.renameBranch'), 'the destructive item comes last');
		assert.ok(commands.includes('geco.forcePush'), 'the existing branch operations are still there');
	});

	it('lets a commit row create a branch at that commit', () => {
		const commands = (manifest.contributes.menus['geco.commitSubmenu'] ?? []).map((e) => e.command);
		assert.ok(commands.includes('geco.createBranch'), 'geco.commitSubmenu has no create-branch item');
	});

	it('offers the operations in the Source Control title and repository menus', () => {
		assert.ok((manifest.contributes.menus['scm/title'] ?? []).some((e) => e.submenu === 'geco.commitSubmenu'));
		assert.ok((manifest.contributes.menus['scm/sourceControl'] ?? []).some((e) => e.submenu === 'geco.commitSubmenu'));
		for (const entry of [...(manifest.contributes.menus['scm/title'] ?? []), ...(manifest.contributes.menus['scm/sourceControl'] ?? [])]) {
			assert.match(
				entry.when ?? '',
				/^scmProvider == git && \(!geco\.menuFilter \|\| geco\.menuHasItems\.geco\.commitSubmenu\)$/,
				'the submenu parent must keep its fail-open guard',
			);
		}
	});

	it('hooks into the Timeline per-commit menu with the git provider context value', () => {
		const timeline = manifest.contributes.menus['timeline/item/context'] ?? [];
		assert.equal(timeline.length, 1);
		assert.equal(timeline[0]!.submenu, 'geco.commitSubmenu');
		// The built-in git timeline tags commit rows 'git:file:commit' (and staged /
		// working-tree rows with other values, where our commands make no sense).
		assert.match(timeline[0]!.when ?? '', /^timelineItem == git:file:commit && \(!geco\.menuFilter/);
	});

	it('also offers the submenu on the repository row of the Source Control view', () => {
		const entries = manifest.contributes.menus['scm/repository'] ?? [];
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.submenu, 'geco.commitSubmenu');
		assert.match(entries[0]!.when ?? '', /^scmProvider == git && \(!geco\.menuFilter/);
	});
});

describe('manifest - views and configuration', () => {
	it('contributes the history view in the Source Control container with a welcome message', () => {
		const views = manifest.contributes.views.scm ?? [];
		assert.equal(views.length, 2);
		assert.equal(views[0]!.id, 'geco.history');
		assert.equal(views[0]!.name, 'Git Easy Ops');
		// The menu editor ships hidden: it costs nothing until the user asks
		// for it ("Customize Context Menus..." focuses and reveals it).
		assert.equal(views[1]!.id, 'geco.menuEditor');
		assert.equal(views[1]!.visibility, 'hidden');
		assert.equal(manifest.contributes.viewsWelcome.length, 1);
		assert.equal(manifest.contributes.viewsWelcome[0]!.view, 'geco.history');
		assert.match(manifest.contributes.viewsWelcome[0]!.contents, /No Git repository/);
	});

	it('declares exactly the settings the core knows about', () => {
		const properties = manifest.contributes.configuration.properties;
		const declared = Object.keys(properties).sort();
		const known = Object.values(CONFIG_KEYS).sort();
		assert.deepEqual(declared, known);
	});

	it('documents defaults that match DEFAULT_SETTINGS', () => {
		const properties = manifest.contributes.configuration.properties;
		for (const [key, configKey] of Object.entries(CONFIG_KEYS) as [keyof Settings, string][]) {
			const property = properties[configKey];
			assert.ok(property, `${configKey} is missing`);
			const expected = DEFAULT_SETTINGS[key];
			assert.deepEqual(property.default, expected, `${configKey} default`);
			if (property.enum) {
				assert.ok(property.enum.includes(expected as never), `${configKey} default is not in its enum`);
			}
			const type = typeof expected;
			assert.equal(property.type, Array.isArray(expected) ? 'array' : type === 'number' ? 'number' : type, `${configKey} type`);
			if (Array.isArray(expected)) {
				assert.deepEqual(property.items, { type: 'string' }, `${configKey} items`);
			}
			assert.ok(
				(property as { markdownDescription?: string; description?: string }).markdownDescription
					|| (property as { description?: string }).description,
				`${configKey} is not described`,
			);
		}
	});
});

describe('manifest - packaging', () => {
	it('is wired for the bundled extension host entry point', () => {
		assert.equal(manifest.main, './dist/extension.js');
		assert.deepEqual(manifest.extensionDependencies, ['vscode.git']);
		assert.ok(manifest.activationEvents.includes('onStartupFinished'));
		assert.match(manifest.engines.vscode, /^\^1\.\d+\.\d+$/);
	});

	it('has build, test and graph-menu scripts that point at real files', () => {
		for (const script of Object.values(manifest.scripts)) {
			for (const file of [...script.matchAll(/(?:node|tsc)\s+(?:[^|&;]*?\s)?((?:scripts|src|esbuild)[\w./-]+)/g)].map((m) => m[1]!)) {
				assert.ok(fs.existsSync(path.join(ROOT, file)), `${file} referenced by "${script}" does not exist`);
			}
		}
		assert.ok(fs.existsSync(path.join(ROOT, 'esbuild.js')));
		assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'apply-graph-menu.mjs')));
		assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'run-vscode-tests.mjs')));
	});

	it('keeps the test script pointed at the compiled test tree', () => {
		assert.match(manifest.scripts.test!, /out\/src\/test/);
		assert.match(manifest.scripts.test!, /--test/);
	});

	it('is versioned and licensed', () => {
		assert.match(manifest.version, /^\d+\.\d+\.\d+/);
		assert.equal(manifest.license, 'MIT');
		assert.ok(fs.existsSync(path.join(ROOT, 'LICENSE')));
		assert.ok(fs.existsSync(path.join(ROOT, 'README.md')));
		assert.ok(fs.existsSync(path.join(ROOT, 'CHANGELOG.md')));
		assert.ok(fs.existsSync(path.join(ROOT, '.vscodeignore')));
	});
});
