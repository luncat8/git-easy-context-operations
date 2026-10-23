# Agents

## Build

The one-command way (Linux, macOS, Windows) - installs what is missing, builds
both `.vsix` files into `dist/`, and leaves no proposed-API manifest behind:

```bash
python3 build.py            # python build.py on Windows
python3 build.py --install  # ...and install the graph build into VS Code
python3 build.py --tests    # run the suite first
```

Or with npm. By default you only need the graph build - it is a superset of the
publishable build (the same extension, plus the proposed-API menus):

```bash
npm install
npm run package:graph
```

This installs the graph flavor in `package.json` temporarily (menus *and* the
`<version>+graph` version string - see the version rules below), bundles with
esbuild, runs `vsce`, and restores the manifest. Result:
`dist/git-easy-context-operations-<version>+graph.vsix`, which VS Code shows as
`<version>+graph`.

Install in VS Code:
```bash
code --install-extension dist/<new>.vsix
```

Then run "Git Easy Ops: Enable Source Control Graph Menu..." to grant the proposed API.

For the Marketplace-safe build (without graph menus) use:
```bash
npm run package
```

## Versioning and Build Rules

- **Up / bump the version on every big commit** (e.g. `0.4.0` -> `0.4.1` -> `0.4.2`):
  - bump the `"version"` field in `package.json` (and `package-lock.json`).
  - Update all references to the `.vsix` filenames in `README.md`, `AGENTS.md`, and `CHANGELOG.md` to match the new version.
  - **Purpose**: This ensures the user can inspect the version number in VS Code's Extensions view to verify whether the newly built extension is actually installed or if an older build is still cached/active.
- **VSIX Output Location**:
  - All `.vsix` artifacts must be placed in the `dist/` directory (e.g. `dist/...vsix`).
- **The graph build must carry its own version string** (`0.4.22+graph`):
  - `node scripts/apply-graph-menu.mjs on` stamps it and `off` restores it; the
    mapping lives in `scripts/graph-version.mjs`, the artifact keeps its name
    (`dist/<name>-<version>+graph.vsix`).
  - **Never let the publishable build and the graph build of one release share
    a version.** VS Code decides whether an install needs a reload by comparing
    version *strings* (`getRuntimeState()` in
    `src/vs/workbench/contrib/extensions/browser/extensionsWorkbenchService.ts`:
    `extension.version !== runningExtension.version`), and the *Install from
    VSIX...* notification is derived from that state. With the same version the
    install replaces the extension folder but VS Code shows only "Completed
    installing extension." - no reload button - and the old build keeps
    running. That was the 0.4.19 report: graph menus never appeared until a
    manual reload.
  - Do not "fix" this with `0.4.20.1` / `0.4.20.1-graph` (four segments are not
    semver - VS Code rejects the manifest) or `0.4.20-graph` (a prerelease
    sorts *below* `0.4.20`, so the Extensions view offers to "update" back to
    the build without graph menus). `+graph` is semver-equal (`semver.eq`) but
    a different string, which is exactly what the reload check looks at.
  - `build.py` refuses to leave a `+graph` version (or `enabledApiProposals`)
    in `package.json`, so a crashed build cannot produce a publishable
    manifest that looks like a graph one.

## The UI rules that keep regressing

Both rules below were "fixed" more than once, each time only where it was
reported. They are stated here so the next change does not reintroduce them.

1. **Never hand a notification to the user and wait for it, unless the answer
   is what the flow needs next.**
   `showInformationMessage` / `showWarningMessage` / `showErrorMessage` resolve
   when the notification *goes away*: 10 s for an info toast, and never under
   Do Not Disturb, while the mouse hovers it, or while the window is unfocused.
   A command that waits for one stays pending, and an action started from the
   built-in Source Control Graph runs under a progress indicator that lasts
   exactly as long as the command's promise - the **endless progress bar**.
   - A plain message: `UI.message` (the adapter already uses
     `reportWithoutWaiting`).
   - An end-of-operation report with buttons (*Undo*, *Force Push*, *Open
     Worktree*, ...): `Controller.reportResult(headline, options, followUp)`.
     It is the only supported way; it hands the report over, registers the
     follow-up, logs a failing follow-up, and lets the command finish.
   - A genuine question whose answer drives the flow (install a tool now? abort
     the unfinished merge? which commit?): `await this.ui.ask(...)` /
     `ui.pick` / `ui.confirm` is correct and expected.
   - `src/test/core/endlessProgress.test.ts` drives every report-bearing flow
     with a notification that never settles; add a case there when a new flow
     reports a result.

2. **One decision, one confirmation.** If the user already pressed a button
   that says what will happen ("Force Push", "Delete Everywhere"), do not ask
   the same question again in a modal dialog. `forcePush(..., { confirmed:
   true })` is how a flow passes an answer that was already given; a force
   push started from a menu keeps its own modal confirmation.
