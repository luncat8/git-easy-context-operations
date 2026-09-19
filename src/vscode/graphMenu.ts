/** File IO and VS Code specifics for the Source Control Graph menu diagnostics. */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { argvJsonDirFor } from '../core/argvJson';
import { GRAPH_MENU_KEYS, type ArgvStore, type GraphMenuBuild } from '../core/graphMenu';

/**
 * Where VS Code keeps its runtime arguments: `<portable>/argv.json` in portable
 * mode, otherwise `~/.vscode/argv.json` (`.vscode-insiders`, `.vscode-oss`, ...
 * for other flavours). This is the file behind
 * "Preferences: Configure Runtime Arguments".
 */
export function argvJsonPath(appName: string, env: NodeJS.ProcessEnv = process.env): string {
	const portable = env.VSCODE_PORTABLE;
	if (portable && portable.trim()) {
		return path.join(portable, 'argv.json');
	}
	return path.join(env.HOME ?? os.homedir(), argvJsonDirFor(appName), 'argv.json');
}

export class FsArgvStore implements ArgvStore {
	constructor(private readonly file: string) {}

	get path(): string {
		return this.file;
	}

	async read(): Promise<string | undefined> {
		try {
			return await fsp.readFile(this.file, 'utf8');
		} catch {
			return undefined;
		}
	}

	async write(text: string): Promise<void> {
		await fsp.mkdir(path.dirname(this.file), { recursive: true });
		const tmp = `${this.file}.geco-tmp`;
		await fsp.writeFile(tmp, text, 'utf8');
		await fsp.rename(tmp, this.file);
	}

	async backup(): Promise<string | undefined> {
		if (!fs.existsSync(this.file)) {
			return undefined;
		}
		const target = `${this.file}.geco-backup`;
		await fsp.copyFile(this.file, target);
		return target;
	}
}

/** What the *installed* build declares, read from its own manifest. */
export function describeInstalledBuild(context: vscode.ExtensionContext, appName: string = vscode.env.appName): GraphMenuBuild {
	const manifest = (context.extension?.packageJSON ?? {}) as {
		publisher?: string;
		name?: string;
		version?: string;
		enabledApiProposals?: string[];
		contributes?: { menus?: Record<string, unknown> };
	};
	const menuKeys = Object.keys(manifest.contributes?.menus ?? {}).filter((key) => (GRAPH_MENU_KEYS as readonly string[]).includes(key));

	return {
		extensionId: `${manifest.publisher ?? 'luncat8'}.${manifest.name ?? 'git-easy-context-operations'}`,
		hasProposals: (manifest.enabledApiProposals ?? []).includes('contribSourceControlHistoryItemMenu'),
		menuKeys,
		argvPath: argvJsonPath(appName),
		cliCommand: cliCommandFor(appName),
		graphVsixName: `${manifest.name ?? 'git-easy-context-operations'}-${manifest.version ?? '0.0.0'}+graph.vsix`,
	};
}

function cliCommandFor(appName: string): string {
	if (appName.includes('Insiders')) {
		return 'code-insiders';
	}
	if (appName.includes('Exploration')) {
		return 'code-exploration';
	}
	switch (appName) {
		case 'VSCodium':
			return 'codium';
		case 'Cursor':
			return 'cursor';
		case 'Windsurf':
			return 'windsurf';
		default:
			return 'code';
	}
}
