/**
 * "Copy Repository Web Link" - turns the configured git remote into the
 * browsable web address of the repository (what you would open in a browser).
 *
 * Works for the usual remote spellings and returns `undefined` for anything
 * that is not a network remote (local paths, Windows drive letters, unknown
 * schemes), so the caller can say so instead of copying a bogus link:
 *
 *   https://github.com/acme/app.git            -> https://github.com/acme/app
 *   https://user:token@github.com/acme/app     -> https://github.com/acme/app
 *   git@github.com:acme/app.git                -> https://github.com/acme/app
 *   ssh://git@gitlab.example.com:2222/grp/app  -> https://gitlab.example.com/grp/app
 *   git://example.org/acme/app.git             -> https://example.org/acme/app
 *
 * Credentials are always dropped, so a token embedded in a remote URL never
 * ends up on the clipboard.
 */

const NETWORK_SCHEMES = new Set(['https', 'http', 'ssh', 'git', 'git+ssh', 'ssh+git']);

export function remoteToWebUrl(remoteUrl: string): string | undefined {
	const url = remoteUrl.trim();
	if (!url) {
		return undefined;
	}

	let host: string;
	let path: string;

	const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
	if (scheme) {
		const proto = scheme[1]!.toLowerCase();
		if (!NETWORK_SCHEMES.has(proto)) {
			return undefined;
		}
		const rest = url.slice(scheme[0].length);
		const slash = rest.indexOf('/');
		if (slash < 0) {
			return undefined;
		}
		const authority = rest.slice(0, slash);
		path = rest.slice(slash + 1);
		// Drop `user:password@`, then the port: an ssh port is not a web port,
		// while an explicit https port is kept as the browser needs it.
		const hostPort = authority.slice(authority.lastIndexOf('@') + 1);
		const keepPort = proto === 'https' || proto === 'http';
		host = keepPort ? hostPort : hostPort.replace(/:\d+$/, '');
	} else {
		// scp-like syntax: [user@]host:path/to/repo.git
		const match = /^(?:[^@/\\:]+@)?([^:/\\]+):(?!\/\/)(.+)$/.exec(url);
		if (!match) {
			return undefined;
		}
		// `C:\repo` is a local Windows path, not a host called "C".
		if (match[1]!.length === 1) {
			return undefined;
		}
		host = match[1]!;
		path = match[2]!;
	}

	host = host.trim();
	path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
	if (!host || !path || /\s/.test(host)) {
		return undefined;
	}
	return `https://${host}/${path}`;
}
