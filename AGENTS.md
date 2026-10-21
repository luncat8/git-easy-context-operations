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

This installs the graph flavor in `package.json` temporarily, bundles with esbuild,
runs `vsce`, and restores the manifest. Result:
`dist/git-easy-context-operations-<version>+graph.vsix`

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
