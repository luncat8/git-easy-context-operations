#!/usr/bin/env node
/**
 * Runs the VS Code integration smoke test inside a real editor instance.
 *
 *   npm run test:vscode
 *
 * This downloads VS Code (cached in `.vscode-test`), launches it with this
 * extension in development mode and executes `out/src/test/vscode/index.js`
 * inside the extension host. On Linux a display is required:
 *
 *   xvfb-run -a npm run test:vscode
 *
 * The git engine itself is covered by the headless suite (`npm test`), which
 * runs in milliseconds and needs no editor.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'extension.js');
const TESTS_ENTRY = path.join(ROOT, 'out', 'src', 'test', 'vscode', 'index.js');

for (const required of [DIST, TESTS_ENTRY]) {
	if (!fs.existsSync(required)) {
		console.error(`Missing ${path.relative(ROOT, required)}.`);
		console.error('Run "npm run compile" and "npm run compile-tests" first.');
		process.exit(2);
	}
}

const { runTests } = await import('@vscode/test-electron');

// A throw-away workspace: the smoke test creates its own repositories in tmpdir.
const workspace = path.join(ROOT, '.vscode-test', 'workspace');
fs.mkdirSync(workspace, { recursive: true });

try {
	const failures = await runTests({
		extensionDevelopmentPath: ROOT,
		extensionTestsPath: TESTS_ENTRY,
		launchArgs: [
			workspace,
			// Note: no --disable-extensions - this extension depends on the
			// built-in vscode.git extension for repository detection.
			'--disable-workspace-trust',
			'--skip-release-notes',
			'--skip-welcome',
		],
	});
	if (typeof failures === 'number' && failures > 0) {
		console.error(`${failures} integration test(s) failed.`);
		process.exit(1);
	}
	console.log('VS Code integration smoke test passed.');
} catch (error) {
	console.error('Could not run VS Code:', error instanceof Error ? error.message : error);
	console.error('On Linux try: xvfb-run -a npm run test:vscode');
	process.exit(1);
}
