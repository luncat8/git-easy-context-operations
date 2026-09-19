/**
 * The Source Control Graph commit menu is a proposed contribution point, so the
 * extension has to (a) tell the user exactly which half is missing and (b) be
 * able to write the `argv.json` line for them without eating their comments.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
	addProposedApi,
	allowsProposedApi,
	ARGV_JSON_HEADER,
	argvJsonDirFor,
	PROPOSED_API_KEY,
	readsProposedApi,
	removeProposedApi,
} from '../../core/argvJson';
import {
	assessGraphMenu,
	GRAPH_MENU_KEYS,
	GRAPH_MENU_PROPOSALS,
	graphMenuFixOptions,
	type ArgvStore,
	type GraphMenuBuild,
} from '../../core/graphMenu';
import { addProductProposals, readProductProposals } from '../../core/productJson';
import { Controller } from '../../core/controller';
import { ACTIONS } from '../../core/ui';
import { DEFAULT_SETTINGS } from '../../core/config';
import { createLinearRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

const ID = 'luncat8.git-easy-context-operations';

/** Strip comments and trailing commas so `JSON.parse` can validate the result. */
function parseJsonc(text: string): unknown {
	const withoutComments = text
		.split('\n')
		.map((line) => line.replace(/^\s*\/\/.*$/, '').replace(/(\s)\/\/[^"]*$/, '$1'))
		.join('\n');
	return JSON.parse(withoutComments.replace(/,(\s*[}\]])/g, '$1'));
}

class MemoryArgvStore implements ArgvStore {
	reads = 0;
	writes: string[] = [];
	backups = 0;

	constructor(public text: string | undefined, private readonly failOnWrite = false) {}

	async read(): Promise<string | undefined> {
		this.reads++;
		return this.text;
	}

	async write(text: string): Promise<void> {
		if (this.failOnWrite) {
			throw new Error('EACCES: permission denied');
		}
		this.writes.push(text);
		this.text = text;
	}

	async backup(): Promise<string | undefined> {
		this.backups++;
		return this.text === undefined ? undefined : '/home/user/.vscode/argv.json.geco-backup';
	}
}

describe('argvJson - adding the proposal', () => {
	it('keeps comments, other settings and formatting', () => {
		const original = [
			'// This configuration file allows you to pass permanent command line arguments to VS Code.',
			'{',
			'\t// I turn off GPU acceleration on this machine.',
			'\t"disable-hardware-acceleration": true,',
			'',
			'\t"log-level": "debug"',
			'}',
			'',
		].join('\n');

		const updated = addProposedApi(original, ID);

		assert.notEqual(updated, original);
		assert.match(updated, /"enable-proposed-api": \["luncat8\.git-easy-context-operations"\]/);
		assert.match(updated, /I turn off GPU acceleration/, 'the user comment survives');
		assert.match(updated, /"disable-hardware-acceleration": true/);
		assert.match(updated, /"log-level": "debug"/);
		assert.deepEqual(parseJsonc(updated) as Record<string, unknown>, {
			'disable-hardware-acceleration': true,
			'log-level': 'debug',
			[PROPOSED_API_KEY]: [ID],
		});
	});

	it('appends to an existing list instead of replacing it', () => {
		const original = `{\n\t"enable-proposed-api": ["vscode.git", "other.extension"]\n}\n`;
		const updated = addProposedApi(original, ID);

		assert.deepEqual(readsProposedApi(updated), ['vscode.git', 'other.extension', ID]);
		assert.deepEqual(parseJsonc(updated) as Record<string, unknown>, { [PROPOSED_API_KEY]: ['vscode.git', 'other.extension', ID] });
	});

	it('fills an empty list, tolerating whitespace and trailing commas', () => {
		assert.deepEqual(readsProposedApi(addProposedApi('{\n\t"enable-proposed-api": []\n}', ID)), [ID]);
		assert.deepEqual(readsProposedApi(addProposedApi('{\n\t"enable-proposed-api": [ ],\n}', ID)), [ID]);
		assert.deepEqual(readsProposedApi(addProposedApi('{\n\t"enable-proposed-api": [\n\t\t"a.b",\n\t]\n}', ID)), ['a.b', ID]);
	});

	it('is idempotent', () => {
		const once = addProposedApi('{}', ID);
		assert.equal(addProposedApi(once, ID), once);
		assert.deepEqual(readsProposedApi(once), [ID]);
	});

	it('creates a usable file when there is none', () => {
		for (const empty of ['', '   ', '\n\n']) {
			const created = addProposedApi(empty, ID);
			assert.match(created, /^\/\/ This configuration file/);
			assert.ok(created.includes(ARGV_JSON_HEADER.split('\n')[0]!));
			assert.deepEqual(parseJsonc(created) as Record<string, unknown>, { [PROPOSED_API_KEY]: [ID] });
		}
	});

	it('does not leave a trailing comma in an otherwise empty object', () => {
		const updated = addProposedApi('{\n\t// nothing here yet\n}\n', ID);
		assert.deepEqual(parseJsonc(updated) as Record<string, unknown>, { [PROPOSED_API_KEY]: [ID] });
		assert.doesNotMatch(updated, /,\s*\n\s*}/);
	});

	it('ignores the key when it only appears inside a comment', () => {
		const original = '{\n\t// "enable-proposed-api": ["commented.out"]\n\t"log-level": "info"\n}\n';
		const updated = addProposedApi(original, ID);

		assert.equal(allowsProposedApi(original, ID), false);
		assert.equal(allowsProposedApi(original, 'commented.out'), false, 'a commented-out entry does not count');
		assert.deepEqual(readsProposedApi(updated), [ID]);
		assert.deepEqual(parseJsonc(updated) as Record<string, unknown>, { [PROPOSED_API_KEY]: [ID], 'log-level': 'info' });
	});

	it('is not confused by the key name inside a string value', () => {
		const original = '{\n\t"note": "do not enable-proposed-api here"\n}\n';
		const updated = addProposedApi(original, ID);
		assert.deepEqual(readsProposedApi(updated), [ID]);
		assert.match(updated, /"note": "do not enable-proposed-api here"/);
	});

	it('removes the entry again', () => {
		const withTwo = addProposedApi(addProposedApi('{}', 'other.extension'), ID);
		assert.deepEqual(readsProposedApi(withTwo), ['other.extension', ID]);

		const removed = removeProposedApi(withTwo, ID);
		assert.deepEqual(readsProposedApi(removed), ['other.extension']);
		assert.equal(removeProposedApi(removed, ID), removed, 'removing twice changes nothing');
		assert.deepEqual(parseJsonc(removed) as Record<string, unknown>, { [PROPOSED_API_KEY]: ['other.extension'] });
	});

	it('rejects a blank extension id', () => {
		assert.throws(() => addProposedApi('{}', '  '), /extension id is required/);
	});

	it('maps every VS Code flavour to its own runtime arguments directory', () => {
		assert.equal(argvJsonDirFor('Visual Studio Code'), '.vscode');
		assert.equal(argvJsonDirFor('Visual Studio Code - Insiders'), '.vscode-insiders');
		assert.equal(argvJsonDirFor('Visual Studio Code - Exploration'), '.vscode-exploration');
		assert.equal(argvJsonDirFor('VSCodium'), '.vscode-oss');
		assert.equal(argvJsonDirFor('Code - OSS'), '.vscode-oss');
		assert.equal(argvJsonDirFor('Cursor'), '.cursor');
		assert.equal(argvJsonDirFor('Something New'), '.vscode', 'unknown flavours fall back to the stable path');
	});
});

describe('graph menu - diagnosis', () => {
	const build = (overrides: Partial<GraphMenuBuild> = {}): GraphMenuBuild => ({
		extensionId: ID,
		hasProposals: true,
		menuKeys: [...GRAPH_MENU_KEYS],
		argvPath: '/home/user/.vscode/argv.json',
		productPath: '/opt/vscode/resources/app/product.json',
		cliCommand: 'code',
		graphVsixName: 'git-easy-context-operations-0.2.0+graph.vsix',
		...overrides,
	});

	it('reports ready when the build and argv.json agree', () => {
		const status = assessGraphMenu(build(), `{\n\t"enable-proposed-api": ["${ID}"]\n}`);
		assert.equal(status.ready, true);
		assert.equal(status.allowedInArgv, true);
		assert.equal(status.allowedInProduct, false);
		assert.equal(status.argvExists, true);
		assert.deepEqual(status.steps, []);
		assert.match(status.report, /status:\s+READY/);
	});

	it('accepts the product.json route - the one without a command line', () => {
		const product = JSON.stringify({ nameShort: 'Code', [ 'extensionEnabledApiProposals' ]: { [ID]: [...GRAPH_MENU_PROPOSALS] } }, null, '\t');
		const status = assessGraphMenu(build(), '{\n\t"log-level": "info"\n}', product);
		assert.equal(status.allowedInArgv, false, 'argv.json still has nothing');
		assert.equal(status.allowedInProduct, true);
		assert.equal(status.productExists, true);
		assert.equal(status.ready, true);
		assert.deepEqual(status.steps, []);
		assert.match(status.report, /proposal allowed there: YES/);
	});

	it('needs *all* the proposals the graph build declares', () => {
		const product = JSON.stringify({ extensionEnabledApiProposals: { [ID]: ['contribSourceControlHistoryItemMenu'] } });
		const status = assessGraphMenu(build(), undefined, product);
		assert.equal(status.allowedInProduct, false, 'the title menu proposal is missing');
		assert.equal(status.ready, false);
	});

	it('says what is missing, with copy-pasteable steps for both files', () => {
		const status = assessGraphMenu(build(), '{\n\t"log-level": "info"\n}');
		assert.equal(status.ready, false);
		assert.equal(status.argvExists, true);
		assert.equal(status.productExists, false);
		const steps = status.steps.join('\n');
		assert.ok(status.steps.some((s) => s.includes('"enable-proposed-api"')), steps);
		assert.ok(status.steps.some((s) => s.includes('/home/user/.vscode/argv.json')));
		assert.ok(status.steps.some((s) => s.includes('Command Palette: "Preferences: Configure Runtime Arguments"')), steps);
		assert.ok(status.steps.some((s) => s.includes('/opt/vscode/resources/app/product.json')), steps);
		assert.ok(status.steps.some((s) => s.includes('"extensionEnabledApiProposals"')), steps);
		assert.ok(status.steps.some((s) => s.includes(`code --enable-proposed-api ${ID}`)));
		assert.equal(status.steps[status.steps.length - 1], 'Then restart VS Code.');
		assert.doesNotMatch(status.report, /package:graph/, 'the build is fine, so do not tell them to rebuild');
		assert.match(status.report, /\(does not exist yet\)/);
	});

	it('says the installed build is the wrong one when it lacks the proposal', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), `{\n\t"enable-proposed-api": ["${ID}"]\n}`);
		assert.equal(status.ready, false);
		assert.equal(status.allowedInArgv, true);
		assert.match(status.steps.join('\n'), /npm run package:graph/);
		assert.match(status.steps.join('\n'), /code --install-extension git-easy-context-operations-0\.2\.0\+graph\.vsix/);
		assert.doesNotMatch(status.steps.join('\n'), /enable-proposed-api"\]: /, 'argv.json is already fine');
	});

	it('lists both halves, build first, when nothing is in place', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), undefined);
		assert.equal(status.argvExists, false);
		assert.equal(status.ready, false);
		const joined = status.steps.join('\n');
		assert.ok(joined.indexOf('package:graph') < joined.indexOf('enable-proposed-api'), joined);
	});

	it('explains the sidebar graph, the Timeline and the palette', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), undefined);
		assert.match(status.report, /Git Easy Ops" view/);
		assert.match(status.report, /Timeline/);
		assert.match(status.report, /Command Palette/);
		assert.match(status.report, /contribSourceControlHistoryItemMenu/);
		assert.match(status.report, /"Rename Branch\.\.\. > main"/, 'explains how ref menus show up in the graph');
		assert.match(status.report, /not nested under an extension name/, 'says the items are flat, not in a submenu');
		assert.match(status.report, /next to Cherry Pick/, 'says which built-in group they land in');
	});
});

describe('graph menu - the fixes offered', () => {
	const build: GraphMenuBuild = {
		extensionId: ID,
		hasProposals: true,
		menuKeys: [...GRAPH_MENU_KEYS],
		argvPath: '/home/user/.vscode/argv.json',
		productPath: '/opt/vscode/resources/app/product.json',
		cliCommand: 'code',
	};

	it('offers product.json first, then argv.json, then "just explain"', () => {
		const options = graphMenuFixOptions(build);
		assert.deepEqual(options.map((option) => option.value), ['product', 'argv', 'none']);
		assert.match(options[0]!.detail, /extensionEnabledApiProposals/);
		assert.match(options[0]!.detail, new RegExp(ID.replace(/\./g, '\\.')));
		assert.match(options[1]!.detail, /"enable-proposed-api"/);
		assert.match(options[2]!.detail, /copy-pasteable/i);
	});
});

describe('product.json - allowing the proposal', () => {
	it('adds the entry, keeps the other keys and the indentation', () => {
		const original = JSON.stringify({ nameShort: 'Code', darwinBundleIdentifier: 'com.microsoft.VSCode' }, null, '\t') + '\n';
		const updated = addProductProposals(original, ID, GRAPH_MENU_PROPOSALS);

		assert.equal(updated.endsWith('\n'), true);
		assert.match(updated, /\n\t"/, 'the tab indentation survives');
		const parsed = JSON.parse(updated) as Record<string, unknown>;
		assert.equal(parsed['nameShort'], 'Code');
		assert.equal(parsed['darwinBundleIdentifier'], 'com.microsoft.VSCode');
		assert.deepEqual(readProductProposals(updated)[ID], [...GRAPH_MENU_PROPOSALS]);
	});

	it('merges with an existing entry instead of dropping proposals', () => {
		const original = JSON.stringify({ extensionEnabledApiProposals: { 'github.copilot': ['chatParticipant'], [ID]: ['contribSourceControlHistoryItemMenu'] } }, null, 2);
		const updated = addProductProposals(original, ID, GRAPH_MENU_PROPOSALS);
		const proposals = readProductProposals(updated);

		assert.deepEqual(proposals['github.copilot'], ['chatParticipant']);
		assert.deepEqual(proposals[ID], [...GRAPH_MENU_PROPOSALS], 'the existing entry is completed, not replaced');
	});

	it('is idempotent', () => {
		const once = addProductProposals('{\n  "nameShort": "Code"\n}\n', ID, GRAPH_MENU_PROPOSALS);
		assert.equal(addProductProposals(once, ID, GRAPH_MENU_PROPOSALS), once);
	});

	it('refuses to touch something that is not a product.json', () => {
		assert.throws(() => addProductProposals('not json', ID, GRAPH_MENU_PROPOSALS), /not valid JSON/);
		assert.throws(() => addProductProposals('[1, 2]', ID, GRAPH_MENU_PROPOSALS), /does not contain a JSON object/);
		assert.throws(() => addProductProposals('{"extensionEnabledApiProposals": []}', ID, GRAPH_MENU_PROPOSALS), /is not an object/);
		assert.throws(() => addProductProposals('{}', '  ', GRAPH_MENU_PROPOSALS), /extension id is required/);
	});
});

describe('controller - enableGraphMenu', () => {
	const build: GraphMenuBuild = {
		extensionId: ID,
		hasProposals: true,
		menuKeys: [...GRAPH_MENU_KEYS],
		argvPath: '/home/user/.vscode/argv.json',
		productPath: '/opt/vscode/resources/app/product.json',
		cliCommand: 'code',
		graphVsixName: 'git-easy-context-operations-0.2.0+graph.vsix',
	};

	async function controllerWith(ui: FakeUI) {
		const { repo } = await createLinearRepo();
		return { repo, controller: new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec }) };
	}

	it('says everything is already fine and touches nothing', async () => {
		const ui = new FakeUI();
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore(`{\n\t"enable-proposed-api": ["${ID}"]\n}`);
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{}'));

			assert.deepEqual(store.writes, []);
			assert.equal(store.backups, 0);
			assert.equal(ui.pickCalls.length, 0, 'nothing to choose');
			assert.equal(ui.confirmCalls.length, 0);
			assert.match(ui.allMessages(), /already enabled|is enabled for Git Easy Ops/);
		} finally {
			repo.cleanup();
		}
	});

	it('writes the argv.json line (with a backup) after the user agrees, and keeps their comments', async () => {
		const ui = new FakeUI({ picks: ['argv.json'], confirms: [true], asks: [ACTIONS.openLog] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const original = '// my notes\n{\n\t"disable-hardware-acceleration": true\n}\n';
			const store = new MemoryArgvStore(original);
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{"nameShort":"Code"}'));

			assert.equal(store.backups, 1);
			assert.equal(store.writes.length, 1);
			assert.match(store.writes[0]!, /my notes/, 'comments survive');
			assert.match(store.writes[0]!, /"disable-hardware-acceleration": true/);
			assert.deepEqual(readsProposedApi(store.writes[0]!), [ID]);
			assert.match(ui.pickCalls[0]!.options!.title!, new RegExp(`Allow proposed APIs for ${ID.replace(/\./g, '\\.')}\\?`));
			assert.match(ui.confirmCalls[0]!.message, /in argv\.json\?/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /"enable-proposed-api"/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /backup is written/);
			assert.match(ui.allLogs(), /Updated \/home\/user\/\.vscode\/argv\.json \(backup: /);
			assert.match(ui.askCalls[0]!.message, /Restart VS Code/);
			assert.equal(ui.outputReveals.length, 1);
		} finally {
			repo.cleanup();
		}
	});

	it('writes product.json when that is the chosen route - no command line involved', async () => {
		const ui = new FakeUI({ picks: ['product.json'], confirms: [true], asks: [ACTIONS.openLog] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const argv = new MemoryArgvStore('{}');
			const product = new MemoryArgvStore(JSON.stringify({ nameShort: 'Code' }, null, '\t') + '\n');
			await controller.enableGraphMenu(build, argv, product);

			assert.deepEqual(argv.writes, [], 'argv.json stays untouched');
			assert.equal(product.backups, 1);
			assert.equal(product.writes.length, 1);
			assert.deepEqual(readProductProposals(product.writes[0]!)[ID], [...GRAPH_MENU_PROPOSALS]);
			assert.match(ui.confirmCalls[0]!.message, /in the editor's product\.json\?/);
			assert.match(ui.allLogs(), /Updated \/opt\/vscode\/resources\/app\/product\.json \(backup: /);
		} finally {
			repo.cleanup();
		}
	});

	it('does not offer product.json when the extension cannot find the file', async () => {
		const ui = new FakeUI({ picks: ['argv.json'], confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			await controller.enableGraphMenu(build, new MemoryArgvStore('{}'));

			const offered = ui.pickCalls[0]!.items.map((item) => item.label);
			assert.equal(offered.some((label) => label.includes('product.json')), false, `only argv.json is offered: ${offered.join(' | ')}`);
			assert.equal(ui.pickCalls[0]!.items[0]!.label.includes('argv.json'), true);
		} finally {
			repo.cleanup();
		}
	});

	it('creates argv.json when the user has none', async () => {
		const ui = new FakeUI({ picks: ['argv.json'], confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore(undefined);
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{}'));

			assert.equal(store.backups, 1, 'asked for a backup even though there was nothing to back up');
			assert.deepEqual(readsProposedApi(store.writes[0]!), [ID]);
			assert.doesNotMatch(store.writes[0]!, /,\s*\n\s*}/);
		} finally {
			repo.cleanup();
		}
	});

	it('leaves the file alone when the user declines the write', async () => {
		const ui = new FakeUI({ picks: ['argv.json'], confirms: [false] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}');
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{}'));

			assert.deepEqual(store.writes, []);
			assert.match(ui.allLogs(), /argv\.json was not modified/);
			assert.match(ui.allMessages(), /still not available/);
		} finally {
			repo.cleanup();
		}
	});

	it('changes nothing when the picker is dismissed', async () => {
		const ui = new FakeUI({ picks: ['nope'], confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}');
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{}'));

			assert.deepEqual(store.writes, []);
			assert.equal(ui.confirmCalls.length, 0, 'nothing to confirm');
			assert.match(ui.allLogs(), /Nothing was changed/);
		} finally {
			repo.cleanup();
		}
	});

	it('still says the graph build is needed when the installed build cannot show the menu', async () => {
		const ui = new FakeUI({ confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}');
			await controller.enableGraphMenu({ ...build, hasProposals: false, menuKeys: [] }, store, new MemoryArgvStore('{}'));

			assert.deepEqual(store.writes, [], 'no point allowing the proposal for a build without the menus');
			assert.equal(ui.pickCalls.length, 0);
			assert.match(ui.askCalls[0]!.message, /Install the graph build with "npm run package:graph"/);
			assert.match(ui.askCalls[0]!.options.detail!, /code --install-extension/);
		} finally {
			repo.cleanup();
		}
	});

	it('reports an unwritable argv.json as an error instead of throwing', async () => {
		const ui = new FakeUI({ picks: ['argv.json'], confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}', true);
			await controller.enableGraphMenu(build, store, new MemoryArgvStore('{}'));

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /^Graph menu: /);
			assert.match(ui.allLogs(), /EACCES/);
		} finally {
			repo.cleanup();
		}
	});

	it('explains the two builds, both routes and every entry point', async () => {
		const ui = new FakeUI();
		const { repo, controller } = await controllerWith(ui);
		try {
			await controller.explainMenus();

			const logs = ui.allLogs();
			assert.match(logs, /npm run package:graph/);
			assert.match(logs, /Preferences: Configure Runtime Arguments/);
			assert.match(logs, /extensionEnabledApiProposals/);
			assert.match(logs, /code --enable-proposed-api luncat8\.git-easy-context-operations/);
			assert.match(logs, /Enable Source Control Graph Menu/);
			assert.match(logs, /Timeline view: right-click a commit/);
			assert.match(logs, /scm\/historyItemRef\/context/, 'the branch rows of the graph are explained too');
			assert.match(logs, /Rename Branch\.\.\. > main/);
			assert.match(logs, /"Graph" group/, 'the always-available graph panel is pointed out');
			assert.equal(ui.messages[0]!.kind, 'info');
		} finally {
			repo.cleanup();
		}
	});
});
