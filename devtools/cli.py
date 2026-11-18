"""Developer CLI: check, test, test-browser, build, ha, deploy, release-zip,
bump-ha."""

import json
import re
import subprocess
import sys
import zipfile
from importlib import metadata
from pathlib import Path

import click

ROOT = Path(__file__).resolve().parent.parent
INTEGRATION = ROOT / "custom_components" / "hybrid_zone_thermostat"
RELEASE_ZIP = ROOT / "hybrid_zone_thermostat.zip"
FRONTEND_PIN = re.compile(r'"home-assistant-frontend==([^"]+)"')


def _run(command: list[str]) -> int:
    return subprocess.run(command, check=False, cwd=ROOT).returncode


def _run_or_exit(command: list[str]) -> None:
    code = _run(command)
    if code:
        sys.exit(code)


@click.group()
def dev() -> None:
    """Developer commands."""


@dev.command("check")
def check() -> None:
    """Run every check against the working tree; nothing is auto-fixed.

    1. Ruff check
    2. Ruff format check
    3. mypy (strict)
    4. The frontend pin matches the locked Home Assistant's
    5. Frontend check (`npm run check`: Biome, tsc)

    Exit codes: 0 all passed, 2 one or more failed.
    """
    steps: list[tuple[str, list[str]]] = [
        ("Ruff check...", ["uv", "run", "ruff", "check"]),
        ("Ruff format check...", ["uv", "run", "ruff", "format", "--check"]),
        ("mypy...", ["uv", "run", "mypy"]),
        ("Frontend pin...", ["uv", "run", "dev", "check-frontend-pin"]),
        ("Frontend check...", ["npm", "run", "check"]),
    ]
    failed = False
    for name, command in steps:
        click.echo(f"\n{name}")
        if _run(command):
            failed = True
    sys.exit(2 if failed else 0)


def _ha_frontend_requirement() -> str:
    """The home-assistant-frontend version the installed HA asks for."""
    import homeassistant.components.frontend as ha_frontend

    manifest = Path(ha_frontend.__file__).with_name("manifest.json")
    requirements: list[str] = json.loads(manifest.read_text())["requirements"]
    for requirement in requirements:
        name, _, version = requirement.partition("==")
        if name == "home-assistant-frontend":
            return version
    msg = "HA's frontend manifest names no home-assistant-frontend"
    raise click.ClickException(msg)


@dev.command("check-frontend-pin")
def check_frontend_pin() -> None:
    """Fail if home-assistant-frontend isn't the version HA requires."""
    wanted = _ha_frontend_requirement()
    installed = metadata.version("home-assistant-frontend")
    if installed != wanted:
        msg = (
            f"home-assistant-frontend is {installed}, HA wants {wanted}. "
            "Run `uv run dev bump-ha`."
        )
        raise click.ClickException(msg)
    click.echo(f"home-assistant-frontend {installed}, as HA requires.")


@dev.command("bump-ha")
def bump_ha() -> None:
    """Move to the newest Home Assistant the test harness supports.

    Upgrades pytest-homeassistant-custom-component (which pins HA), then
    sets the home-assistant-frontend pin in pyproject.toml to what that HA
    requires, and locks and installs again.
    """
    _run_or_exit(
        [
            "uv",
            "lock",
            "--upgrade-package",
            "pytest-homeassistant-custom-component",
        ]
    )
    _run_or_exit(["uv", "sync", "--dev", "--quiet"])
    # A fresh interpreter: this one imported the old HA.
    wanted = subprocess.run(
        [
            "uv",
            "run",
            "python",
            "-c",
            "from devtools.cli import _ha_frontend_requirement as r; print(r())",
        ],
        check=True,
        cwd=ROOT,
        capture_output=True,
        text=True,
    ).stdout.strip()
    pyproject = ROOT / "pyproject.toml"
    text = pyproject.read_text()
    pyproject.write_text(
        FRONTEND_PIN.sub(f'"home-assistant-frontend=={wanted}"', text)
    )
    _run_or_exit(["uv", "lock"])
    _run_or_exit(["uv", "sync", "--dev", "--quiet"])
    click.echo(f"home-assistant-frontend pinned to {wanted}.")


@dev.command("test", context_settings={"ignore_unknown_options": True})
@click.argument("pytest_args", nargs=-1, type=click.UNPROCESSED)
def test(pytest_args: tuple[str, ...]) -> None:
    """Python tests: the controller, simulations, HA integration."""
    sys.exit(_run(["uv", "run", "pytest", *pytest_args]))


@dev.command("test-browser", context_settings={"ignore_unknown_options": True})
@click.argument("playwright_args", nargs=-1, type=click.UNPROCESSED)
def test_browser(playwright_args: tuple[str, ...]) -> None:
    """Browser tests of the panel and card, on the harness page."""
    sys.exit(_run(["npx", "playwright", "test", *playwright_args]))


@dev.command("build")
def build() -> None:
    """Build the panel and card into the integration."""
    sys.exit(_run(["npm", "run", "build"]))


@dev.command("ha")
def ha() -> None:
    """Run Home Assistant in Docker with this integration mounted.

    Open http://localhost:8123. Its config lives in .ha-config/. After a
    Python change, restart HA (Developer tools > Restart); `npm run watch`
    in another terminal rebuilds the frontend on every change.
    """
    _run_or_exit(["npm", "run", "build"])
    (ROOT / ".ha-config").mkdir(exist_ok=True)
    sys.exit(_run(["docker", "compose", "up"]))


@dev.command("deploy")
@click.option(
    "--host",
    envvar="HZT_DEPLOY_HOST",
    required=True,
    help="SSH target of a Home Assistant OS box with the SSH add-on, "
    "e.g. me@homeassistant.local. Or set HZT_DEPLOY_HOST.",
)
@click.option(
    "--restart/--no-restart",
    default=None,
    help="Restart HA core afterwards. By default, only if something other "
    "than the frontend changed: the panel and card are served uncached, so "
    "a browser reload picks them up.",
)
def deploy(host: str, restart: bool | None) -> None:
    """Build, copy the integration to a real Home Assistant, restart it.

    For development against a real house: HA's config folder gets this
    working tree's integration, replacing whatever HACS installed.
    """
    _run_or_exit(["npm", "run", "build"])
    result = subprocess.run(
        [
            "rsync",
            "-rlt",
            "--checksum",
            "--delete",
            # Lists each file sent. Not --itemize-changes: macOS's rsync
            # (openrsync) accepts it and prints nothing.
            "--verbose",
            "--exclude=__pycache__",
            "--exclude=.DS_Store",
            # The SSH add-on's user isn't root, and /config is root's.
            "--rsync-path=sudo rsync",
            f"{INTEGRATION}/",
            f"{host}:/config/custom_components/{INTEGRATION.name}/",
        ],
        check=False,
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    if result.returncode:
        click.echo(result.stderr, err=True)
        sys.exit(result.returncode)

    changed = _rsync_changed_paths(result.stdout)
    for path in changed:
        click.echo(f"  {path}")
    if not changed:
        click.echo("Nothing changed.")
    backend_changed = any(not path.startswith("frontend/") for path in changed)

    if restart or (restart is None and backend_changed):
        click.echo("Checking the config and restarting HA core...")
        _run_or_exit(
            ["ssh", host, 'bash -lc "ha core check && ha core restart"']
        )
        click.echo("HA core restarted.")
    elif changed:
        click.echo("Frontend only: reload the browser.")


def _rsync_changed_paths(output: str) -> list[str]:
    """The files `rsync --verbose` sent or deleted, from its output.

    Both openrsync and GNU rsync print one path per line between a header
    and a summary; directories end in a slash.

    >>> _rsync_changed_paths(
    ...     "Transfer starting: 24 files\\n"
    ...     "control/\\n"
    ...     "const.py\\n"
    ...     "deleting old.py\\n"
    ...     "\\n"
    ...     "sent 1082 bytes  received 26 bytes  99819 bytes/sec\\n"
    ...     "total size is 74697  speedup is 67.42\\n"
    ... )
    ['const.py', 'old.py']
    """
    noise = (
        "Transfer starting",
        "sending incremental file list",
        "sent ",
        "total size",
    )
    paths = []
    for raw in output.splitlines():
        line = raw.strip()
        if not line or line.startswith(noise) or line.endswith("/"):
            continue
        paths.append(line.removeprefix("deleting "))
    return paths


@dev.command("release-zip")
def release_zip() -> None:
    """Build the frontend and zip the integration, as HACS installs it.

    The zip holds the integration folder's contents at its root: HACS
    unpacks it into custom_components/hybrid_zone_thermostat/.
    """
    _run_or_exit(["npm", "run", "build"])
    skip = {"__pycache__", ".DS_Store"}
    with zipfile.ZipFile(RELEASE_ZIP, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(INTEGRATION.rglob("*")):
            if path.is_file() and not skip & set(path.parts):
                archive.write(path, path.relative_to(INTEGRATION))
    click.echo(f"Wrote {RELEASE_ZIP.relative_to(ROOT)}")
