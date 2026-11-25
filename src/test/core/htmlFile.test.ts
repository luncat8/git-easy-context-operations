/**
 * HTML detection for "Open Current Version with Live Server". Headless: the
 * helper imports nothing from `vscode`, so it runs under `node --test`.
 */
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { HTML_ENTRY_NAMES, HTML_EXTENSIONS, isHtmlFile, stripRevisionSuffix } from '../../core/htmlFile';

describe('isHtmlFile', () => {
	it('accepts .html and .htm, case-insensitively', () => {
		for (const base of ['index', 'app', 'page', 'main']) {
			assert.equal(isHtmlFile({ fsPath: `/repo/${base}.html` }), true, `${base}.html`);
			assert.equal(isHtmlFile({ fsPath: `/repo/${base}.HTML` }), true, `${base}.HTML`);
			assert.equal(isHtmlFile({ fsPath: `/repo/${base}.htm` }), true, `${base}.htm`);
			assert.equal(isHtmlFile({ fsPath: `C:\\repo\\${base}.Htm` }), true, `windows ${base}.Htm`);
		}
	});

	it('accepts the extension-less index entry name', () => {
		assert.equal(isHtmlFile({ fsPath: '/repo/index' }), true);
		assert.equal(isHtmlFile({ fsPath: 'C:\\repo\\index' }), true);
	});

	it('falls back to the uri path when fsPath is absent', () => {
		assert.equal(isHtmlFile({ path: '/repo/app.html' }), true);
		assert.equal(isHtmlFile({ path: '/repo/app.ts' }), false);
	});

	it('rejects non-HTML files', () => {
		for (const name of ['app.ts', 'app.tsx', 'style.css', 'script.js', 'readme.md', 'data.json', 'index.php', 'Makefile']) {
			assert.equal(isHtmlFile({ fsPath: `/repo/${name}` }), false, name);
		}
	});

	it('strips a surviving .git / .diff revision suffix before matching', () => {
		// A `git:` revision URI may resolve (or nearly resolve) to a path that
		// still carries the `.git` marker; it must still be recognised as HTML.
		assert.equal(isHtmlFile({ fsPath: '/repo/index.html.git' }), true, 'index.html.git');
		assert.equal(isHtmlFile({ fsPath: '/repo/page.htm.diff' }), true, 'page.htm.diff');
		assert.equal(isHtmlFile({ fsPath: '/repo/main.ts.git' }), false, 'main.ts.git is not html');
	});

	it('is not fooled by extra suffixes or extension-less names', () => {
		assert.equal(isHtmlFile({ fsPath: '/repo/html' }), false, 'a directory literally named "html"');
		assert.equal(isHtmlFile({ fsPath: '/repo/page.html.bak' }), false, 'an extra suffix defeats the match');
		assert.equal(isHtmlFile({ fsPath: '/repo/Index.html~' }), false, 'a trailing tilde defeats the match');
	});

	it('treats an unknown scheme path by its extension only', () => {
		assert.equal(isHtmlFile({ fsPath: '/repo/serve.html' }), true);
	});

	it('exports the same extension and entry-name sets used by the handler', () => {
		assert.deepEqual([...HTML_EXTENSIONS], ['.html', '.htm']);
		assert.ok(HTML_ENTRY_NAMES.has('index'));
	});
});

describe('stripRevisionSuffix', () => {
	it('removes trailing .git and .diff markers', () => {
		assert.equal(stripRevisionSuffix('/repo/app.html.git'), '/repo/app.html');
		assert.equal(stripRevisionSuffix('/repo/app.htm.diff'), '/repo/app.htm');
		assert.equal(stripRevisionSuffix('/repo/app.html'), '/repo/app.html');
		assert.equal(stripRevisionSuffix('/repo/.git'), '/repo/');
	});
});
