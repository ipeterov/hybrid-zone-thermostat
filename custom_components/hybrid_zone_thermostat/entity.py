"""What every zone entity shares: its device, and listening to the engine."""

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.dispatcher import async_dispatcher_connect
from homeassistant.helpers.entity import Entity

from .const import DOMAIN, NAME
from .control import ZoneDecision, ZoneSnapshot
from .engine import SIGNAL_UPDATE, Engine


class ZoneEntity(Entity):
    """An entity of one zone. Each zone is a device named after it."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, engine: Engine, entry_id: str, zone_id: str) -> None:
        self.engine = engine
        self.zone_id = zone_id
        zone = engine.store.zone(zone_id)
        self._attr_device_info = DeviceInfo(
            identifiers={(DOMAIN, f"{entry_id}_{zone_id}")},
            name=zone["name"],
            manufacturer=NAME,
            model="Zone",
        )

    async def async_added_to_hass(self) -> None:
        self.async_on_remove(
            async_dispatcher_connect(
                self.hass, SIGNAL_UPDATE, self.async_write_ha_state
            )
        )

    @property
    def zone_decision(self) -> ZoneDecision | None:
        decision = self.engine.decision
        return decision.zones.get(self.zone_id) if decision else None

    @property
    def zone_snapshot(self) -> ZoneSnapshot | None:
        snapshot = self.engine.snapshot
        return snapshot.zones.get(self.zone_id) if snapshot else None
