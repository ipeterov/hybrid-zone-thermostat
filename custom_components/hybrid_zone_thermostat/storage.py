"""The house's configuration: zones, room units, central units.

Kept in Home Assistant's Store (``.storage/hybrid_zone_thermostat``) and
edited from the Climate zones panel through the websocket API, not through
config entry options: the panel is the only settings UI.
"""

from typing import Any, TypedDict, cast

from homeassistant.core import HomeAssistant
from homeassistant.helpers.storage import Store

import probatio

from .const import STORAGE_KEY, STORAGE_VERSION


class HouseSettings(TypedDict):
    outdoor_sensor: str | None


class ZoneConfig(TypedDict):
    id: str
    name: str
    room_sensor: str | None
    target: float
    # Heating holds `target`; cooling starts this far above it.
    idle_band: float
    enabled: bool
    # Decide but send nothing to the units. On until the owner says.
    shadow: bool
    # Room unit ids, first choice first.
    heating_order: list[str]
    cooling_order: list[str]


class RoomUnitConfig(TypedDict):
    id: str
    name: str
    entity_id: str
    zone_id: str
    can_heat: bool
    can_cool: bool
    # Outdoor lockouts, °C: below these the unit may not heat / cool.
    # None: no lockout.
    heat_lockout_below: float | None
    cool_lockout_below: float | None
    # Equipment protection, minutes.
    min_run: float
    min_rest: float
    # Switches only: the length of one on/off cycle, minutes.
    cycle_minutes: float


class HouseConfig(TypedDict):
    house: HouseSettings
    zones: list[ZoneConfig]
    room_units: list[RoomUnitConfig]
    central_units: list[dict[str, Any]]


def empty_config() -> HouseConfig:
    return {
        "house": {"outdoor_sensor": None},
        "zones": [],
        "room_units": [],
        "central_units": [],
    }


_ENTITY_ID = probatio.Match(r"^[a-z_]+\.[a-z0-9_]+$")
_OPTIONAL_ENTITY_ID = probatio.Any(None, _ENTITY_ID)
_OPTIONAL_TEMPERATURE = probatio.Any(
    None,
    probatio.All(probatio.Coerce(float), probatio.Range(min=-40, max=50)),
)
_MINUTES = probatio.All(probatio.Coerce(float), probatio.Range(min=0, max=60))

_SCHEMA = probatio.Schema(
    {
        probatio.Required("house"): {
            probatio.Optional("outdoor_sensor", default=None): (
                _OPTIONAL_ENTITY_ID
            ),
        },
        probatio.Required("zones"): [
            {
                probatio.Required("id"): probatio.All(str, probatio.Length(1)),
                probatio.Required("name"): probatio.All(
                    str, probatio.Length(1)
                ),
                probatio.Optional("room_sensor", default=None): (
                    _OPTIONAL_ENTITY_ID
                ),
                probatio.Optional("target", default=21.0): probatio.All(
                    probatio.Coerce(float), probatio.Range(min=5, max=35)
                ),
                probatio.Optional("idle_band", default=1.5): probatio.All(
                    probatio.Coerce(float), probatio.Range(min=0.5, max=5)
                ),
                probatio.Optional("enabled", default=True): bool,
                probatio.Optional("shadow", default=True): bool,
                probatio.Optional("heating_order", default=list): [str],
                probatio.Optional("cooling_order", default=list): [str],
            }
        ],
        probatio.Required("room_units"): [
            {
                probatio.Required("id"): probatio.All(str, probatio.Length(1)),
                probatio.Required("name"): probatio.All(
                    str, probatio.Length(1)
                ),
                probatio.Required("entity_id"): _ENTITY_ID,
                probatio.Required("zone_id"): str,
                probatio.Optional("can_heat", default=True): bool,
                probatio.Optional("can_cool", default=False): bool,
                probatio.Optional("heat_lockout_below", default=None): (
                    _OPTIONAL_TEMPERATURE
                ),
                probatio.Optional("cool_lockout_below", default=None): (
                    _OPTIONAL_TEMPERATURE
                ),
                probatio.Optional("min_run", default=6.0): _MINUTES,
                probatio.Optional("min_rest", default=4.0): _MINUTES,
                probatio.Optional("cycle_minutes", default=10.0): probatio.All(
                    probatio.Coerce(float), probatio.Range(min=5, max=120)
                ),
            }
        ],
        probatio.Optional("central_units", default=list): [dict],
    }
)


class InvalidConfig(ValueError):
    """A config the panel sent that doesn't hold together."""


def validate_config(raw: Any) -> HouseConfig:
    """Check shape and references; fill defaults.

    Every room unit belongs to an existing zone, and a zone's orders list
    only its own units, each at most once.
    """
    try:
        config = cast("HouseConfig", _SCHEMA(raw))
    except probatio.Invalid as error:
        raise InvalidConfig(str(error)) from error

    zone_ids = [zone["id"] for zone in config["zones"]]
    unit_ids = [unit["id"] for unit in config["room_units"]]
    if len(set(zone_ids)) != len(zone_ids):
        msg = "Two zones have the same id."
        raise InvalidConfig(msg)
    if len(set(unit_ids)) != len(unit_ids):
        msg = "Two room units have the same id."
        raise InvalidConfig(msg)

    units_by_zone: dict[str, set[str]] = {
        zone_id: set() for zone_id in zone_ids
    }
    for unit in config["room_units"]:
        if unit["zone_id"] not in units_by_zone:
            msg = f"Room unit {unit['id']} is in an unknown zone."
            raise InvalidConfig(msg)
        units_by_zone[unit["zone_id"]].add(unit["id"])

    for zone in config["zones"]:
        for key in ("heating_order", "cooling_order"):
            order: list[str] = zone[key]
            if len(set(order)) != len(order):
                msg = f"Zone {zone['id']} lists a unit twice in {key}."
                raise InvalidConfig(msg)
            if not set(order) <= units_by_zone[zone["id"]]:
                msg = f"Zone {zone['id']}'s {key} names another zone's unit."
                raise InvalidConfig(msg)
    return config


class ConfigStore:
    """Loads once, hands out the config, saves on change."""

    def __init__(self, hass: HomeAssistant) -> None:
        self._store: Store[HouseConfig] = Store(
            hass, STORAGE_VERSION, STORAGE_KEY
        )
        self.config: HouseConfig = empty_config()

    async def async_load(self) -> None:
        """Load, filling in fields added since the config was saved."""
        stored = await self._store.async_load()
        self.config = validate_config(stored) if stored else empty_config()

    async def async_save(self, config: HouseConfig) -> None:
        self.config = config
        await self._store.async_save(config)

    def zone(self, zone_id: str) -> ZoneConfig:
        for zone in self.config["zones"]:
            if zone["id"] == zone_id:
                return zone
        raise KeyError(zone_id)
