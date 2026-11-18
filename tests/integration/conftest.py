from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.hybrid_zone_thermostat.const import DOMAIN, STORAGE_KEY

LIVING_ROOM: dict[str, Any] = {
    "house": {"outdoor_sensor": "sensor.outdoor"},
    "zones": [
        {
            "id": "living_room",
            "name": "Living room",
            "room_sensor": "sensor.living_room_temperature",
            "target": 22.0,
            "idle_band": 1.5,
            "enabled": True,
            "heating_order": ["ac", "radiator"],
            "cooling_order": ["ac"],
        }
    ],
    "room_units": [
        {
            "id": "ac",
            "name": "Hisense AC",
            "entity_id": "climate.living_room_ac",
            "zone_id": "living_room",
            "can_heat": True,
            "can_cool": True,
        },
        {
            "id": "radiator",
            "name": "Radiator",
            "entity_id": "climate.living_room_trv",
            "zone_id": "living_room",
            "can_heat": True,
            "can_cool": False,
        },
    ],
    "central_units": [],
}


@pytest.fixture
def house_config() -> dict[str, Any]:
    """The stored config the entry starts with. Override per test."""
    return LIVING_ROOM


@pytest.fixture
async def entry(
    hass: HomeAssistant, hass_storage: dict[str, Any], house_config
) -> MockConfigEntry:
    """A loaded entry over `house_config`, with its devices present."""
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": STORAGE_KEY,
        "data": house_config,
    }
    hass.states.async_set("sensor.outdoor", "7.2")
    hass.states.async_set("sensor.living_room_temperature", "21.4")
    hass.states.async_set("climate.living_room_ac", "off")
    hass.states.async_set("climate.living_room_trv", "heat")

    await async_setup_component(hass, "http", {})
    config_entry = MockConfigEntry(domain=DOMAIN)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done()
    return config_entry
