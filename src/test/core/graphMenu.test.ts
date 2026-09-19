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
import { assessGraphMenu, GRAPH_MENU_KEYS, type ArgvStore, type GraphMenuBuild } from '../../core/graphMenu';
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
		cliCommand: 'code',
		graphVsixName: 'git-easy-context-operations-0.1.0+graph.vsix',
		...overrides,
	});

	it('reports ready when the build and argv.json agree', () => {
		const status = assessGraphMenu(build(), `{\n\t"enable-proposed-api": ["${ID}"]\n}`);
		assert.equal(status.ready, true);
		assert.equal(status.allowedInArgv, true);
		assert.equal(status.argvExists, true);
		assert.deepEqual(status.steps, []);
		assert.match(status.report, /status:\s+READY/);
	});

	it('says argv.json is the missing half, with copy-pasteable steps', () => {
		const status = assessGraphMenu(build(), '{\n\t"log-level": "info"\n}');
		assert.equal(status.ready, false);
		assert.equal(status.argvExists, true);
		assert.equal(status.allowedInArgv, false);
		assert.ok(status.steps.some((s) => s.includes('"enable-proposed-api"')), status.steps.join('\n'));
		assert.ok(status.steps.some((s) => s.includes(`/home/user/.vscode/argv.json`)));
		assert.ok(status.steps.some((s) => s.includes('Configure Runtime Arguments')));
		assert.ok(status.steps.some((s) => s.includes(`code --enable-proposed-api ${ID}`)));
		assert.equal(status.steps[status.steps.length - 1], 'Then restart VS Code.');
		assert.doesNotMatch(status.report, /package:graph/, 'the build is fine, so do not tell them to rebuild');
	});

	it('says the installed build is the wrong one when it lacks the proposal', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), `{\n\t"enable-proposed-api": ["${ID}"]\n}`);
		assert.equal(status.ready, false);
		assert.equal(status.allowedInArgv, true);
		assert.match(status.steps.join('\n'), /npm run package:graph/);
		assert.match(status.steps.join('\n'), /code --install-extension git-easy-context-operations-0\.1\.0\+graph\.vsix/);
		assert.doesNotMatch(status.steps.join('\n'), /enable-proposed-api"\]: /, 'argv.json is already fine');
	});

	it('lists both halves, build first, when nothing is in place', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), undefined);
		assert.equal(status.argvExists, false);
		assert.equal(status.ready, false);
		const joined = status.steps.join('\n');
		assert.ok(joined.indexOf('package:graph') < joined.indexOf('enable-proposed-api'), joined);
		assert.match(status.report, /\(does not exist yet\)/);
	});

	it('explains that the sidebar view, Timeline and palette always work', () => {
		const status = assessGraphMenu(build({ hasProposals: false, menuKeys: [] }), undefined);
		assert.match(status.report, /Git Easy Ops" view/);
		assert.match(status.report, /Timeline/);
		assert.match(status.report, /Command Palette/);
		assert.match(status.report, /contribSourceControlHistoryItemMenu/);
	});
});

describe('controller - enableGraphMenu', () => {
	const build: GraphMenuBuild = {
		extensionId: ID,
		hasProposals: true,
		menuKeys: [...GRAPH_MENU_KEYS],
		argvPath: '/home/user/.vscode/argv.json',
		cliCommand: 'code',
		graphVsixName: 'git-easy-context-operations-0.1.0+graph.vsix',
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
			await controller.enableGraphMenu(build, store);

			assert.deepEqual(store.writes, []);
			assert.equal(store.backups, 0);
			assert.equal(ui.confirmCalls.length, 0);
			assert.match(ui.allMessages(), /already enabled|is enabled for Git Easy Ops/);
		} finally {
			repo.cleanup();
		}
	});

	it('writes the line (with a backup) after the user agrees, and keeps their comments', async () => {
		const ui = new FakeUI({ confirms: [true], asks: [ACTIONS.openLog] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const original = '// my notes\n{\n\t"disable-hardware-acceleration": true\n}\n';
			const store = new MemoryArgvStore(original);
			await controller.enableGraphMenu(build, store);

			assert.equal(store.backups, 1);
			assert.equal(store.writes.length, 1);
			assert.match(store.writes[0]!, /my notes/, 'comments survive');
			assert.match(store.writes[0]!, /"disable-hardware-acceleration": true/);
			assert.deepEqual(readsProposedApi(store.writes[0]!), [ID]);
			assert.match(ui.confirmCalls[0]!.message, new RegExp(`Allow proposed APIs for ${ID.replace(/\./g, '\\.')}\\?`));
			assert.match(ui.confirmCalls[0]!.options!.detail!, /"enable-proposed-api"/);
			assert.match(ui.confirmCalls[0]!.options!.detail!, /backup is written/);
			assert.match(ui.allLogs(), /Updated \/home\/user\/\.vscode\/argv\.json \(backup: /);
			assert.match(ui.askCalls[0]!.message, /Restart VS Code/);
			assert.equal(ui.outputReveals.length, 1);
		} finally {
			repo.cleanup();
		}
	});

	it('creates the file when the user has none', async () => {
		const ui = new FakeUI({ confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore(undefined);
			await controller.enableGraphMenu(build, store);

			assert.equal(store.backups, 1, 'asked for a backup even though there was nothing to back up');
			assert.deepEqual(readsProposedApi(store.writes[0]!), [ID]);
			assert.doesNotMatch(store.writes[0]!, /,\s*\n\s*}/);
		} finally {
			repo.cleanup();
		}
	});

	it('leaves the file alone when the user declines', async () => {
		const ui = new FakeUI({ confirms: [false] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}');
			await controller.enableGraphMenu(build, store);

			assert.deepEqual(store.writes, []);
			assert.match(ui.allLogs(), /argv\.json was not modified/);
			assert.match(ui.allMessages(), /still not available/);
		} finally {
			repo.cleanup();
		}
	});

	it('still says the graph build is needed when the installed build cannot show the menu', async () => {
		const ui = new FakeUI({ confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}');
			await controller.enableGraphMenu({ ...build, hasProposals: false, menuKeys: [] }, store);

			assert.deepEqual(readsProposedApi(store.writes[0]!), [ID], 'the half we can fix is fixed');
			assert.match(ui.askCalls[0]!.message, /Install the graph build with "npm run package:graph"/);
			assert.match(ui.askCalls[0]!.options.detail!, /code --install-extension/);
		} finally {
			repo.cleanup();
		}
	});

	it('reports an unwritable argv.json as an error instead of throwing', async () => {
		const ui = new FakeUI({ confirms: [true] });
		const { repo, controller } = await controllerWith(ui);
		try {
			const store = new MemoryArgvStore('{}', true);
			await controller.enableGraphMenu(build, store);

			assert.equal(ui.messages[0]!.kind, 'error');
			assert.match(ui.messages[0]!.message, /^Graph menu: /);
			assert.match(ui.allLogs(), /EACCES/);
		} finally {
			repo.cleanup();
		}
	});

	it('explains the two builds and every entry point', async () => {
		const ui = new FakeUI();
		const { repo, controller } = await controllerWith(ui);
		try {
			await controller.explainMenus();

			const logs = ui.allLogs();
			assert.match(logs, /npm run package:graph/);
			assert.match(logs, /Preferences: Configure Runtime Arguments/);
			assert.match(logs, /code --enable-proposed-api luncat8\.git-easy-context-operations/);
			assert.match(logs, /Enable Source Control Graph Menu/);
			assert.match(logs, /Timeline view: right-click a commit/);
			assert.equal(ui.messages[0]!.kind, 'info');
		} finally {
			repo.cleanup();
		}
	});
});
