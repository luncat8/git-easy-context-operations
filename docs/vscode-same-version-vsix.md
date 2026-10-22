# VS Code: installing a VSIX of the same version never asks for a reload

Investigation behind the `+graph` version of this extension (0.4.20) - and the
case for reporting the behaviour upstream.

Checked against `microsoft/vscode` `main` on 2026-10-22 (commit `10aaa39`).
File names and line numbers are from that tree.

## What happens

1. Install `git-easy-context-operations-0.4.19.vsix` (publishable build).
2. Without reloading, install `git-easy-context-operations-0.4.19+graph.vsix`.
3. VS Code shows **"Completed installing extension."** - and nothing else. No
   *Reload Now*, no *Restart Extensions*, no *Reload Required* in the
   Extensions view.
4. The extension folder on disk *is* the new build, but the running extension
   host still executes the old one, so the graph menus never appear. Only
   *Developer: Reload Window* fixes it.

Before 0.4.20 the two artifacts deliberately shared `"version": "0.4.19"`; only
the file name (and the menus) differed.

## Root cause

**Which notification is shown** - `extensions.contribution.ts`, the
`INSTALL_EXTENSION_FROM_VSIX_COMMAND_ID` command (around line 963): it installs
with `installGivenVersion: true`, then inspects
`r.value.runtimeState?.action` and picks

- `ReloadWindow` → "Please reload Visual Studio Code to enable it." + *Reload Now*
- `RestartExtensions` → "Please restart extensions to enable it." + *Restart Extensions*
- anything else (including `undefined`) → "Completed installing extension."

**Where `runtimeState` comes from** - `extensionsWorkbenchService.ts`,
`getRuntimeState()` (line 1793). The only branch that reports "the installed
build differs from the running one" is

```ts
if (!runningExtension.isUnderDevelopment
    && (extension.version !== runningExtension.version
        || extension.local.targetPlatform !== runningExtension.targetPlatform)) {
    return { action: reloadAction, reason: 'Please reload ...' };
}
```

(line 1824, `extension.version` is `local.manifest.version` - a raw string,
see the `Extension.version` getter at line 231). Two manifests that both say
`0.4.19` are indistinguishable here, so the whole reload branch is skipped.

**What the install did** - and this is the part that makes it a bug rather than
a no-op: `InstallExtensionInProfileTask.doRun()` in
`src/vs/platform/extensionManagement/node/extensionManagementService.ts`
(line 1066) replaces the extension *even when the version is identical*:

```ts
if (this.source instanceof URI) {            // VSIX
    if (existingExtension) {
        if (this.extensionKey.equals(new ExtensionKey(existingExtension.identifier, existingExtension.manifest.version))) {
            await this.extensionsScanner.deleteExtension(existingExtension, 'existing');
        }
    }
```

So the folder is deleted and re-extracted, the profile entry is rewritten
(`extensionsProfileScannerService.ts` line 131 compares
`e.manifest.version !== existing.version` - also a string), and yet VS Code
concludes "nothing changed that needs a reload".

**Why the local profile looks unchanged too** - in
`ExtensionsWorkbenchService.installFromVSIX()` (line 3058) the `pinned` /
`installGivenVersion` options are only computed from
`existingExtension.latestVersion === manifest.version`; equal versions take
the "same version, just pin it" path. Nothing there records that a *different
VSIX* was installed.

## Why this is a VS Code bug

- The install knows it replaced an extension that is currently loaded - the
  code above is exactly that case. Whether the *code* changed cannot be
  derived from the version string; a locally rebuilt VSIX, a patched build or
  a build-metadata variant can all carry the same version.
- The user gets a success toast with no action, and the extension silently
  keeps running the old code until some unrelated reload. There is no UI hint
  at all (not even *Reload Required*).
- Reasonable fix upstream: when a VSIX install replaces an extension that the
  current session has loaded, report `runtimeState` (reload/restart) even if
  the version strings are equal - e.g. by tracking "the installed location
  changed/was rewritten" in the install result instead of comparing versions,
  or by comparing installed timestamps/hashes for VSIX installs.

Related issues (none of them is this case exactly):

- microsoft/vscode#189877 - *Install VSIX of same version ... makes extension
  disappear after Reload* (2023 regression, fixed). Same-version reinstalls
  used to break the folder; that is why the delete-and-re-extract code exists.
- microsoft/vscode#233758 - *Extension editor doesn't refresh after new
  extension version is installed from VSIX*.
- microsoft/vscode#250116 - *Wrong/previous version of the extension is still
  used ... after Install From VSIX and Restart Extension* (open; about
  `IExtensionPoint.setHandler` deltas, not the missing prompt).
- microsoft/vscode#234477 - *Install Extension from .vsix doesn't always work*
  (same-version VSIX from the file dialog; closed, not reproducible).

## What this repository does about it

The graph build now stamps the manifest with a different version *string*:
`0.4.20` → `0.4.20+graph` (`scripts/graph-version.mjs`, applied and restored by
`scripts/apply-graph-menu.mjs`). Build metadata was chosen because

| version        | semver valid | vs `0.4.20` | reload prompt | update nag |
| -------------- | ------------ | ----------- | ------------- | ---------- |
| `0.4.20.1`     | no (four segments - `extensionValidator.ts` line 317 rejects it) | - | - | - |
| `0.4.20-graph` | yes          | lower       | yes           | **yes** ("update" back to the publishable build) |
| `0.4.20+graph` | yes          | equal       | yes (string differs) | no |

The `.vsix` file name is unchanged: `dist/git-easy-context-operations-0.4.20+graph.vsix`.

## Ready-to-file issue text

> **Title:** Installing a VSIX over a running extension of the same version asks for no reload
>
> **Type:** Bug
>
> **Steps to reproduce**
> 1. Build two VSIX files of the same extension with the *same* `version` in
>    `package.json` but different code (e.g. one adds a `contributes.menus`
>    entry). Install the first one, let the window finish loading.
> 2. With the window still open, run **Extensions: Install from VSIX...** and
>    pick the second file.
> 3. Observe the notification.
>
> **Actual:** "Completed installing extension." No *Restart Extensions* /
> *Reload Now* button, no *Reload Required* in the Extensions view. The
> extension folder on disk is the new build (the install deletes and
> re-extracts it), but the extension host keeps running the old code; new
> commands/menus never appear until *Developer: Reload Window*.
>
> **Expected:** VS Code knows it replaced an extension that is currently
> loaded and offers *Restart Extensions* (local) / *Reload Window* (remote),
> exactly as it does for a version change.
>
> **Why:** the reload state is derived only from
> `extension.version !== runningExtension.version`
> (`ExtensionsWorkbenchService.getRuntimeState()`,
> `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts`),
> while `InstallExtensionInProfileTask.doRun()`
> (`src/vs/platform/extensionManagement/node/extensionManagementService.ts`)
> replaces a same-version extension on disk. Same version ⇒ no prompt ⇒ stale
> code runs.
>
> **Suggested fix:** base the reload requirement of a VSIX install on "the
> installed extension was replaced while this window has it loaded" (e.g. a
> flag/`mtime` from the install result), not on version-string equality.
>
> **VS Code version:** 1.9x (checked against `main` `10aaa39`), any OS.
