"""Hybrid Zone Thermostat: one target per room, many units, shared plant."""

import hashlib
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import Platform
from homeassistant.core import HomeAssistant
from homeassistant.helpers import config_validation as cv
from homeassistant.helpers.typing import ConfigType

from . import websocket_api
from .const import (
    DOMAIN,
    FRONTEND_URL,
    PANEL_ELEMENT,
    PANEL_ICON,
    PANEL_TITLE,
    PANEL_URL_PATH,
)
from .control import PIController
from .engine import Engine
from .storage import ConfigStore

CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)
PLATFORMS = [Platform.CLIMATE, Platform.SENSOR]

# Built by Vite (`npm run build`) into the integration, so a release zip
# carries it. Not in git.
FRONTEND_DIR = Path(__file__).parent / "frontend"

type HztConfigEntry = ConfigEntry[Engine]


def _frontend_version() -> str:
    """A hash of the built frontend, for its URLs.

    The files are served at fixed paths, so without this a browser keeps
    running an old card after an update. Read at setup: a new frontend
    takes effect with the restart that installs it.
    """
    digest = hashlib.sha256()
    for path in sorted(FRONTEND_DIR.glob("*.js")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


async def async_setup(hass: HomeAssistant, config: ConfigType) -> bool:
    """Once per HA start: things that can't be undone on unload."""
    await hass.http.async_register_static_paths(
        [StaticPathConfig(FRONTEND_URL, str(FRONTEND_DIR), cache_headers=False)]
    )
    websocket_api.async_register(hass)
    return True


async def async_setup_entry(hass: HomeAssistant, entry: HztConfigEntry) -> bool:
    store = ConfigStore(hass)
    await store.async_load()
    engine = Engine(hass, store, PIController())
    await engine.async_start()
    entry.runtime_data = engine

    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    version = await hass.async_add_executor_job(_frontend_version)
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL_PATH,
        webcomponent_name=PANEL_ELEMENT,
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{FRONTEND_URL}/panel.js?v={version}",
        require_admin=True,
    )
    card_url = f"{FRONTEND_URL}/card.js?v={version}"
    frontend.add_extra_js_url(hass, card_url)
    hass.data[f"{DOMAIN}_card_url"] = card_url
    return True


async def async_unload_entry(
    hass: HomeAssistant, entry: HztConfigEntry
) -> bool:
    if not await hass.config_entries.async_unload_platforms(entry, PLATFORMS):
        return False
    await entry.runtime_data.async_stop()
    frontend.async_remove_panel(hass, PANEL_URL_PATH)
    if card_url := hass.data.pop(f"{DOMAIN}_card_url", None):
        frontend.remove_extra_js_url(hass, card_url)
    return True
