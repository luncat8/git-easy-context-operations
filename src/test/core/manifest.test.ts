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
		views: Record<string, { id: string; name: string }[]>;
		viewsWelcome: { view: string; contents: string }[];
		configuration: { title: string; properties: Record<string, { type: string; default?: unknown; enum?: unknown[] }> };
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

	it('matches the contextValue strings the tree view actually produces', () => {
		const treeSource = sourceOf('src/vscode/treeView.ts');
		const produced = [...new Set([...treeSource.matchAll(/contextValue: '(geco\.[a-z]+)'/g)].map((m) => m[1]!))];
		assert.deepEqual(produced.sort(), ['geco.backup', 'geco.branch', 'geco.commit', 'geco.empty', 'geco.group']);

		const patterns = (manifest.contributes.menus['view/item/context'] ?? [])
			.map((e) => /viewItem =~ \/(.*)\//.exec(e.when ?? '')?.[1])
			.filter((p): p is string => Boolean(p))
			.map((p) => new RegExp(p));
		const matched = produced.filter((value) => patterns.some((pattern) => pattern.test(value)));
		assert.deepEqual(matched.sort(), ['geco.backup', 'geco.branch', 'geco.commit'], 'every actionable node has a menu');
	});

	it('scopes title menus to our own view', () => {
		for (const entry of manifest.contributes.menus['view/title'] ?? []) {
			assert.equal(entry.when, 'view == geco.history');
		}
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
			assert.equal(entry.when, 'scmProvider == git');
		}
	});

	it('hooks into the Timeline per-commit menu with the git provider context value', () => {
		const timeline = manifest.contributes.menus['timeline/item/context'] ?? [];
		assert.equal(timeline.length, 1);
		assert.equal(timeline[0]!.submenu, 'geco.commitSubmenu');
		// The built-in git timeline tags commit rows 'git:file:commit' (and staged /
		// working-tree rows with other values, where our commands make no sense).
		assert.equal(timeline[0]!.when, 'timelineItem == git:file:commit');
	});

	it('also offers the submenu on the repository row of the Source Control view', () => {
		const entries = manifest.contributes.menus['scm/repository'] ?? [];
		assert.equal(entries.length, 1);
		assert.equal(entries[0]!.submenu, 'geco.commitSubmenu');
		assert.equal(entries[0]!.when, 'scmProvider == git');
	});
});

describe('manifest - views and configuration', () => {
	it('contributes the history view in the Source Control container with a welcome message', () => {
		const views = manifest.contributes.views.scm ?? [];
		assert.equal(views.length, 1);
		assert.equal(views[0]!.id, 'geco.history');
		assert.equal(views[0]!.name, 'Git Easy Ops');
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
			assert.equal(property.type, type === 'number' ? 'number' : type, `${configKey} type`);
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
