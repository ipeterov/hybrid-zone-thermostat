from datetime import timedelta
from typing import Any

from homeassistant.const import ATTR_ENTITY_ID
from homeassistant.core import HomeAssistant, ServiceCall

import pytest
from freezegun.api import FrozenDateTimeFactory
from houses import HEATER_ROOM
from pytest_homeassistant_custom_component.common import (
    MockConfigEntry,
    async_fire_time_changed,
)

CLIMATE = "climate.living_room"
HEATER = "switch.living_room_heater"


@pytest.fixture
def house_config() -> dict[str, Any]:
    return HEATER_ROOM


@pytest.fixture
def switch_calls(hass: HomeAssistant) -> list[ServiceCall]:
    """switch.turn_on / turn_off, recorded and applied to the state."""
    recorded: list[ServiceCall] = []

    async def handle(call: ServiceCall) -> None:
        recorded.append(call)
        hass.states.async_set(
            call.data[ATTR_ENTITY_ID],
            "on" if call.service == "turn_on" else "off",
        )

    for service in ("turn_on", "turn_off"):
        hass.services.async_register("switch", service, handle)
    return recorded


async def settle(hass: HomeAssistant) -> None:
    await hass.async_block_till_done(wait_background_tasks=True)


async def tick(
    hass: HomeAssistant, freezer: FrozenDateTimeFactory, minutes: float
):
    freezer.tick(timedelta(minutes=minutes))
    async_fire_time_changed(hass)
    await settle(hass)


async def test_a_heater_cycles_in_proportion_to_demand(
    hass: HomeAssistant,
    switch_calls,
    entry: MockConfigEntry,
    freezer: FrozenDateTimeFactory,
):
    assert hass.states.get(HEATER).state == "on"
    unit = hass.states.get(CLIMATE).attributes["units"][0]
    # 0.6 °C below: demand 30 %, so 3 of every 10 minutes.
    assert unit["duty"] == "on 3 of every 10 min"

    await tick(hass, freezer, 3)
    assert hass.states.get(HEATER).state == "off"

    await tick(hass, freezer, 7)
    assert hass.states.get(HEATER).state == "on"


@pytest.mark.parametrize(
    "house_config",
    [
        {
            **HEATER_ROOM,
            "zones": [{**HEATER_ROOM["zones"][0], "shadow": True}],
        }
    ],
)
async def test_a_shadow_heater_is_left_alone_but_shows_its_duty(
    hass: HomeAssistant, switch_calls, entry: MockConfigEntry
):
    assert switch_calls == []
    unit = hass.states.get(CLIMATE).attributes["units"][0]
    assert unit["duty"] == "on 3 of every 10 min"
    assert unit["kind"] == "switch"


async def test_switching_the_heater_by_hand_hands_the_zone_over(
    hass: HomeAssistant,
    switch_calls,
    entry: MockConfigEntry,
    freezer: FrozenDateTimeFactory,
):
    assert hass.states.get(HEATER).state == "on"
    freezer.tick(timedelta(seconds=31))

    hass.states.async_set(HEATER, "off")  # someone pulls it off
    await settle(hass)

    attributes = hass.states.get(CLIMATE).attributes
    assert attributes["zone_state"] == "manual"
    assert "Heater was set to off by hand" in attributes["reason"]


@pytest.mark.parametrize(
    "house_config",
    [
        {
            **HEATER_ROOM,
            "room_units": [
                {**HEATER_ROOM["room_units"][0], "entity_id": "light.lava_lamp"}
            ],
        }
    ],
)
async def test_a_plug_exposed_as_a_light_is_switched_too(
    hass: HomeAssistant, entry: MockConfigEntry, freezer: FrozenDateTimeFactory
):
    calls: list[ServiceCall] = []

    async def handle(call: ServiceCall) -> None:
        calls.append(call)
        hass.states.async_set(
            "light.lava_lamp", "on" if call.service == "turn_on" else "off"
        )

    for service in ("turn_on", "turn_off"):
        hass.services.async_register("light", service, handle)
    hass.states.async_set("light.lava_lamp", "off")
    await settle(hass)
    await tick(hass, freezer, 0.5)

    assert [call.service for call in calls] == ["turn_on"]
    assert hass.states.get(CLIMATE).attributes["units"][0]["kind"] == "switch"
