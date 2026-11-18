import copy
from typing import Any

from homeassistant.components.climate import (
    DOMAIN as CLIMATE_DOMAIN,
)
from homeassistant.components.climate import (
    SERVICE_SET_TEMPERATURE,
)
from homeassistant.const import ATTR_ENTITY_ID, ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant, ServiceCall

import pytest
from houses import LIVING_ROOM
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_mock_service,
)

CLIMATE = "climate.living_room"
AC = "climate.living_room_ac"
AC_ATTRIBUTES = {
    "hvac_modes": ["off", "heat", "cool", "fan_only", "dry"],
    "current_temperature": 29.6,
    "temperature": 23,
    "target_temp_step": 1,
    "min_temp": 16,
    "max_temp": 32,
}


def live(config: dict[str, Any], **unit_changes: Any) -> dict[str, Any]:
    config = copy.deepcopy(config)
    config["zones"][0]["shadow"] = False
    config["room_units"][0].update(unit_changes)
    return config


@pytest.fixture
def calls(hass: HomeAssistant) -> list[ServiceCall]:
    """Service calls to the climate domain, recorded instead of run.

    Request it after `entry`: setting up the climate integration registers
    the real services over these."""
    recorded = async_mock_service(hass, CLIMATE_DOMAIN, SERVICE_SET_TEMPERATURE)
    recorded += async_mock_service(hass, CLIMATE_DOMAIN, "set_hvac_mode")
    return recorded


async def give_ac_attributes(hass: HomeAssistant, state: str = "off") -> None:
    hass.states.async_set(AC, state, AC_ATTRIBUTES)
    await hass.async_block_till_done(wait_background_tasks=True)


@pytest.mark.parametrize("house_config", [live(LIVING_ROOM)])
async def test_a_live_zone_drives_the_ac_by_setpoint_offset(
    hass: HomeAssistant, entry: MockConfigEntry, calls: list[ServiceCall]
):
    await give_ac_attributes(hass)

    sent = [call for call in calls if call.service == SERVICE_SET_TEMPERATURE]
    assert sent
    assert sent[-1].data[ATTR_ENTITY_ID] == AC
    assert sent[-1].data["hvac_mode"] == "heat"
    # Its own reading (29.6) plus a push that grows with demand, rounded to
    # its 1 °C step and kept within its 32 °C maximum.
    assert sent[-1].data[ATTR_TEMPERATURE] == 32
    assert hass.states.get(CLIMATE).attributes["hvac_action"] == "heating"


async def test_a_shadow_zone_sends_nothing(
    hass: HomeAssistant, entry: MockConfigEntry, calls: list[ServiceCall]
):
    await give_ac_attributes(hass)

    assert calls == []


@pytest.mark.parametrize("house_config", [live(LIVING_ROOM)])
async def test_a_change_by_hand_hands_the_zone_over_for_a_while(
    hass: HomeAssistant, entry: MockConfigEntry, calls: list[ServiceCall]
):
    await give_ac_attributes(hass)
    calls.clear()

    hass.states.async_set(AC, "cool", {**AC_ATTRIBUTES, "temperature": 20})
    await hass.async_block_till_done(wait_background_tasks=True)

    state = hass.states.get(CLIMATE)
    assert state.attributes["zone_state"] == "manual"
    assert "set to cool 20 °C by hand" in state.attributes["reason"]
    assert calls == []

    # Using the zone's own control hands it back. (Through the engine: the
    # climate services are mocked here, the zone entity's included.)
    await entry.runtime_data.async_update_zone("living_room", target=22.5)
    await hass.async_block_till_done(wait_background_tasks=True)

    assert hass.states.get(CLIMATE).attributes["zone_state"] == "heating"


@pytest.mark.parametrize("house_config", [live(LIVING_ROOM)])
async def test_hzts_own_changes_are_not_taken_for_manual_ones(
    hass: HomeAssistant, entry: MockConfigEntry, calls: list[ServiceCall]
):
    await give_ac_attributes(hass)
    sent = [call for call in calls if call.service == SERVICE_SET_TEMPERATURE]

    # The AC reports back what HZT asked for, in a context of its own.
    hass.states.async_set(
        AC,
        sent[-1].data["hvac_mode"],
        {**AC_ATTRIBUTES, "temperature": sent[-1].data[ATTR_TEMPERATURE]},
    )
    await hass.async_block_till_done(wait_background_tasks=True)

    assert hass.states.get(CLIMATE).attributes["zone_state"] == "heating"


@pytest.mark.parametrize(
    ("house_config", "outdoor_temperature"),
    [(live(LIVING_ROOM, heat_lockout_below=-15), "-18")],
)
async def test_a_locked_out_unit_hands_over_to_the_next(
    hass: HomeAssistant, entry: MockConfigEntry, calls: list[ServiceCall]
):
    attributes = hass.states.get(CLIMATE).attributes
    assert attributes["units"]["ac"]["heat_locked"] is True
    assert attributes["demands"]["ac"]["mode"] is None
    assert attributes["demands"]["radiator"]["mode"] == "heat"
    assert "#1 Radiator" in attributes["reason"]
