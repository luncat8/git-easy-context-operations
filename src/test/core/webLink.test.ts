import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { remoteToWebUrl } from '../../core/webLink';
import { Controller } from '../../core/controller';
import { DEFAULT_SETTINGS } from '../../core/config';
import { createLinearRepo } from '../helpers/tempRepo';
import { FakeUI } from '../helpers/fakeUi';

describe('remoteToWebUrl', () => {
	it('turns the usual remote spellings into the browsable address', () => {
		const cases: [string, string | undefined][] = [
			['https://github.com/acme/app.git', 'https://github.com/acme/app'],
			['https://github.com/acme/app', 'https://github.com/acme/app'],
			['https://github.com/acme/app/', 'https://github.com/acme/app'],
			['git@github.com:acme/app.git', 'https://github.com/acme/app'],
			['github.com:acme/app.git', 'https://github.com/acme/app'],
			['ssh://git@gitlab.example.com:2222/grp/sub/app.git', 'https://gitlab.example.com/grp/sub/app'],
			['git://example.org/acme/app.git', 'https://example.org/acme/app'],
			['https://gitlab.example.com:8443/acme/app.git', 'https://gitlab.example.com:8443/acme/app'],
			['  https://github.com/acme/app.git\n', 'https://github.com/acme/app'],
		];
		for (const [input, expected] of cases) {
			assert.equal(remoteToWebUrl(input), expected, input);
		}
	});

	it('never copies credentials', () => {
		assert.equal(remoteToWebUrl('https://user:ghp_secret@github.com/acme/app.git'), 'https://github.com/acme/app');
		assert.equal(remoteToWebUrl('ssh://deploy@git.example.com/acme/app.git'), 'https://git.example.com/acme/app');
	});

	it('refuses local paths and unknown schemes', () => {
		for (const input of ['', '/srv/git/app.git', '../app.git', 'C:\\repos\\app', 'file:///srv/git/app.git', 'ftp://example.org/app.git', 'https://github.com']) {
			assert.equal(remoteToWebUrl(input), undefined, input);
		}
	});
});

describe('controller - copy repository web link', () => {
	it('copies the origin web address (credentials removed)', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['remote', 'add', 'origin', 'https://user:token@github.com/acme/app.git']);
			const ui = new FakeUI();
			await new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec }).copyRepositoryWebLink(repo.dir);
			assert.deepEqual(ui.copied, ['https://github.com/acme/app']);
			assert.match(ui.allMessages(), /Copied the web link of origin: https:\/\/github\.com\/acme\/app/);
		} finally {
			repo.cleanup();
		}
	});

	it('falls back to another remote when origin has no web address', async () => {
		const { repo } = await createLinearRepo();
		try {
			await repo.gitOk(['remote', 'add', 'upstream', 'git@github.com:acme/upstream.git']);
			const ui = new FakeUI();
			await new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec }).copyRepositoryWebLink(repo.dir);
			assert.deepEqual(ui.copied, ['https://github.com/acme/upstream']);
		} finally {
			repo.cleanup();
		}
	});

	it('explains itself when there is no remote', async () => {
		const { repo } = await createLinearRepo();
		try {
			const ui = new FakeUI();
			await new Controller({ ui, settings: DEFAULT_SETTINGS, exec: repo.exec }).copyRepositoryWebLink(repo.dir);
			assert.deepEqual(ui.copied, []);
			assert.match(ui.allMessages(), /no remote/);
		} finally {
			repo.cleanup();
		}
	});
});
