"""The house's configuration: zones, room units, central units.

Kept in Home Assistant's Store (``.storage/hybrid_zone_thermostat``) and
edited from the Climate zones panel through the websocket API, not through
config entry options: the panel is the only settings UI.
"""

from typing import Any, TypedDict

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

from .const import STORAGE_KEY, STORAGE_VERSION


class HouseConfig(TypedDict):
    """The stored shape. Empty until the panel adds something."""

    zones: list[dict[str, Any]]
    room_units: list[dict[str, Any]]
    central_units: list[dict[str, Any]]


def empty_config() -> HouseConfig:
    return {"zones": [], "room_units": [], "central_units": []}


class ConfigStore:
    """Loads once, hands out the config, saves on change."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[HouseConfig] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY
        )
        self.config: HouseConfig = empty_config()

    async def async_load(self) -> None:
        self.config = await self._store.async_load() or empty_config()

    async def async_save(self, config: HouseConfig) -> None:
        self.config = config
        await self._store.async_save(config)
