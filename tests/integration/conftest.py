from typing import Any

from homeassistant.core import HomeAssistant
from homeassistant.setup import async_setup_component

import pytest
from houses import LIVING_ROOM
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.hybrid_zone_thermostat.const import DOMAIN, STORAGE_KEY


@pytest.fixture
def house_config() -> dict[str, Any]:
    """The stored config the entry starts with. Override per test."""
    return LIVING_ROOM


@pytest.fixture
def outdoor_temperature() -> str:
    """The outdoor sensor's state when the entry starts. Override per test."""
    return "7.2"


@pytest.fixture
async def entry(
    hass: HomeAssistant,
    hass_storage: dict[str, Any],
    house_config,
    outdoor_temperature,
) -> MockConfigEntry:
    """A loaded entry over `house_config`, with its devices present."""
    hass_storage[STORAGE_KEY] = {
        "version": 1,
        "minor_version": 1,
        "key": STORAGE_KEY,
        "data": house_config,
    }
    hass.states.async_set("sensor.outdoor", outdoor_temperature)
    hass.states.async_set("sensor.living_room_temperature", "21.4")
    hass.states.async_set("climate.living_room_ac", "off")
    hass.states.async_set("climate.living_room_trv", "heat")
    hass.states.async_set("switch.living_room_heater", "off")

    await async_setup_component(hass, "http", {})
    config_entry = MockConfigEntry(domain=DOMAIN)
    config_entry.add_to_hass(hass)
    assert await hass.config_entries.async_setup(config_entry.entry_id)
    await hass.async_block_till_done(wait_background_tasks=True)
    return config_entry
