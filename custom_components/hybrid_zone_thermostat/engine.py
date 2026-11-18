"""Runs the controller: builds a snapshot of the house from HA's states,
asks the controller for a decision, and tells the entities.

Shadow mode: there are no device drivers yet, so decisions are computed and
shown but nothing is sent to any device. Every zone is in shadow mode until
drivers exist; the entities say so rather than claim to be heating.
"""

from datetime import datetime, timedelta
from typing import Any

from homeassistant.const import STATE_UNAVAILABLE, STATE_UNKNOWN
from homeassistant.core import (
    CALLBACK_TYPE,
    Event,
    EventStateChangedData,
    HomeAssistant,
    callback,
)
from homeassistant.helpers.dispatcher import async_dispatcher_send
from homeassistant.helpers.event import (
    async_track_state_change_event,
    async_track_time_interval,
)
from homeassistant.helpers.storage import Store
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .control import (
    Controller,
    HouseDecision,
    HouseSnapshot,
    UnitSnapshot,
    ZoneSnapshot,
)
from .storage import ConfigStore, ZoneConfig

SHADOW = True
SIGNAL_UPDATE = f"{DOMAIN}_update"
UPDATE_INTERVAL = timedelta(seconds=30)
CONTROLLER_STORAGE_KEY = f"{DOMAIN}.controller"
CONTROLLER_STORAGE_VERSION = 1
# How long controller state may sit unsaved: a restart loses at most this
# much of a PI integral's history.
CONTROLLER_SAVE_DELAY = 60


class Engine:
    """One per config entry, which means one per house."""

    def __init__(
        self, hass: HomeAssistant, store: ConfigStore, controller: Controller
    ) -> None:
        self.hass = hass
        self.store = store
        self.controller = controller
        self.snapshot: HouseSnapshot | None = None
        self.decision: HouseDecision | None = None
        self._state_store: Store[dict[str, Any]] = Store(
            hass, CONTROLLER_STORAGE_VERSION, CONTROLLER_STORAGE_KEY
        )
        self._unsubscribe: list[CALLBACK_TYPE] = []

    async def async_start(self) -> None:
        saved = await self._state_store.async_load()
        if saved:
            self.controller.load_state(saved)
        watched = self._watched_entities()
        if watched:
            self._unsubscribe.append(
                async_track_state_change_event(
                    self.hass, watched, self._on_state_change
                )
            )
        self._unsubscribe.append(
            async_track_time_interval(self.hass, self._on_tick, UPDATE_INTERVAL)
        )
        self.async_update()

    async def async_stop(self) -> None:
        for unsubscribe in self._unsubscribe:
            unsubscribe()
        self._unsubscribe.clear()
        await self._state_store.async_save(self.controller.dump_state())

    async def async_update_zone(self, zone_id: str, **changes: Any) -> None:
        """Change a zone's target or on/off, save, and decide again."""
        zone = self.store.zone(zone_id)
        zone.update(changes)  # type: ignore[typeddict-item]
        await self.store.async_save(self.store.config)
        self.async_update()

    @callback
    def async_update(self) -> None:
        self.snapshot = self._build_snapshot(dt_util.utcnow())
        self.decision = self.controller.decide(self.snapshot)
        self._state_store.async_delay_save(
            self.controller.dump_state, CONTROLLER_SAVE_DELAY
        )
        async_dispatcher_send(self.hass, SIGNAL_UPDATE)

    @callback
    def _on_state_change(self, event: Event[EventStateChangedData]) -> None:
        self.async_update()

    @callback
    def _on_tick(self, now: datetime) -> None:
        self.async_update()

    def _watched_entities(self) -> list[str]:
        config = self.store.config
        entities = [
            zone["room_sensor"]
            for zone in config["zones"]
            if zone["room_sensor"]
        ]
        entities += [unit["entity_id"] for unit in config["room_units"]]
        if config["house"]["outdoor_sensor"]:
            entities.append(config["house"]["outdoor_sensor"])
        return sorted(set(entities))

    def _build_snapshot(self, now: datetime) -> HouseSnapshot:
        config = self.store.config
        return HouseSnapshot(
            now=now,
            outdoor_temperature=self._read_temperature(
                config["house"]["outdoor_sensor"]
            ),
            zones={
                zone["id"]: self._zone_snapshot(zone)
                for zone in config["zones"]
            },
        )

    def _zone_snapshot(self, zone: ZoneConfig) -> ZoneSnapshot:
        units: dict[str, UnitSnapshot] = {}
        for unit in self.store.config["room_units"]:
            if unit["zone_id"] != zone["id"]:
                continue
            available = self._is_available(unit["entity_id"])
            units[unit["id"]] = UnitSnapshot(
                unit_id=unit["id"],
                can_heat=unit["can_heat"] and available,
                can_cool=unit["can_cool"] and available,
                name=unit["name"],
            )
        return ZoneSnapshot(
            zone_id=zone["id"],
            enabled=zone["enabled"],
            room_temperature=self._read_temperature(zone["room_sensor"]),
            target=zone["target"],
            idle_band=zone["idle_band"],
            heating_order=tuple(zone["heating_order"]),
            cooling_order=tuple(zone["cooling_order"]),
            units=units,
        )

    def _read_temperature(self, entity_id: str | None) -> float | None:
        if entity_id is None:
            return None
        state = self.hass.states.get(entity_id)
        if state is None or state.state in (STATE_UNAVAILABLE, STATE_UNKNOWN):
            return None
        try:
            return float(state.state)
        except ValueError:
            return None

    def _is_available(self, entity_id: str) -> bool:
        state = self.hass.states.get(entity_id)
        return state is not None and state.state != STATE_UNAVAILABLE
