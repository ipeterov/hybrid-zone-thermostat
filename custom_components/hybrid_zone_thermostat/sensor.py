"""Per zone: what the controller decided, and why."""

from homeassistant.components.sensor import SensorDeviceClass, SensorEntity
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddConfigEntryEntitiesCallback

from . import HztConfigEntry
from .control import ZoneState
from .engine import Engine
from .entity import ZoneEntity


async def async_setup_entry(
    hass: HomeAssistant,
    entry: HztConfigEntry,
    async_add_entities: AddConfigEntryEntitiesCallback,
) -> None:
    engine = entry.runtime_data
    entities: list[SensorEntity] = []
    for zone in engine.store.config["zones"]:
        entities.append(ZoneDecisionSensor(engine, entry.entry_id, zone["id"]))
        entities.append(ZoneReasonSensor(engine, entry.entry_id, zone["id"]))
    async_add_entities(entities)


class ZoneDecisionSensor(ZoneEntity, SensorEntity):
    """The controller's decision for the zone: heating, idle, cooling...

    In shadow mode this is what HZT would do, not what's running.
    """

    _attr_translation_key = "decision"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = [state.value for state in ZoneState]  # noqa: RUF012

    def __init__(self, engine: Engine, entry_id: str, zone_id: str) -> None:
        super().__init__(engine, entry_id, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_decision"

    @property
    def native_value(self) -> str | None:
        decision = self.zone_decision
        return decision.state.value if decision else None


class ZoneReasonSensor(ZoneEntity, SensorEntity):
    """Why, in one line."""

    _attr_translation_key = "reason"

    def __init__(self, engine: Engine, entry_id: str, zone_id: str) -> None:
        super().__init__(engine, entry_id, zone_id)
        self._attr_unique_id = f"{entry_id}_{zone_id}_reason"

    @property
    def native_value(self) -> str | None:
        decision = self.zone_decision
        if decision is None:
            return None
        reason = decision.reason
        shadow = self.engine.store.zone(self.zone_id)["shadow"]
        if shadow and decision.demands:
            reason = f"Shadow mode, nothing sent. {reason}"
        # A state is at most 255 characters.
        return reason[:255]
