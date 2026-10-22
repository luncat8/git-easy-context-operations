#!/usr/bin/env node
/**
 * Pins the graph build version scheme - run by `npm test` (and therefore by
 * CI), so nobody "simplifies" it back to a suffix that VS Code ignores.
 *
 * The rule it protects: the graph build must install as a *different version
 * string* than the publishable build of the same release. VS Code decides
 * whether an install needs a reload by comparing those strings
 * (`ExtensionsWorkbenchService.getRuntimeState()`:
 * `extension.version !== runningExtension.version`); equal versions mean no
 * reload prompt and the old build keeps running - see
 * `docs/vscode-same-version-vsix.md`.
 */
import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromGraphVersion, isGraphVersion, toGraphVersion } from './graph-version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The mapping.
assert.equal(toGraphVersion('0.4.20'), '0.4.20+graph');
assert.equal(fromGraphVersion('0.4.20+graph'), '0.4.20');
assert.equal(toGraphVersion(toGraphVersion('0.4.20')), '0.4.20+graph', 'toGraphVersion is idempotent');

// A base that already carries build metadata stays reversible.
assert.equal(toGraphVersion('0.4.20+meta'), '0.4.20+meta.graph');
assert.equal(fromGraphVersion('0.4.20+meta.graph'), '0.4.20+meta');

// Publishable versions are left alone.
for (const version of ['0.4.20', '1.0.0', '2.3.4-beta.1']) {
	assert.equal(fromGraphVersion(version), version);
	assert.equal(isGraphVersion(version), false, `${version} must not look like a graph build`);
}

// The whole point: the two builds of one release cannot share a version.
for (const version of ['0.4.20', '1.0.0', '2.3.4-beta.1']) {
	const graph = toGraphVersion(version);
	assert.equal(isGraphVersion(graph), true);
	assert.notEqual(graph, version, `${graph} would install as the publishable version`);
	// Semver build metadata: `semver.eq(graph, version)` holds, so the
	// Extensions view offers no "update"; four segments would be rejected and
	// a prerelease would sort below the publishable build.
	assert.match(graph, /^\d+\.\d+\.\d+(-[^+]*)?\+[^+]+$/, `${graph} must stay valid semver`);
}

// The checked-in manifest must be the publishable one.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
assert.equal(String(manifest.version).includes('+'), false, `package.json carries ${manifest.version} - run: node scripts/apply-graph-menu.mjs off`);
assert.equal(manifest.enabledApiProposals, undefined, 'package.json asks for proposed APIs - run: node scripts/apply-graph-menu.mjs off');

console.log(`graph version check ok (${manifest.version} -> ${toGraphVersion(manifest.version)})`);
