"""Stored configs the integration tests start from."""

from typing import Any

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
