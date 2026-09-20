/**
 * Asking for permission, then installing `git-filter-repo` - instead of only
 * telling the user to do it by hand.
 *
 * "Clean History" rewrites the repository with the external `git-filter-repo`
 * tool. When it is missing, the flow used to stop at "here is the script, run
 * it yourself". Now it offers the installation it can safely perform itself:
 * user-space installers first (pip family, Homebrew), then the distro package
 * managers - but those only when `sudo -n` proves that no password would be
 * asked for (this extension cannot answer a password prompt; the spawned
 * process has no terminal). Whatever cannot be installed automatically still
 * ends in the copy-paste script, as before.
 *
 * Every candidate is a pair of argv arrays: a cheap probe (`--version`) and
 * the installation command. The controller probes them in priority order and
 * offers the first one that answers; a failed install falls through to the
 * next candidate, and a PEP 668 "externally-managed-environment" refusal gets
 * its own explanation (that is what modern Debian/Ubuntu Pythons say).
 */

/** Result of one external command (shared shape with `cleanHistory.ts`). */
export interface InstallerRunResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** One way to install git-filter-repo that the extension may offer to run. */
export interface FilterRepoInstaller {
	/** Stable id, e.g. `pip3`, `brew`, `apt` - used in tests and logs. */
	id: string;
	/** Human name for the action button (`Install with pip3`). */
	label: string;
	/** Cheap check that the installer's tool exists (`['pip3', '--version']`). */
	probe: string[];
	/** The installation itself (`['pip3', 'install', 'git-filter-repo']`). */
	command: string[];
	/** Caveat shown in the dialog detail, e.g. `needs passwordless sudo`. */
	note?: string;
	/** Only offered when `sudo -n true` proves no password is needed. */
	needsSudo?: boolean;
}

/** Injectable runner for the installer probes and the installation itself. */
export type InstallerRunner = (command: readonly string[], cwd: string) => Promise<InstallerRunResult>;

/** How long a `--version` probe may take before the tool counts as missing. */
export const INSTALLER_PROBE_TIMEOUT_MS = 20_000;
/** pip/brew/dnf can take minutes on a cold cache - 10 minutes per install. */
export const INSTALL_TIMEOUT_MS = 600_000;

const PACKAGE = 'git-filter-repo';

function pipInstaller(argv0: string, rest: string[], id = argv0, label = argv0): FilterRepoInstaller {
	return {
		id,
		label,
		probe: [argv0, ...rest, '--version'],
		command: [argv0, ...rest, 'install', PACKAGE],
	};
}

/**
 * The candidate list for one platform, in priority order: user-space tools
 * before anything that needs root, the platform's native way first.
 */
export function filterRepoInstallers(platform: NodeJS.Platform): FilterRepoInstaller[] {
	const pipFamily: FilterRepoInstaller[] = [
		pipInstaller('pip3', []),
		pipInstaller('python3', ['-m', 'pip'], 'python3-pip', 'python3 -m pip'),
		pipInstaller('pip', []),
	];
	switch (platform) {
		case 'darwin':
			// Homebrew installs its own Python and puts `git-filter-repo` on
			// PATH - on a Mac it is the least surprising route.
			return [
				{ id: 'brew', label: 'brew', probe: ['brew', '--version'], command: ['brew', 'install', PACKAGE] },
				...pipFamily,
			];
		case 'linux':
			// The distro packages are the cleanest fix when pip is PEP 668
			// locked down - but only offered when `sudo -n` works without a
			// password (see `needsSudo`), which the controller probes first.
			return [
				...pipFamily,
				{
					id: 'apt',
					label: 'apt-get (sudo)',
					probe: ['apt-get', '--version'],
					command: ['sudo', '-n', 'apt-get', 'install', '-y', PACKAGE],
					note: 'uses sudo; only offered when sudo works without a password',
					needsSudo: true,
				},
				{
					id: 'dnf',
					label: 'dnf (sudo)',
					probe: ['dnf', '--version'],
					command: ['sudo', '-n', 'dnf', 'install', '-y', PACKAGE],
					note: 'uses sudo; only offered when sudo works without a password',
					needsSudo: true,
				},
				{
					id: 'pacman',
					label: 'pacman (sudo)',
					probe: ['pacman', '--version'],
					command: ['sudo', '-n', 'pacman', '-S', '--noconfirm', PACKAGE],
					note: 'uses sudo; only offered when sudo works without a password',
					needsSudo: true,
				},
			];
		case 'win32':
			// The py launcher is the one Python entry Windows always has when
			// Python is installed at all; `python3` there is often the Store
			// stub that opens the Microsoft Store instead of running pip.
			return [
				pipInstaller('py', ['-3'], 'py-pip', 'py -3 -m pip'),
				pipInstaller('pip3', []),
				pipInstaller('pip', []),
			];
		default:
			return pipFamily;
	}
}

/** Installers that must not be offered unless `sudo -n true` succeeds. */
export function needsSudo(installer: FilterRepoInstaller): boolean {
	return Boolean(installer.needsSudo);
}

/** The probe that decides whether sudo may be used without a prompt. */
export const SUDO_PROBE: readonly string[] = ['sudo', '-n', 'true'];

/**
 * pip's refusal on externally-managed Pythons (PEP 668, Debian 12+/Ubuntu
 * 23.04+/Fedora): plain `pip install` (even `--user`) exits with this string.
 * The hint names the three real ways out instead of the raw wall of text.
 */
export function externallyManagedHint(stderr: string): string | undefined {
	return /externally-managed-environment/i.test(stderr)
		? 'This Python is externally managed (PEP 668). Install the system package instead '
			+ '(e.g. "sudo apt install git-filter-repo"), use pipx, or rerun pip with '
			+ '--break-system-packages if you know what that means here.'
		: undefined;
}

/** The first stderr line, without ANSI escapes - what the dialog shows. */
export function firstErrorLine(result: InstallerRunResult): string {
	const text = `${result.stderr.trim() || result.stdout.trim()}`;
	return text.split('\n')[0]?.replace(/\x1b\[[0-9;]*m/g, '') || `exit ${result.exitCode}`;
}
