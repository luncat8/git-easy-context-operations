/** Maps VS Code configuration onto the typed {@link Settings} the core uses. */
import * as vscode from 'vscode';
import { CONFIG_SECTION, normalizeSettings, type Settings } from '../core/config';

export function readSettings(): Settings {
	const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
	// `WorkspaceConfiguration` exposes each key as a property; anything missing
	// or malformed falls back to the default inside `normalizeSettings`.
	return normalizeSettings(config as unknown as Record<string, unknown>);
}

export function affectsGeco(event: vscode.ConfigurationChangeEvent): boolean {
	return event.affectsConfiguration(CONFIG_SECTION) || event.affectsConfiguration('git.path');
}

/** The git executable: our own setting first, then VS Code's `git.path`, then PATH. */
export function resolveGitPath(settings: Settings): string | undefined {
	if (settings.gitPath.trim()) {
		return settings.gitPath.trim();
	}
	const fromGitExtension = vscode.workspace.getConfiguration('git').get<string>('path');
	return fromGitExtension && fromGitExtension.trim() ? fromGitExtension.trim() : undefined;
}
