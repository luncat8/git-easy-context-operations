#!/usr/bin/env python3
"""
One command that gets this repository from a fresh clone to a `.vsix`.

    python3 build.py                 # install what is missing, build both builds
    python3 build.py --install       # ...and install the graph build into VS Code
    python build.py --only-market    # the Marketplace-safe build only

It works the same on Linux, macOS and Windows (no shell needed on either side:
`npm` is started as `npm.cmd` through `cmd /c` on Windows), installs whatever is
missing - Node.js on request, the npm packages always - and refuses to leave a
manifest behind that asks for proposed APIs (those cannot be published).

Two artifacts land in `dist/`:

    <name>-<version>.vsix          publishable (Marketplace / Open VSX)
    <name>-<version>+graph.vsix    the same extension plus the Source Control
                                   Graph menus (proposed API, install by hand)
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
IS_WINDOWS = os.name == "nt"

MIN_NODE_MAJOR = 20  # what the toolchain (esbuild, @vscode/vsce, tsc) is built for
MIN_PYTHON = (3, 8)

GREEN, YELLOW, RED, DIM, BOLD, RESET = (
    ("\033[32m", "\033[33m", "\033[31m", "\033[2m", "\033[1m", "\033[0m")
    if sys.stdout.isatty() and not IS_WINDOWS
    else ("", "", "", "", "", "")
)


# --------------------------------------------------------------------- output

def step(message: str) -> None:
    print(f"\n{BOLD}== {message}{RESET}", flush=True)


def note(message: str) -> None:
    print(f"   {DIM}{message}{RESET}", flush=True)


def ok(message: str) -> None:
    print(f"   {GREEN}ok{RESET} {message}", flush=True)


def warn(message: str) -> None:
    print(f"   {YELLOW}!{RESET} {message}", flush=True)


def die(message: str, hint: str | None = None) -> "NoReturn":  # type: ignore[name-defined]
    print(f"\n{RED}{message}{RESET}", file=sys.stderr)
    if hint:
        print(f"{DIM}{hint}{RESET}", file=sys.stderr)
    raise SystemExit(1)


# ------------------------------------------------------------------- commands

class CommandError(Exception):
    def __init__(self, argv: list[str], code: int, output: str) -> None:
        super().__init__(f"`{' '.join(argv)}` exited with {code}\n{output}")
        self.argv, self.code, self.output = argv, code, output


def run(argv: list[str], *, cwd: Path = ROOT, capture: bool = False, check: bool = True) -> subprocess.CompletedProcess:
    """Run a command. `npm`/`npx` are `.cmd` files on Windows, which CreateProcess
    cannot start directly - so on Windows the line goes through `cmd /c`."""
    printable = " ".join(argv)
    if IS_WINDOWS:
        process = subprocess.run(
            subprocess.list2cmdline(argv),
            cwd=str(cwd),
            shell=True,
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
        )
    else:
        process = subprocess.run(
            argv,
            cwd=str(cwd),
            text=True,
            stdout=subprocess.PIPE if capture else None,
            stderr=subprocess.STDOUT if capture else None,
        )
    if check and process.returncode != 0:
        raise CommandError(argv, process.returncode, (process.stdout or "").strip())
    return process


def tool(name: str) -> str | None:
    """`shutil.which`, with the Windows `.cmd` shims npm installs covered."""
    found = shutil.which(name)
    if found:
        return found
    if IS_WINDOWS:
        for ext in (".cmd", ".bat", ".exe"):
            found = shutil.which(name + ext)
            if found:
                return found
    return None


def version_of(argv: list[str]) -> str | None:
    result = run(argv, capture=True, check=False)
    match = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?", result.stdout or "")
    return match.group(0) if match else None


# -------------------------------------------------------------------- checks

def check_python() -> None:
    if sys.version_info < MIN_PYTHON:
        die(
            f"Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+ is required (this is {platform.python_version()}).",
            "Re-run with a newer python3 / py -3.",
        )


def check_git() -> None:
    if tool("git"):
        ok(f"git {version_of(['git', '--version'])}")
    else:
        warn("git is not on PATH - the extension itself needs it at runtime.")


NODE_INSTALL_HINTS = {
    "Windows": "winget install OpenJS.NodeJS.LTS     (or: choco install nodejs-lts)",
    "Darwin": "brew install node@22",
    "Linux": "sudo apt install nodejs npm          (or your distro's package)",
}


def check_node(install_if_missing: bool) -> None:
    node = tool("node")
    npm = tool("npm")
    if node and npm:
        version = version_of(["node", "--version"]) or "0.0.0"
        major = int(version.split(".")[0])
        if major < MIN_NODE_MAJOR:
            die(
                f"Node.js {MIN_NODE_MAJOR}+ is required (this is {version}).",
                NODE_INSTALL_HINTS.get(platform.system(), "Install a newer Node.js LTS."),
            )
        ok(f"node {version}, npm {version_of(['npm', '--version'])}")
        return

    if not install_if_missing:
        hint = NODE_INSTALL_HINTS.get(platform.system(), "Install Node.js LTS from https://nodejs.org")
        die(
            "Node.js/npm were not found on PATH.",
            f"{hint}\n   ...or re-run with --install-node to try that for you.",
        )

    step("Installing Node.js")
    system = platform.system()
    attempts: list[list[str]] = []
    if system == "Windows":
        attempts = [
            ["winget", "install", "--silent", "--accept-package-agreements", "--accept-source-agreements", "OpenJS.NodeJS.LTS"],
            ["choco", "install", "-y", "nodejs-lts"],
            ["scoop", "install", "nodejs-lts"],
        ]
    elif system == "Darwin":
        attempts = [["brew", "install", "node@22"]]
    else:
        attempts = [
            ["sudo", "-n", "apt-get", "install", "-y", "nodejs", "npm"],
            ["sudo", "-n", "dnf", "install", "-y", "nodejs", "npm"],
            ["sudo", "-n", "pacman", "-S", "--noconfirm", "nodejs", "npm"],
        ]
    for argv in attempts:
        if not tool(argv[0]):
            continue
        note("$ " + " ".join(argv))
        if run(argv, check=False).returncode == 0 and tool("node") and tool("npm"):
            ok(f"node {version_of(['node', '--version'])}")
            return
        warn(f"`{argv[0]}` did not produce a usable node/npm - trying the next way.")
    die(
        "Could not install Node.js automatically.",
        NODE_INSTALL_HINTS.get(system, "Install Node.js LTS from https://nodejs.org")
        + "\n   Then re-run this script (a new terminal may be needed for PATH).",
    )


def manifest() -> dict:
    return json.loads((ROOT / "package.json").read_text(encoding="utf-8"))


def install_dependencies(force: bool) -> None:
    step("npm packages")
    modules = ROOT / "node_modules"
    lock = ROOT / "package-lock.json"
    stamp = modules / ".package-lock.json"
    up_to_date = (
        modules.is_dir()
        and stamp.exists()
        and (not lock.exists() or stamp.stat().st_mtime >= lock.stat().st_mtime)
        and (ROOT / "node_modules" / "@vscode" / "vsce").is_dir()
    )
    if up_to_date and not force:
        ok(f"node_modules is up to date ({len(list(modules.iterdir()))} entries)")
        return

    argv = ["npm", "ci"] if lock.exists() else ["npm", "install"]
    if not up_to_date and modules.is_dir():
        note("package-lock.json changed (or --force-deps) - reinstalling")
    try:
        run(argv)
    except CommandError as error:
        if argv[1] == "ci":
            warn("`npm ci` failed - falling back to `npm install`")
            run(["npm", "install"])
        else:
            raise
    ok("dependencies installed")


# --------------------------------------------------------------------- build

def apply_graph_menu(state: str) -> None:
    run(["node", str(ROOT / "scripts" / "apply-graph-menu.mjs"), state], check=False)


def assert_publishable_manifest() -> None:
    """A manifest that asks for proposed APIs cannot be published - never leave
    one behind, even when a build crashed halfway through."""
    data = manifest()
    if data.get("enabledApiProposals"):
        warn("package.json still asks for proposed APIs - restoring the publishable manifest")
        apply_graph_menu("off")
    if manifest().get("enabledApiProposals"):
        die("package.json still declares enabledApiProposals - run: node scripts/apply-graph-menu.mjs off")


def build_vsix(script: str, label: str) -> Path | None:
    step(label)
    try:
        run(["npm", "run", script])
    except CommandError as error:
        print(error.output)
        die(f"{label} failed.")
    return None


def find_vsix(name: str, version: str, graph: bool) -> Path:
    suffix = "+graph" if graph else ""
    expected = ROOT / "dist" / f"{name}-{version}{suffix}.vsix"
    if expected.exists():
        return expected
    matches = sorted((ROOT / "dist").glob(f"{name}-{version}{suffix}*.vsix"))
    if matches:
        return matches[-1]
    die(f"{expected.name} was not produced - look at the output above.")
    raise AssertionError  # unreachable, for the type checker


def summary(artifacts: list[Path], started: float) -> None:
    step("Done")
    for artifact in artifacts:
        size = artifact.stat().st_size / 1024
        print(f"   {GREEN}{artifact.relative_to(ROOT)}{RESET}  {DIM}({size:.0f} KB){RESET}")
    print(
        f"\n{DIM}Install by hand:{RESET}  code --install-extension {artifacts[0].as_posix()}"
        if artifacts
        else "",
    )
    print(f"{DIM}{time.time() - started:.1f}s{RESET}")


# ---------------------------------------------------------------------- main

def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Install what is missing and build the .vsix (Linux, macOS, Windows).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--only-market", action="store_true", help="skip the +graph build (proposed-API menus)")
    group.add_argument("--only-graph", action="store_true", help="skip the publishable build")
    parser.add_argument("--install", action="store_true", help="install the built graph build into the editor")
    parser.add_argument("--cli", default="code", help="editor CLI for --install (code, code-insiders, codium, cursor)")
    parser.add_argument("--tests", action="store_true", help="run the test suite before packaging")
    parser.add_argument("--force-deps", action="store_true", help="reinstall node_modules even when it looks current")
    parser.add_argument("--install-node", action="store_true", help="try to install Node.js when it is missing")
    parser.add_argument("--clean", action="store_true", help="delete dist/ and node_modules/ first")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    started = time.time()

    step(f"Git Easy Ops build  ({platform.system()} {platform.release()}, python {platform.python_version()})")
    if not (ROOT / "package.json").exists():
        die(f"{ROOT} does not look like the extension repository.")
    check_python()
    check_git()
    check_node(args.install_node)

    if args.clean:
        step("Cleaning")
        for target in (ROOT / "dist", ROOT / "node_modules"):
            shutil.rmtree(target, ignore_errors=True)
            note(f"removed {target.relative_to(ROOT)}/")

    install_dependencies(args.force_deps)
    assert_publishable_manifest()

    if args.tests:
        build_vsix("test", "Test suite")

    data = manifest()
    name, version = data["name"], data["version"]
    note(f"{data.get('displayName', name)} {version}, vscode {data.get('engines', {}).get('vscode', '?')}")

    artifacts: list[Path] = []
    if not args.only_graph:
        build_vsix("package", "Package the publishable build")
        artifacts.append(find_vsix(name, version, graph=False))
    if not args.only_market:
        build_vsix("package:graph", "Package the +graph build (Source Control Graph menus)")
        artifacts.append(find_vsix(name, version, graph=True))

    # The graph script patches package.json and restores it in a `finally`;
    # double-check so a Ctrl-C or a crash cannot leave an unpublishable manifest.
    assert_publishable_manifest()

    if args.install:
        target = next((a for a in artifacts if a.name.endswith("+graph.vsix")), artifacts[0])
        step(f"Install into {args.cli}")
        if not tool(args.cli):
            warn(f"`{args.cli}` was not found on PATH - install it by hand:\n   {args.cli} --install-extension {target.as_posix()}")
        else:
            run([args.cli, "--install-extension", target.as_posix()])
            ok(f"{target.name} installed")
            note('Then run "Git Easy Ops: Enable Source Control Graph Menu..." to grant the proposed API.')

    summary(artifacts, started)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main(sys.argv[1:]))
    except KeyboardInterrupt:
        print(f"\n{YELLOW}interrupted{RESET}", file=sys.stderr)
        try:
            apply_graph_menu("off")
        except Exception:  # pragma: no cover - best effort
            pass
        raise SystemExit(130)
