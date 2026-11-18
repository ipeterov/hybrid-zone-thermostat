from typing import Any

from homeassistant.components.climate import (
    ATTR_HVAC_ACTION,
    SERVICE_SET_HVAC_MODE,
    SERVICE_SET_TEMPERATURE,
    HVACMode,
)
from homeassistant.components.climate import (
    DOMAIN as CLIMATE_DOMAIN,
)
from homeassistant.const import ATTR_ENTITY_ID, ATTR_TEMPERATURE
from homeassistant.core import HomeAssistant

import pytest
from pytest_homeassistant_custom_component.common import MockConfigEntry

from custom_components.hybrid_zone_thermostat.const import DOMAIN, STORAGE_KEY

CLIMATE = "climate.living_room"
DECISION = "sensor.living_room_decision"
REASON = "sensor.living_room_reason"


async def test_a_cold_room_would_heat_with_the_first_unit(
    hass: HomeAssistant, entry: MockConfigEntry
):
    state = hass.states.get(CLIMATE)

    assert state is not None
    assert state.state == HVACMode.HEAT_COOL
    assert state.attributes["current_temperature"] == 21.4
    assert state.attributes[ATTR_TEMPERATURE] == 22.0
    assert state.attributes["zone_state"] == "heating"
    assert state.attributes["demands"]["ac"]["mode"] == "heat"
    assert state.attributes["demands"]["radiator"]["mode"] is None
    assert hass.states.get(DECISION).state == "heating"


async def test_shadow_mode_claims_no_action_and_says_why(
    hass: HomeAssistant, entry: MockConfigEntry
):
    state = hass.states.get(CLIMATE)

    assert state.attributes.get(ATTR_HVAC_ACTION) is None
    assert state.attributes["shadow"] is True
    reason = hass.states.get(REASON).state
    assert reason.startswith("Shadow mode, nothing sent.")
    assert "#1 Hisense AC" in reason


async def test_a_sensor_change_decides_again(
    hass: HomeAssistant, entry: MockConfigEntry
):
    hass.states.async_set("sensor.living_room_temperature", "22.8")
    await hass.async_block_till_done()

    assert hass.states.get(DECISION).state == "idle"


async def test_an_unavailable_sensor_is_a_fault(
    hass: HomeAssistant, entry: MockConfigEntry
):
    hass.states.async_set("sensor.living_room_temperature", "unavailable")
    await hass.async_block_till_done()

    assert hass.states.get(DECISION).state == "fault"


async def test_an_unavailable_unit_is_skipped(
    hass: HomeAssistant, entry: MockConfigEntry
):
    hass.states.async_set("climate.living_room_ac", "unavailable")
    await hass.async_block_till_done()

    demands = hass.states.get(CLIMATE).attributes["demands"]
    assert demands["ac"]["mode"] is None
    assert demands["radiator"]["mode"] == "heat"


async def test_setting_the_target_is_kept(
    hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any]
):
    await hass.services.async_call(
        CLIMATE_DOMAIN,
        SERVICE_SET_TEMPERATURE,
        {ATTR_ENTITY_ID: CLIMATE, ATTR_TEMPERATURE: 21.0},
        blocking=True,
    )

    assert hass.states.get(CLIMATE).attributes[ATTR_TEMPERATURE] == 21.0
    assert hass.states.get(DECISION).state == "idle"
    stored = hass_storage[STORAGE_KEY]["data"]["zones"][0]
    assert stored["target"] == 21.0


async def test_turning_the_zone_off(
    hass: HomeAssistant, entry: MockConfigEntry
):
    await hass.services.async_call(
        CLIMATE_DOMAIN,
        SERVICE_SET_HVAC_MODE,
        {ATTR_ENTITY_ID: CLIMATE, "hvac_mode": HVACMode.OFF},
        blocking=True,
    )

    state = hass.states.get(CLIMATE)
    assert state.state == HVACMode.OFF
    assert state.attributes[ATTR_HVAC_ACTION] == "off"
    assert hass.states.get(DECISION).state == "off"


async def test_controller_state_survives_a_reload(
    hass: HomeAssistant, entry: MockConfigEntry, hass_storage: dict[str, Any]
):
    assert await hass.config_entries.async_unload(entry.entry_id)

    saved = hass_storage[f"{DOMAIN}.controller"]["data"]
    assert "living_room" in saved["controller"]
    assert "ac" in saved["protection"]


async def test_the_panel_reads_the_config(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client
):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id({"type": f"{DOMAIN}/config"})
    response = await client.receive_json()

    assert response["success"]
    assert response["result"]["zones"][0]["name"] == "Living room"


async def test_saving_a_new_zone_creates_its_entities(
    hass: HomeAssistant, entry: MockConfigEntry, hass_ws_client, house_config
):
    config = {
        **house_config,
        "zones": [
            *house_config["zones"],
            {"id": "bedroom", "name": "Bedroom", "room_sensor": None},
        ],
    }
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/config/save", "config": config}
    )
    response = await client.receive_json()
    await hass.async_block_till_done()

    assert response["success"]
    bedroom = response["result"]["zones"][1]
    assert bedroom["target"] == 21.0  # defaults filled in
    assert hass.states.get("climate.bedroom") is not None
    assert hass.states.get("sensor.bedroom_decision").state == "fault"


@pytest.mark.parametrize(
    ("change", "message"),
    [
        (
            {
                "room_units": [
                    {
                        "id": "x",
                        "name": "X",
                        "entity_id": "climate.x",
                        "zone_id": "nowhere",
                    }
                ]
            },
            "unknown zone",
        ),
        (
            {
                "zones": [{"id": "z", "name": "Z", "heating_order": ["ghost"]}],
                "room_units": [],
            },
            "another zone's unit",
        ),
    ],
)
async def test_an_inconsistent_config_is_refused(
    hass: HomeAssistant,
    entry: MockConfigEntry,
    hass_ws_client,
    house_config,
    change,
    message,
):
    client = await hass_ws_client(hass)
    await client.send_json_auto_id(
        {"type": f"{DOMAIN}/config/save", "config": {**house_config, **change}}
    )
    response = await client.receive_json()

    assert not response["success"]
    assert response["error"]["code"] == "invalid_config"
    assert message in response["error"]["message"]


async def test_the_target_can_change_while_the_zone_is_off(
    hass: HomeAssistant, entry: MockConfigEntry
):
    await hass.services.async_call(
        CLIMATE_DOMAIN,
        SERVICE_SET_HVAC_MODE,
        {ATTR_ENTITY_ID: CLIMATE, "hvac_mode": HVACMode.OFF},
        blocking=True,
    )
    await hass.services.async_call(
        CLIMATE_DOMAIN,
        SERVICE_SET_TEMPERATURE,
        {ATTR_ENTITY_ID: CLIMATE, ATTR_TEMPERATURE: 19.5},
        blocking=True,
    )

    state = hass.states.get(CLIMATE)
    assert state.state == HVACMode.OFF
    assert state.attributes[ATTR_TEMPERATURE] == 19.5
