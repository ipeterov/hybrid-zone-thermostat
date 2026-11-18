"""Stored configs the integration tests start from."""

from typing import Any

LIVING_ROOM: dict[str, Any] = {
    "house": {"outdoor_sensor": "sensor.outdoor"},
    "zones": [
        {
            "id": "living_room",
            "name": "Living room",
            "room_sensor": "sensor.living_room_temperature",
            # Heats below 22.0, cools above 23.0.
            "target": 22.5,
            "idle_band": 1.0,
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

# The living room heated by an electric heater on a smart plug, live.
HEATER_ROOM: dict[str, Any] = {
    "house": {"outdoor_sensor": "sensor.outdoor"},
    "zones": [
        {
            "id": "living_room",
            "name": "Living room",
            "room_sensor": "sensor.living_room_temperature",
            "target": 22.5,
            "idle_band": 1.0,
            "enabled": True,
            "shadow": False,
            "heating_order": ["heater"],
            "cooling_order": [],
        }
    ],
    "room_units": [
        {
            "id": "heater",
            "name": "Heater",
            "entity_id": "switch.living_room_heater",
            "zone_id": "living_room",
            "can_heat": True,
            "can_cool": False,
            "min_run": 3,
            "min_rest": 3,
            "cycle_minutes": 10,
        }
    ],
    "central_units": [],
}
