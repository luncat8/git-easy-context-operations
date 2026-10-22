#!/usr/bin/env node
/**
 * The version a graph build carries: `<version>+graph` (`0.4.20` -> `0.4.20+graph`).
 *
 * Why a *different* version string, when the two builds are the same extension?
 *
 * VS Code decides whether an install needs a window reload by comparing the
 * version **string** of the extension that is installed on disk with the one
 * the extension host is running - `ExtensionsWorkbenchService.getRuntimeState()`
 * in `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts`:
 *
 *     if (!runningExtension.isUnderDevelopment
 *         && (extension.version !== runningExtension.version || ...)) {
 *         return { action: reloadAction, reason: 'Please reload ...' };
 *     }
 *
 * `runtimeState` is exactly what the "Install from VSIX..." command turns into
 * its notification (`extensions.contribution.ts`: `requireReload` /
 * `requireRestart`), so with the *same* version string there is no reload
 * prompt at all: VS Code only says "Completed installing extension." - while
 * the VSIX install has already replaced the extension folder on disk
 * (`InstallExtensionInProfileTask.doRun` deletes and re-extracts the folder
 * when the version matches). The running extension host keeps the old bundle,
 * so the graph menus never appear until the user reloads by hand.
 *
 * Build metadata is the right knob for this:
 *  - `semver.valid('0.4.20+graph')` is `'0.4.20'`, so the extension is valid
 *    (four-part versions such as `0.4.20.1` are *not* - VS Code's
 *    `extensionValidator` rejects them);
 *  - `semver.eq('0.4.20+graph', '0.4.20')` is true, so the Extensions view
 *    never offers to "update" the graph build back to the publishable build;
 *  - but the version *string* differs, which is what makes VS Code ask for the
 *    reload.
 *
 * A prerelease (`0.4.20-graph`) would sort *below* `0.4.20`, so the Extensions
 * view would keep nagging to "update" to a build without the graph menus.
 */

/** Marker appended to the publishable version: `0.4.20` -> `0.4.20+graph`. */
export const GRAPH_VERSION_SUFFIX = '+graph';

/**
 * True when `version` already is a graph build version - `0.4.20+graph`, or
 * `<base>+<existing metadata>.graph` for a base that already carried metadata.
 */
export function isGraphVersion(version) {
	return version.endsWith(GRAPH_VERSION_SUFFIX) || /\+[^+]*\.graph$/.test(version);
}

/** `0.4.20` -> `0.4.20+graph`, `1.2.3+meta` -> `1.2.3+meta.graph`. Idempotent. */
export function toGraphVersion(version) {
	if (isGraphVersion(version)) {
		return version;
	}
	return version.includes('+') ? `${version}.graph` : `${version}${GRAPH_VERSION_SUFFIX}`;
}

/** The inverse of `toGraphVersion`; leaves a publishable version untouched. */
export function fromGraphVersion(version) {
	if (version.endsWith(GRAPH_VERSION_SUFFIX)) {
		return version.slice(0, -GRAPH_VERSION_SUFFIX.length);
	}
	if (isGraphVersion(version)) {
		return version.slice(0, -'.graph'.length);
	}
	return version;
}
